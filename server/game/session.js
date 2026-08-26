import {
  TRUST_START, TRUST_MIN, TRUST_MAX,
  VILLAGE_COUNT_DEFAULT, VILLAGE_COUNT_MIN, VILLAGE_COUNT_MAX,
  ROUND_SECONDS_DEFAULT, ROUND_SECONDS_MIN, ROUND_SECONDS_MAX,
} from '../config.js';
import { makeNickname, nicknameEmoji } from '../lib/nickname.js';
import { makeToken } from '../lib/code.js';
import { villagePreset } from './villages.js';
import { FIRST_STAGE, getStage, nextStageId, prevStageId, stageIndex, STAGES } from './stages.js';
import { INSTITUTION_IDS, isInstitution } from '../lib/content.js';
import { armRound, submittedCount, hasSubmitted, myChoice, personalOutcome, villageLiveTally, villagePledgeCount, institutionActive } from './engine.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 한 학급 = 한 세션. 서버 메모리가 유일한 진실 소스이며,
 * 스냅샷(toSnapshot)에는 "누가 무엇을 골랐는지"가 절대 포함되지 않는다.
 */
export class Session {
  constructor(code, settings = {}) {
    this.code = code;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.settings = {
      villageCount: clamp(settings.villageCount ?? VILLAGE_COUNT_DEFAULT, VILLAGE_COUNT_MIN, VILLAGE_COUNT_MAX),
      roundSeconds: clamp(settings.roundSeconds ?? ROUND_SECONDS_DEFAULT, ROUND_SECONDS_MIN, ROUND_SECONDS_MAX),
      scenarioSet: settings.scenarioSet || 'default',
    };
    this.stageId = FIRST_STAGE;

    /**
     * 진행자 열쇠. 코드만 아는 학생이 수업 진행을 조작하지 못하게 막는다.
     * 진행자 브라우저의 localStorage 에만 저장되고 학생에게는 절대 나가지 않는다.
     */
    this.hostKey = makeToken();

    /** @type {Map<string, object>} token → 학생 */
    this.players = new Map();
    this.villages = [];
    this.rebuildVillages();

    /** 최종 발표에서 지금까지 공개한 장 수 (진행자 버튼으로 하나씩 올라간다) */
    this.revealStep = 0;

    /** 데모 봇 모드 (혼자 리허설·시연용) */
    this.demoOn = false;

    /** 라운드 집계 결과 — 개인 식별 없음 */
    this.roundResults = {};   // stageId → 집계     (2단계)
    this.warmup = {};         // questionId → { optionIndex: 표수 } — 카운트만 (3단계)
    this.warmupVoters = {};   // questionId → { token: optionIndex } — 메모리 전용, 중복 투표 방지용
    this.council = {};        // villageIndex → { 제도id: 득표수 } — 카운트만
    this.councilVoters = {};  // villageIndex → { token: 제도id } — 메모리 전용
    this.reflections = [];    // 익명 소감 카드 (누가 썼는지는 없음)
    this.reflectionSeq = 1;
    this.pledgeCount = 0;     // 서약 인원

    /** 진행 중인 라운드 (메모리 전용). { stageId, phase, endsAt, ... } */
    this.round = null;

    /**
     * 개인 선택 원본. 절대 직렬화·브로드캐스트하지 않는다.
     * stageId → Map(token → 'a'|'b'|'c') — 라운드를 마감하면 즉시 지워진다.
     */
    this.secretChoices = new Map();

    /**
     * 마감 직후 "본인에게만" 보여 줄 결과. token → { choice, coinDelta, caught, bonus }
     * 역시 메모리 전용이고, 다음 라운드가 열리면 지워진다.
     */
    this.personalOutcomes = new Map();
  }

  touch() { this.updatedAt = Date.now(); }

  // ---------------------------------------------------------------- 마을

  rebuildVillages() {
    const n = this.settings.villageCount;
    const next = [];
    for (let i = 0; i < n; i++) {
      const preset = villagePreset(i);
      const old = this.villages[i];
      next.push({
        index: i,
        name: preset.name,
        emoji: preset.emoji,
        color: preset.color,     // 면(배경)으로만 쓴다. 글자는 언제나 검정.
        token: preset.token,
        trust: old ? old.trust : TRUST_START,
        institution: old ? old.institution : null,
      });
    }
    this.villages = next;
  }

  /** 마을 수 변경 — 이미 들어온 학생은 입장 순서대로 다시 고르게 배정한다. */
  setVillageCount(n) {
    const count = clamp(Number(n) || VILLAGE_COUNT_DEFAULT, VILLAGE_COUNT_MIN, VILLAGE_COUNT_MAX);
    if (count === this.settings.villageCount) return;
    this.settings.villageCount = count;
    this.rebuildVillages();
    const ordered = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    for (const p of ordered) p.villageIndex = -1;
    for (const p of ordered) p.villageIndex = this.leastPopulatedVillage();
    this.touch();
  }

  setRoundSeconds(s) {
    this.settings.roundSeconds = clamp(Number(s) || ROUND_SECONDS_DEFAULT, ROUND_SECONDS_MIN, ROUND_SECONDS_MAX);
    this.touch();
  }

  /** 가장 인원이 적은 마을(동점이면 앞 번호) — "골고루" 배정의 규칙 */
  leastPopulatedVillage() {
    const counts = this.villageSizes();
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
    return best;
  }

  villageMembers(index) {
    return [...this.players.values()].filter((p) => p.villageIndex === index);
  }

  villageSizes() {
    const counts = new Array(this.settings.villageCount).fill(0);
    for (const p of this.players.values()) {
      if (p.villageIndex >= 0 && p.villageIndex < counts.length) counts[p.villageIndex]++;
    }
    return counts;
  }

  adjustTrust(villageIndex, delta) {
    const v = this.villages[villageIndex];
    if (!v) return 0;
    const before = v.trust;
    v.trust = clamp(Math.round(v.trust + delta), TRUST_MIN, TRUST_MAX);
    return v.trust - before;
  }

  // ---------------------------------------------------------------- 학생

  /** 새 학생 입장 — 개인정보를 받지 않는다. 서버가 닉네임과 마을을 정한다. */
  addPlayer() {
    const taken = new Set([...this.players.values()].map((p) => p.nickname));
    const nickname = makeNickname(taken);
    const token = makeToken();
    const player = {
      token,
      nickname,
      emoji: nicknameEmoji(nickname),
      villageIndex: this.leastPopulatedVillage(),
      coins: 0,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      connected: true,
      socketId: null,
      pledged: false,        // 최종 서약
      roundPledges: {},      // 청렴 서약제: stageId → true
      hearted: [],           // 하트 누른 소감 id
      reflectionCount: 0,    // 도배 방지용 (내용은 세지 않는다)
    };
    this.players.set(token, player);
    this.touch();
    return player;
  }

  getPlayer(token) {
    return token ? this.players.get(token) || null : null;
  }

  removePlayer(token) {
    const removed = this.players.delete(token);
    if (removed) this.touch();
    return removed;
  }

  get playerCount() { return this.players.size; }

  get connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ---------------------------------------------------------------- 단계

  get stage() { return getStage(this.stageId); }

  goNext() { return this.goto(nextStageId(this.stageId)); }
  goPrev() { return this.goto(prevStageId(this.stageId)); }

  goto(id) {
    const target = getStage(id);
    if (!target || target.id === this.stageId) return this.stageId;
    this.stageId = target.id;
    this.onStageChanged();
    this.touch();
    return this.stageId;
  }

  /** 라운드 단계에 들어서면 "설명 중(ready)" 상태로 준비만 해 둔다. 시작은 진행자가. */
  onStageChanged() {
    if (this.stage.kind === 'round') {
      armRound(this, this.stageId);
    } else {
      this.round = null;
      this.secretChoices.clear();
    }
  }

  // ---------------------------------------------------------------- 워밍업

  /**
   * 워밍업 투표. 누가 무엇을 골랐는지는 warmupVoters 에 메모리로만 두고
   * (마음을 바꿀 수 있게 해 주려면 이전 표를 빼야 하므로) 스냅샷에는 카운트만 남긴다.
   */
  warmupVote(token, questionId, optionIndex) {
    if (!this.getPlayer(token)) return null;
    const qid = String(questionId);
    const pick = Number(optionIndex);
    if (!Number.isInteger(pick) || pick < 0 || pick > 9) return null;

    this.warmup[qid] ||= {};
    this.warmupVoters[qid] ||= {};

    const before = this.warmupVoters[qid][token];
    if (before === pick) return this.warmup[qid];
    if (before != null) this.warmup[qid][before] = Math.max(0, (this.warmup[qid][before] || 0) - 1);

    this.warmupVoters[qid][token] = pick;
    this.warmup[qid][pick] = (this.warmup[qid][pick] || 0) + 1;
    this.touch();
    return this.warmup[qid];
  }

  /** 이 학생이 워밍업에서 무엇을 골랐는지 — 본인에게만 되돌려 준다 */
  myWarmupVotes(token) {
    const out = {};
    for (const [qid, voters] of Object.entries(this.warmupVoters)) {
      if (voters[token] != null) out[qid] = voters[token];
    }
    return out;
  }

  // ---------------------------------------------------------------- 마을회의

  /**
   * 제도 투표. 마을 안에서만 센다.
   * 누가 무엇에 투표했는지는 councilVoters 에 메모리로만 두고(마음을 바꿀 수 있게),
   * 스냅샷에는 마을별 득표수만 남는다.
   */
  councilVote(token, institutionId) {
    const p = this.getPlayer(token);
    if (!p || !isInstitution(institutionId)) return null;
    const vi = p.villageIndex;

    this.council[vi] ||= {};
    this.councilVoters[vi] ||= {};

    const before = this.councilVoters[vi][token];
    if (before !== institutionId) {
      if (before) this.council[vi][before] = Math.max(0, (this.council[vi][before] || 0) - 1);
      this.councilVoters[vi][token] = institutionId;
      this.council[vi][institutionId] = (this.council[vi][institutionId] || 0) + 1;
    }

    // 득표수가 바뀔 때마다 채택 제도를 다시 계산한다 (동점이면 카드 순서상 앞선 것)
    this.villages[vi].institution = this.leadingInstitution(vi);
    this.touch();
    return this.councilTally(vi);
  }

  /** 다수결. 동점이면 institutions.json 에 먼저 적힌 카드. 표가 없으면 null. */
  leadingInstitution(villageIndex) {
    const votes = this.council[villageIndex] || {};
    let best = null;
    let bestCount = 0;
    for (const id of INSTITUTION_IDS) {
      const n = votes[id] || 0;
      if (n > bestCount) { best = id; bestCount = n; }
    }
    return bestCount > 0 ? best : null;
  }

  /** 화면에 뿌릴 마을 투표 현황 — 사람이 아니라 개수만 */
  councilTally(villageIndex) {
    const votes = this.council[villageIndex] || {};
    const counts = Object.fromEntries(INSTITUTION_IDS.map((id) => [id, votes[id] || 0]));
    const voted = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      villageIndex,
      counts,
      voted,
      size: this.villageSizes()[villageIndex] || 0,
      leading: this.villages[villageIndex]?.institution || null,
    };
  }

  councilAll() {
    return this.villages.map((v) => this.councilTally(v.index));
  }

  /** 이 학생이 무엇에 투표했는지 — 본인에게만 */
  myCouncilVote(token) {
    const p = this.getPlayer(token);
    if (!p) return null;
    return this.councilVoters[p.villageIndex]?.[token] || null;
  }

  // ---------------------------------------------------------------- 소감 · 서약

  /** 익명 소감 한 장. 누가 썼는지는 어디에도 남지 않는다. */
  addReflection(text) {
    const card = {
      id: `r${this.reflectionSeq++}`,
      text,
      hearts: 0,
      at: Date.now(),
    };
    this.reflections.push(card);
    this.touch();
    return card;
  }

  /** 한 사람이 한 장에 하트 하나. 다시 누르면 취소된다. */
  toggleHeart(token, reflectionId) {
    const p = this.getPlayer(token);
    const card = this.reflections.find((r) => r.id === reflectionId);
    if (!p || !card) return null;

    const at = p.hearted.indexOf(reflectionId);
    if (at >= 0) {
      p.hearted.splice(at, 1);
      card.hearts = Math.max(0, card.hearts - 1);
    } else {
      p.hearted.push(reflectionId);
      card.hearts += 1;
    }
    this.touch();
    return card;
  }

  /** 이 학생이 쓴 소감 개수 — 도배를 막기 위한 값 (내용은 세지 않는다) */
  myReflectionCount(token) {
    return this.getPlayer(token)?.reflectionCount || 0;
  }

  setPledged(token, on = true) {
    const p = this.getPlayer(token);
    if (!p || p.pledged === on) return this.pledgeCount;
    p.pledged = on;
    this.pledgeCount = [...this.players.values()].filter((x) => x.pledged).length;
    this.touch();
    return this.pledgeCount;
  }

  // ---------------------------------------------------------------- 최종 발표

  /** 발표는 한 장씩. 진행자가 버튼을 누를 때마다 다음 장이 열린다. */
  revealNext(max) {
    this.revealStep = Math.min(this.revealStep + 1, max);
    this.touch();
    return this.revealStep;
  }

  revealBack() {
    this.revealStep = Math.max(0, this.revealStep - 1);
    this.touch();
    return this.revealStep;
  }

  /** 개인 코인 순위 — 익명 닉네임으로만. 참고용(반전 연출용)이다. */
  coinRanking(limit = 0) {
    const rows = [...this.players.values()]
      .map((p) => ({
        nickname: p.nickname,
        emoji: p.emoji,
        coins: p.coins,
        villageIndex: p.villageIndex,
      }))
      .sort((a, b) => b.coins - a.coins || a.nickname.localeCompare(b.nickname, 'ko'));
    return limit ? rows.slice(0, limit) : rows;
  }

  /** 마을별 코인 합계 — 신뢰지수와 어긋나는 모습을 보여 주기 위한 값 */
  villageCoins() {
    return this.villages.map((v) => ({
      index: v.index,
      name: v.name,
      emoji: v.emoji,
      color: v.color,
      token: v.token,
      coins: this.villageMembers(v.index).reduce((sum, p) => sum + p.coins, 0),
      size: this.villageMembers(v.index).length,
      trust: v.trust,
    }));
  }

  /** 라운드별 정직 선택률 — 최종 발표 그래프용 */
  honestByRound() {
    const rows = [];
    for (const stage of STAGES) {
      if (stage.kind !== 'round' || !stage.scoring) continue;
      const r = this.roundResults[stage.id];
      rows.push({
        stageId: stage.id,
        round: stage.round,
        label: `R${stage.round}`,
        honestRate: r?.totals?.honestRate ?? null,
        submitted: r?.totals?.submitted ?? 0,
      });
    }
    return rows;
  }

  /** 화면 두 곳이 함께 쓰는 라운드 표시용 값 (개인 정보 없음) */
  roundView() {
    const r = this.round;
    if (!r) return null;
    return {
      stageId: r.stageId,
      scenarioId: r.scenarioId,
      round: r.round,
      scoring: r.scoring,
      phase: r.phase,
      seconds: r.seconds,
      endsAt: r.endsAt || null,
      extendedSeconds: r.extendedSeconds || 0,
      serverNow: Date.now(),   // 폰 시계가 틀어져 있어도 남은 시간이 맞도록
    };
  }

  // ---------------------------------------------------------------- 화면용 상태

  /** 진행자 화면 상태 — 개인 선택은 들어가지 않는다. */
  hostState() {
    const sizes = this.villageSizes();
    return {
      code: this.code,
      settings: { ...this.settings },
      stageId: this.stageId,
      stageIndex: stageIndex(this.stageId),
      stageCount: STAGES.length,
      stage: this.stage,
      villages: this.villages.map((v, i) => ({ ...v, size: sizes[i] || 0 })),
      playerCount: this.playerCount,
      connectedCount: this.connectedCount,
      /** 라운드 진행 상황 — 제출 "인원 수"만. 누가 냈는지·무엇을 냈는지는 없다. */
      round: this.round ? {
        ...this.roundView(),
        submitted: submittedCount(this),
        total: this.connectedCount,   // 지금 접속 중인 사람 기준
        results: this.roundResults[this.stageId] || null,
      } : null,
      roundResults: this.roundResults,
      warmup: this.warmup,
      /** 최종 발표 — 몇 번째 장까지 열었는지와, 각 장에 쓸 값들 */
      revealStep: this.revealStep,
      demo: { on: Boolean(this.demoOn), count: [...this.players.values()].filter((p) => p.isDemo).length },
      reveal: {
        coinTop: this.coinRanking(3),
        villageCoins: this.villageCoins(),
        honestByRound: this.honestByRound(),
      },
      council: this.councilAll(),
      reflections: this.reflections,
      pledgeCount: this.pledgeCount,
      /** 익명 명패 — 입장 확인용. 닉네임과 마을만. */
      roster: [...this.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          nickname: p.nickname,
          emoji: p.emoji,
          villageIndex: p.villageIndex,
          connected: p.connected,
        })),
    };
  }

  /** 학생 화면 상태 — 자기 자신의 정보만 담는다. */
  studentState(token) {
    const p = this.getPlayer(token);
    if (!p) return null;
    const sizes = this.villageSizes();
    const v = this.villages[p.villageIndex];
    return {
      code: this.code,
      stageId: this.stageId,
      stage: this.stage,
      settings: { ...this.settings },
      me: {
        nickname: p.nickname,
        emoji: p.emoji,
        coins: p.coins,
        villageIndex: p.villageIndex,
        pledged: p.pledged,
      },
      village: v ? { ...v, size: sizes[p.villageIndex] || 0 } : null,
      villages: this.villages.map((x, i) => ({
        index: i, name: x.name, emoji: x.emoji, color: x.color,
        trust: x.trust, size: sizes[i] || 0,
      })),
      playerCount: this.playerCount,
      revealStep: this.revealStep,
      warmup: this.warmup,
      myWarmup: this.myWarmupVotes(token),   // 본인이 무엇을 골랐는지만
      council: this.councilTally(p.villageIndex),   // 우리 마을 득표수만
      myCouncilVote: this.myCouncilVote(token),
      reflections: this.reflections,
      myHearts: p.hearted,
      myReflections: p.reflectionCount || 0,
      pledgeCount: this.pledgeCount,
      myPledged: p.pledged,
      /**
       * 라운드 관련 값 — 전부 "이 학생 자신의" 정보다.
       * 남의 선택은 어떤 경로로도 들어오지 않는다.
       */
      round: this.round ? {
        ...this.roundView(),
        mySubmitted: hasSubmitted(this, token),
        myChoice: myChoice(this, token),                 // 본인 것만
        myResult: personalOutcome(this, token),          // 본인 것만
        villageResult: this.villageResultFor(p.villageIndex, this.stageId),
        ledger: villageLiveTally(this, p.villageIndex),  // 투명 장부제일 때만 값이 있다
        institution: institutionActive(this, p.villageIndex, this.stage),
        pledgedThisRound: Boolean(p.roundPledges[this.round.stageId]),
        villagePledges: villagePledgeCount(this, p.villageIndex, this.round.stageId),
        submitted: submittedCount(this),
        total: this.connectedCount,
      } : null,
    };
  }

  /** 마을 단위 집계에서 내 마을 몫만 꺼내 준다 (다른 마을 것도 공개되는 값이라 안전) */
  villageResultFor(villageIndex, stageId) {
    const r = this.roundResults[stageId];
    if (!r) return null;
    const mine = r.villages.find((v) => v.index === villageIndex) || null;
    return mine ? { ...mine, totals: r.totals } : null;
  }

  // ---------------------------------------------------------------- 저장/복구

  /**
   * 스냅샷. secretChoices 는 의도적으로 제외한다 —
   * 개인의 선택은 디스크에 절대 남기지 않는다.
   */
  toSnapshot() {
    return {
      version: 1,
      code: this.code,
      hostKey: this.hostKey,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      settings: { ...this.settings },
      stageId: this.stageId,
      demoOn: Boolean(this.demoOn),
      villages: this.villages,
      players: [...this.players.values()].map((p) => ({
        token: p.token,
        nickname: p.nickname,
        emoji: p.emoji,
        villageIndex: p.villageIndex,
        coins: p.coins,
        joinedAt: p.joinedAt,
        pledged: p.pledged,
        roundPledges: p.roundPledges,
        hearted: p.hearted,
        reflectionCount: p.reflectionCount || 0,
        isDemo: Boolean(p.isDemo),
      })),
      roundResults: this.roundResults,
      warmup: this.warmup,
      revealStep: this.revealStep,
      council: this.council,
      reflections: this.reflections,
      reflectionSeq: this.reflectionSeq,
      pledgeCount: this.pledgeCount,
    };
  }

  static fromSnapshot(data) {
    const s = new Session(data.code, data.settings);
    if (data.hostKey) s.hostKey = data.hostKey;
    s.demoOn = Boolean(data.demoOn);
    s.createdAt = data.createdAt || Date.now();
    s.updatedAt = data.updatedAt || Date.now();
    s.stageId = data.stageId || FIRST_STAGE;
    if (Array.isArray(data.villages) && data.villages.length) {
      s.villages = data.villages.map((v, i) => ({ ...villagePreset(i), ...v, index: i }));
    }
    for (const p of data.players || []) {
      s.players.set(p.token, {
        ...p,
        lastSeen: 0,
        connected: false,     // 복구 직후엔 아무도 붙어 있지 않다
        socketId: null,
        roundPledges: p.roundPledges || {},
        hearted: p.hearted || [],
      });
    }
    s.roundResults = data.roundResults || {};
    s.warmup = data.warmup || {};
    s.revealStep = data.revealStep || 0;
    s.council = data.council || {};
    s.reflections = data.reflections || [];
    s.reflectionSeq = data.reflectionSeq || (s.reflections.length + 1);
    s.pledgeCount = data.pledgeCount || 0;
    // 진행 중이던 라운드는 복구하지 않는다 — 개인 선택을 디스크에 남기지 않기 때문.
    // 이미 마감된 라운드는 집계가 남아 있으므로 closed 로, 아니면 다시 ready 로 준비된다.
    s.onStageChanged();
    return s;
  }
}
