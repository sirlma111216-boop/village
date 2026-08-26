// 데모 봇 모드 — 서버 안에서 도는 가상 학생들.
//
// 혼자 리허설하거나 심사 시연할 때 씁니다. 진행자 설정에서 켜면
// 소켓 없이 세션에 바로 들어와, 라운드가 열리면 알아서 선택합니다.
//
// ── 왜 서버 안에 두는가 ───────────────────────────────────────
// 밖에서 socket.io 로 붙이는 봇(tools/bots.mjs)은 터미널이 필요합니다.
// 시연 자리에서는 진행자 화면의 스위치 하나로 끝나야 하므로,
// 여기서는 세션 객체를 직접 다루는 쪽을 택했습니다.
//
// ── 분포 설계 ─────────────────────────────────────────────────
// 이 수업이 보여 주려는 곡선을 그대로 재현합니다.
//   연습·R1·R2 : "몰래 이득"이 다수 — 들키지 않으면 괜찮아 보이는 구간
//   R3·R4      : 제도가 들어오면 정직 선택이 올라간다
// 제도별로 오르는 폭이 다릅니다. 감사제는 겁을 주고, 장부제는 눈치를 만들고,
// 서약제는 미리 한 약속이 발목을 잡습니다.

import { CHOICE_KEYS } from '../config.js';
import { getStage } from './stages.js';
import { startRound, submitChoice, hasSubmitted, pledgeForRound, institutionActive } from './engine.js';
import { INSTITUTION_IDS } from '../lib/content.js';

export const DEMO_DEFAULT_COUNT = 28;
export const DEMO_MAX_COUNT = 40;

/**
 * 라운드별 기본 성향 — [몰래 이득, 규칙대로, 용기 내어 알리기] 비율.
 *
 * 시연에서 곡선이 매번 읽혀야 하므로 초반과 후반을 넉넉히 벌려 둔다.
 * 28명 표본에서도 R1·R2 정직률은 30%대, R3·R4 는 60~80%대로 갈린다.
 */
const BASE_MIX = {
  0: [0.52, 0.34, 0.14],   // 연습 — 가볍게 몰래
  1: [0.64, 0.26, 0.10],   // R1 — 아무도 모르잖아
  2: [0.70, 0.21, 0.09],   // R2 — 신뢰지수가 떨어져도 더 대담해진다
  3: [0.38, 0.40, 0.22],   // R3 — 중간 집계를 보고 돌아선다
  4: [0.30, 0.43, 0.27],   // R4 — 마지막엔 더
};

/** 제도가 붙으면 "몰래 이득"에서 이만큼을 정직 쪽으로 옮긴다 */
const INSTITUTION_SHIFT = {
  audit: 0.22,    // 걸릴 수 있다는 두려움
  ledger: 0.16,   // 우리 마을이 보고 있다
  pledge: 0.13,   // 내가 한 약속
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 비율대로 하나 고른다 */
function weighted(mix) {
  const roll = Math.random();
  let acc = 0;
  for (let i = 0; i < mix.length; i++) {
    acc += mix[i];
    if (roll < acc) return CHOICE_KEYS[i];
  }
  return CHOICE_KEYS[CHOICE_KEYS.length - 1];
}

/** 이 라운드에서 이 봇이 무엇을 고를까 */
function chooseFor(session, player, stage) {
  const base = BASE_MIX[stage.round ?? 0] || BASE_MIX[1];
  let [a, b, c] = base;

  const inst = institutionActive(session, player.villageIndex, stage);
  const shift = INSTITUTION_SHIFT[inst] || 0;
  if (shift) {
    const moved = Math.min(a, shift);
    a -= moved;
    b += moved * 0.6;
    c += moved * 0.4;
  }

  // 봇마다 성향을 조금씩 흩뜨린다 — 마을마다 결과가 달라야 그래프가 산다
  const tilt = player.demoTilt || 0;
  a = Math.max(0, a + tilt);
  c = Math.max(0, c - tilt * 0.5);

  const sum = a + b + c;
  return weighted([a / sum, b / sum, c / sum]);
}

// ==================================================================
// 봇 살림
// ==================================================================

export function demoCount(session) {
  let n = 0;
  for (const p of session.players.values()) if (p.isDemo) n++;
  return n;
}

/**
 * 가상 학생을 원하는 인원까지 채운다. 이미 있으면 그만큼만 더한다.
 * 봇도 "접속 중"으로 잡혀야 제출 인원 분모가 맞는다.
 */
export function addDemoStudents(session, count) {
  const want = Math.max(0, Math.min(DEMO_MAX_COUNT, count));
  const have = demoCount(session);
  const added = [];

  for (let i = have; i < want; i++) {
    const p = session.addPlayer();
    p.isDemo = true;
    p.connected = true;
    p.demoTilt = (Math.random() - 0.5) * 0.24;
    p.demoInstitution = pick(INSTITUTION_IDS);
    added.push(p);
  }
  session.touch();
  return added;
}

/** 봇을 전부 내보낸다. 사람 학생은 건드리지 않는다. */
export function removeDemoStudents(session) {
  let removed = 0;
  for (const [token, p] of [...session.players]) {
    if (!p.isDemo) continue;
    session.players.delete(token);
    // 마을회의 표도 함께 걷어 낸다
    const votes = session.councilVoters[p.villageIndex];
    if (votes?.[token]) {
      const id = votes[token];
      session.council[p.villageIndex][id] = Math.max(0, (session.council[p.villageIndex][id] || 0) - 1);
      delete votes[token];
      session.villages[p.villageIndex].institution = session.leadingInstitution(p.villageIndex);
    }
    for (const q of Object.keys(session.warmupVoters)) delete session.warmupVoters[q][token];
    removed++;
  }
  if (removed) {
    session.pledgeCount = [...session.players.values()].filter((x) => x.pledged).length;
    session.touch();
  }
  return removed;
}

// ==================================================================
// 봇이 하는 일 — 단계마다 다르다
// ==================================================================

/**
 * 라운드가 열리면 봇들이 시간차를 두고 제출한다.
 * 한꺼번에 들어오면 진행자 화면의 막대가 순간이동하듯 차올라서
 * 시연이 어색해지므로, 라운드 길이에 맞춰 흩뿌린다.
 * @returns {number} 예약한 제출 수
 */
export function scheduleRoundSubmits(session, { onProgress, register }) {
  const r = session.round;
  if (!r || r.phase !== 'running') return 0;
  const stage = getStage(r.stageId);

  const bots = [...session.players.values()].filter((p) => p.isDemo);
  if (!bots.length) return 0;

  // 라운드 시간의 15~75% 구간에 흩어 놓는다 (최대 20초)
  const window = Math.min(20_000, Math.max(2_000, (r.seconds || 60) * 1000 * 0.6));

  let scheduled = 0;
  for (const bot of bots) {
    // 몇 명은 일부러 안 낸다 — 실제 교실에는 늘 미제출자가 있고,
    // 그래야 "미제출자는 델타 0으로 친다"는 규칙까지 시연에서 드러난다
    if (Math.random() < 0.07) continue;
    scheduled++;
    const delay = 900 + Math.random() * window;
    const timer = setTimeout(() => {
      if (session.round?.stageId !== r.stageId || session.round.phase !== 'running') return;
      if (hasSubmitted(session, bot.token)) return;
      try {
        submitChoice(session, bot.token, chooseFor(session, bot, stage));
        onProgress?.(bot.villageIndex);
      } catch { /* 이미 마감됐으면 그만 */ }
    }, delay);
    timer.unref?.();
    register(timer);
  }

  return scheduled;
}

/** 청렴 서약제 마을의 봇들은 라운드가 열리기 전에 서약해 둔다 */
export function preparePledges(session) {
  const r = session.round;
  if (!r || r.phase !== 'ready') return 0;
  let n = 0;
  for (const bot of session.players.values()) {
    if (!bot.isDemo) continue;
    if (institutionActive(session, bot.villageIndex, getStage(r.stageId)) !== 'pledge') continue;
    if (Math.random() > 0.75) continue;
    try { pledgeForRound(session, bot.token); n++; } catch { /* 무시 */ }
  }
  return n;
}

/** 워밍업 투표 */
export function doWarmup(session, questionIds) {
  let n = 0;
  for (const bot of session.players.values()) {
    if (!bot.isDemo) continue;
    for (const qid of questionIds) {
      if (session.warmupVoters[qid]?.[bot.token] != null) continue;
      // 첫 문항은 "조금 달라진다"로 기울여 둔다 — 이야기와 맞물리게
      const mix = qid === 'w1' ? [0.28, 0.44, 0.28] : [0.3, 0.42, 0.28];
      const roll = Math.random();
      const idx = roll < mix[0] ? 0 : roll < mix[0] + mix[1] ? 1 : 2;
      session.warmupVote(bot.token, qid, idx);
      n++;
    }
  }
  return n;
}

/** 마을회의 — 마을마다 다른 제도가 뽑히도록 성향을 갈라 둔다 */
export function doCouncil(session) {
  let n = 0;
  for (const bot of session.players.values()) {
    if (!bot.isDemo) continue;
    if (session.councilVoters[bot.villageIndex]?.[bot.token]) continue;
    // 70% 는 자기 마을 성향대로, 30% 는 딴 데 던진다
    const own = INSTITUTION_IDS[bot.villageIndex % INSTITUTION_IDS.length];
    session.councilVote(bot.token, Math.random() < 0.7 ? own : bot.demoInstitution);
    n++;
  }
  return n;
}

const DEMO_REFLECTIONS = [
  '들키지 않으면 괜찮을까, 계속 생각났어',
  '우리 마을 신뢰가 떨어질 때 마음이 이상했다',
  '몰래 이득을 골랐는데 아무도 몰라서 더 찝찝했어',
  '감사제가 생기니까 한 번 더 생각하게 됐다',
  '솔직히 코인이 탐났다',
  '용기 내어 알리기는 생각보다 어려웠어',
  '규칙대로 한 사람이 손해 보는 것 같아 속상했다',
  '내 선택 하나가 마을 전체를 바꾼다는 게 신기했다',
  '아무도 안 볼 때가 제일 어려웠다',
  '다음엔 처음부터 정직하게 할래',
  '코인 1등인데 우리 마을이 꼴찌라서 놀랐다',
  '투명 장부제가 있으니까 괜히 눈치가 보였어',
];

/** 소감 몇 장과 하트 (전부는 쓰지 않는다 — 실제 교실도 그렇다) */
export function doReflections(session, { cleanText, onCard }) {
  const bots = [...session.players.values()].filter((p) => p.isDemo && !p.reflectionCount);
  const writers = bots.filter(() => Math.random() < 0.55);
  const cards = [];

  for (const bot of writers) {
    const cleaned = cleanText(pick(DEMO_REFLECTIONS));
    if (!cleaned.ok) continue;
    if (session.reflections.some((r) => r.text === cleaned.text)) continue;   // 같은 문장 중복 방지
    const card = session.addReflection(cleaned.text);
    bot.reflectionCount = 1;
    cards.push(card);
    onCard?.(card);
  }

  // 하트도 눌러 준다
  for (const bot of bots) {
    for (const card of session.reflections) {
      if (Math.random() < 0.3) session.toggleHeart(bot.token, card.id);
    }
  }
  return cards;
}

export function doPledges(session) {
  let n = 0;
  for (const bot of session.players.values()) {
    if (!bot.isDemo || bot.pledged) continue;
    if (Math.random() < 0.86) { session.setPledged(bot.token, true); n++; }
  }
  return n;
}
