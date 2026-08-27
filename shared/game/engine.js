import {
  CHOICES, CHOICE_KEYS, TRUST_NORM_SIZE,
  AUDIT_CATCH_RATE, AUDIT_PENALTY, PLEDGE_BONUS,
  ROUND_SECONDS_MIN, ROUND_SECONDS_MAX,
} from '../config.js';
import { getStage } from './stages.js';

/**
 * 라운드 엔진.
 *
 * ── 익명성 설계 ──────────────────────────────────────────────
 * 개인의 선택(token → choice)은 라운드가 열려 있는 동안에만
 * session.secretChoices 에 메모리로 존재한다.
 * 마감하는 순간 마을별 카운트로 접어 넣고 **원본 맵을 지운다**.
 * 디스크 스냅샷(roundResults)에 남는 것은 마을별 a/b/c 개수뿐이며,
 * 진행자에게 나가는 어떤 값에도 개인의 선택은 들어가지 않는다.
 * 본인에게만 보여 줄 결과(personalOutcomes)도 메모리에만 두고
 * 다음 라운드가 열리면 함께 지운다.
 * ────────────────────────────────────────────────────────────
 */

export class RoundError extends Error {}
const fail = (msg) => { throw new RoundError(msg); };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 지금 이 단계의 라운드가 어느 국면인가 — ready(설명 중) / running(타이머) / closed(집계 끝) */
export function roundPhase(session, stageId = session.stageId) {
  if (session.round?.stageId === stageId) return session.round.phase;
  if (session.roundResults[stageId]) return 'closed';
  return 'ready';
}

/** 3·4라운드에서만, 그리고 그 마을이 채택한 제도만 효력이 있다. */
export function institutionActive(session, villageIndex, stage) {
  if (!stage?.scoring || !(stage.round >= 3)) return null;
  return session.villages[villageIndex]?.institution || null;
}

// ------------------------------------------------------------------ 시작

export function startRound(session, stageId = session.stageId) {
  const stage = getStage(stageId);
  if (stage.kind !== 'round') fail('라운드 단계가 아닙니다.');
  if (session.roundResults[stageId]) fail('이미 끝난 라운드입니다.');
  if (session.round?.stageId === stageId && session.round.phase === 'running') {
    return session.round; // 두 번 눌러도 한 번만
  }

  // 지난 라운드의 흔적을 모두 지운다 (개인 선택·개인 결과 모두 메모리에서 제거)
  session.secretChoices.clear();
  session.personalOutcomes.clear();

  const seconds = clamp(session.settings.roundSeconds, ROUND_SECONDS_MIN, ROUND_SECONDS_MAX);
  const now = Date.now();
  session.round = {
    stageId,
    scenarioId: stage.scenario,
    round: stage.round,
    scoring: Boolean(stage.scoring),
    phase: 'running',
    seconds,
    startedAt: now,
    endsAt: now + seconds * 1000,
    extendedSeconds: 0,
  };
  session.secretChoices.set(stageId, new Map());
  session.touch();
  return session.round;
}

/** 진행자가 라운드 화면만 띄우고 아직 시작하지 않은 상태로 되돌린다. */
export function armRound(session, stageId = session.stageId) {
  const stage = getStage(stageId);
  if (stage.kind !== 'round') return null;
  if (session.roundResults[stageId]) {
    session.round = { stageId, scenarioId: stage.scenario, round: stage.round, scoring: Boolean(stage.scoring), phase: 'closed' };
    return session.round;
  }
  session.round = {
    stageId,
    scenarioId: stage.scenario,
    round: stage.round,
    scoring: Boolean(stage.scoring),
    phase: 'ready',
    seconds: session.settings.roundSeconds,
    startedAt: null,
    endsAt: null,
    extendedSeconds: 0,
  };
  return session.round;
}

// ------------------------------------------------------------------ 제출

export function submitChoice(session, token, choice) {
  const r = session.round;
  if (!r || r.phase !== 'running') fail('지금은 제출할 수 없어요.');
  if (!CHOICE_KEYS.includes(choice)) fail('그런 선택지는 없어요.');
  const player = session.getPlayer(token);
  if (!player) fail('참가자를 찾을 수 없습니다.');

  const map = session.secretChoices.get(r.stageId);
  if (!map) fail('라운드가 열려 있지 않습니다.');
  if (map.has(token)) fail('이미 제출했어요. 선택은 바꿀 수 없어요.');

  map.set(token, choice);
  session.touch();
  return { submitted: map.size, total: session.playerCount };
}

export function hasSubmitted(session, token) {
  const r = session.round;
  if (!r) return false;
  return Boolean(session.secretChoices.get(r.stageId)?.has(token));
}

/** 본인 화면에만 되돌려 주는 값 — 다른 소켓으로는 절대 나가지 않는다. */
export function myChoice(session, token) {
  const r = session.round;
  if (!r) return null;
  return session.secretChoices.get(r.stageId)?.get(token) ?? null;
}

export function submittedCount(session) {
  const r = session.round;
  if (!r) return 0;
  return session.secretChoices.get(r.stageId)?.size || 0;
}

// ------------------------------------------------------------------ 시간

export function extendRound(session, seconds = 30) {
  const r = session.round;
  if (!r || r.phase !== 'running') fail('진행 중인 라운드가 없습니다.');
  const add = clamp(Number(seconds) || 30, 5, 300);
  r.endsAt += add * 1000;
  r.extendedSeconds += add;
  session.touch();
  return r;
}

export function remainingMs(session) {
  const r = session.round;
  if (!r || r.phase !== 'running' || !r.endsAt) return 0;
  return Math.max(0, r.endsAt - Date.now());
}

// ------------------------------------------------------------------ 마감 · 집계

/**
 * 라운드를 닫고 집계한다. 두 번 불려도 한 번만 처리한다.
 * @param {() => number} rng 감사 적발 판정용 (테스트에서 고정 가능)
 * @returns {object|null} 마을별 카운트만 담긴 집계 결과
 */
export function closeRound(session, rng = Math.random) {
  const r = session.round;
  if (!r || r.phase !== 'running') return session.roundResults[r?.stageId] || null;

  const stage = getStage(r.stageId);
  const choices = session.secretChoices.get(r.stageId) || new Map();
  const scoring = Boolean(stage.scoring);

  const outcomes = new Map();          // 본인에게만 보여 줄 결과 (메모리 전용)
  const villageRows = [];

  for (const village of session.villages) {
    const members = session.villageMembers(village.index);
    const counts = { a: 0, b: 0, c: 0 };
    let submitted = 0;
    let coinsGained = 0;
    let caughtCount = 0;
    let bonusCount = 0;

    const institution = institutionActive(session, village.index, stage);

    for (const player of members) {
      const choice = choices.get(player.token);
      if (!choice) continue;                 // 미제출 = 무행동. 분모에는 남지만 델타는 0.
      counts[choice]++;
      submitted++;

      let coinDelta = 0;
      let caught = false;
      let bonus = 0;

      if (scoring) {
        coinDelta = CHOICES[choice].coin;

        if (institution === 'audit' && choice === 'a' && rng() < AUDIT_CATCH_RATE) {
          caught = true;
          caughtCount++;
          coinDelta += AUDIT_PENALTY;
        }
        if (institution === 'pledge' && player.roundPledges[r.stageId] && (choice === 'b' || choice === 'c')) {
          bonus = PLEDGE_BONUS;
          bonusCount++;
          coinDelta += PLEDGE_BONUS;
        }

        player.coins += coinDelta;
        coinsGained += coinDelta;
      }

      outcomes.set(player.token, {
        stageId: r.stageId,
        choice,
        coinDelta,
        caught,
        bonus,
        scoring,
      });
    }

    // 마을 크기가 달라도 공정하도록 기준 마을 크기(4명)로 정규화
    const size = members.length;
    const raw = counts.a * CHOICES.a.trust + counts.b * CHOICES.b.trust + counts.c * CHOICES.c.trust;
    const trustDelta = (scoring && size > 0) ? Math.round((raw / size) * TRUST_NORM_SIZE) : 0;

    const trustBefore = village.trust;
    const applied = scoring ? session.adjustTrust(village.index, trustDelta) : 0;

    villageRows.push({
      index: village.index,
      name: village.name,
      emoji: village.emoji,
      color: village.color,
      size,
      submitted,
      counts,                      // ← 남기는 것은 여기까지. 누가 골랐는지는 없다.
      raw,
      trustDelta,
      appliedDelta: applied,
      trustBefore,
      trustAfter: village.trust,
      coinsGained,
      institution,
      caughtCount,
      bonusCount,
    });
  }

  const totals = villageRows.reduce((acc, v) => {
    acc.a += v.counts.a; acc.b += v.counts.b; acc.c += v.counts.c;
    acc.submitted += v.submitted;
    return acc;
  }, { a: 0, b: 0, c: 0, submitted: 0 });
  totals.total = session.playerCount;
  totals.missing = Math.max(0, totals.total - totals.submitted);
  // 정직 선택률 = (규칙대로 + 용기 내어 알리기) / 제출 인원
  totals.honestRate = totals.submitted ? Math.round(((totals.b + totals.c) / totals.submitted) * 100) : null;

  const results = {
    stageId: r.stageId,
    round: stage.round,
    scenario: stage.scenario,
    scoring,
    closedAt: Date.now(),
    seconds: r.seconds,
    extendedSeconds: r.extendedSeconds || 0,
    villages: villageRows,
    totals,
  };

  session.roundResults[r.stageId] = results;

  // ★ 개인 선택 원본은 여기서 사라진다. 이후 어디에도 남지 않는다.
  session.secretChoices.delete(r.stageId);
  session.personalOutcomes = outcomes;

  r.phase = 'closed';
  r.endsAt = null;
  session.touch();
  return results;
}

/** 본인 결과 — 요청한 그 학생의 소켓으로만 보낸다. */
export function personalOutcome(session, token) {
  return session.personalOutcomes.get(token) || null;
}

/**
 * 진행자가 라운드를 되돌릴 때 — 집계하지 않고 그냥 없던 일로 한다.
 * 모은 선택은 점수에 반영되지 않고 그대로 지워진다.
 */
export function abortRound(session) {
  const r = session.round;
  if (!r || r.phase !== 'running') return false;
  session.secretChoices.delete(r.stageId);
  r.phase = 'ready';
  r.endsAt = null;
  r.extendedSeconds = 0;
  session.touch();
  return true;
}

// ------------------------------------------------------------------ 제도 효과

/**
 * 투명 장부제 — 진행 중인 우리 마을의 선택 비율.
 * 사람이 아니라 개수만 센다.
 */
export function villageLiveTally(session, villageIndex) {
  const r = session.round;
  if (!r || r.phase !== 'running') return null;
  if (institutionActive(session, villageIndex, getStage(r.stageId)) !== 'ledger') return null;

  const choices = session.secretChoices.get(r.stageId) || new Map();
  const counts = { a: 0, b: 0, c: 0 };
  let submitted = 0;
  for (const player of session.villageMembers(villageIndex)) {
    const c = choices.get(player.token);
    if (!c) continue;
    counts[c]++;
    submitted++;
  }
  return { counts, submitted, size: session.villageSizes()[villageIndex] || 0 };
}

/** 청렴 서약제 — 라운드가 시작되기 "전"에만 누를 수 있다. */
export function pledgeForRound(session, token) {
  const r = session.round;
  if (!r) fail('아직 라운드가 준비되지 않았어요.');
  if (r.phase !== 'ready') fail('라운드가 시작되기 전에만 서약할 수 있어요.');
  const player = session.getPlayer(token);
  if (!player) fail('참가자를 찾을 수 없습니다.');
  if (institutionActive(session, player.villageIndex, getStage(r.stageId)) !== 'pledge') {
    fail('우리 마을의 제도가 아니에요.');
  }
  player.roundPledges[r.stageId] = true;
  session.touch();
  return true;
}

/** 이 마을에서 이번 라운드에 서약한 인원 (개인 식별 없이 수만) */
export function villagePledgeCount(session, villageIndex, stageId = session.round?.stageId) {
  if (!stageId) return 0;
  return session.villageMembers(villageIndex).filter((p) => p.roundPledges[stageId]).length;
}
