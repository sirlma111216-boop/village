// 라운드 엔진 점검 (서버 없이): 신뢰지수 계산 · 제도 효과 · 익명성
// 사용: node tools/smoke-engine.mjs
import { Session } from '../server/game/session.js';
import {
  startRound, submitChoice, closeRound, abortRound, extendRound,
  personalOutcome, villageLiveTally, pledgeForRound, roundPhase, remainingMs,
} from '../server/game/engine.js';

let bad = 0;
const check = (label, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};
const head = (t) => console.log(`\n▶ ${t}`);

/** 마을마다 perVillage 명씩 고르게 채운 세션 */
function makeSession(perVillage = 4, villages = 4) {
  const s = new Session('TEST01', { villageCount: villages, roundSeconds: 60 });
  for (let i = 0; i < perVillage * villages; i++) s.addPlayer();
  return s;
}

/** 마을 0 에만 n 명 — 한 마을만 놓고 볼 때. (마을 최소 수가 2라 마을 1 은 비워 둔다) */
function soloVillage(n) {
  const s = new Session('TEST01', { villageCount: 2, roundSeconds: 60 });
  for (let i = 0; i < n; i++) s.addPlayer();
  for (const p of s.players.values()) p.villageIndex = 0;
  return s;
}

const tokensOf = (s, v) => s.villageMembers(v).map((p) => p.token);

// ------------------------------------------------------------------ 신뢰지수 계산

head('신뢰지수 계산 (정규화 NORM=4)');
{
  const s = makeSession(4);
  s.goto('round1');
  check('라운드 단계 진입 시 ready', roundPhase(s, 'round1') === 'ready');
  startRound(s, 'round1');
  check('시작하면 running', roundPhase(s, 'round1') === 'running');

  // 마을0: a,a,b,c  → raw = -2-2+1+3 = 0 → delta 0
  const v0 = tokensOf(s, 0);
  submitChoice(s, v0[0], 'a');
  submitChoice(s, v0[1], 'a');
  submitChoice(s, v0[2], 'b');
  submitChoice(s, v0[3], 'c');

  // 마을1: c,c,c,c → raw = 12, size 4 → 12/4*4 = 12
  for (const t of tokensOf(s, 1)) submitChoice(s, t, 'c');

  // 마을2: a,a,a,a → raw = -8 → -8/4*4 = -8
  for (const t of tokensOf(s, 2)) submitChoice(s, t, 'a');

  // 마을3: b 한 명만 제출(3명 미제출) → raw = 1, size 4 → 1/4*4 = 1
  submitChoice(s, tokensOf(s, 3)[0], 'b');

  const r = closeRound(s, () => 1); // 감사 적발 없음
  const [m0, m1, m2, m3] = r.villages;

  check('마을0 델타 0', m0.trustDelta === 0, `raw ${m0.raw} → ${m0.trustDelta}`);
  check('마을1 델타 +12', m1.trustDelta === 12, `60 → ${m1.trustAfter}`);
  check('마을2 델타 -8', m2.trustDelta === -8, `60 → ${m2.trustAfter}`);
  check('미제출자는 분모에 남고 델타 0 취급', m3.trustDelta === 1, `raw ${m3.raw}/size ${m3.size} → ${m3.trustDelta}`);
  check('제출 인원 집계', r.totals.submitted === 13, String(r.totals.submitted));
  check('미제출 인원 집계', r.totals.missing === 3, String(r.totals.missing));
  // b+c = (마을0 b1+c1) + (마을1 c4) + (마을3 b1) = 7명, 제출 13명
  check('정직 선택률 = (b+c)/제출', r.totals.honestRate === Math.round((7 / 13) * 100), `${r.totals.honestRate}%`);
  check('마감하면 closed', roundPhase(s, 'round1') === 'closed');
}

head('마을 크기가 달라도 공정한가');
{
  const s = new Session('TEST02', { villageCount: 2 });
  for (let i = 0; i < 12; i++) s.addPlayer();           // 6명 + 6명
  // 마을1 에 3명 더 붙여 9:6 으로 기울인다
  for (const p of [...s.players.values()].slice(0, 3)) p.villageIndex = 1;
  s.goto('round1');
  startRound(s, 'round1');
  for (const t of tokensOf(s, 0)) submitChoice(s, t, 'c');
  for (const t of tokensOf(s, 1)) submitChoice(s, t, 'c');
  const r = closeRound(s, () => 1);
  check('전원 c 면 마을 크기와 무관하게 같은 델타',
    r.villages[0].trustDelta === r.villages[1].trustDelta,
    `${r.villages[0].size}명 ${r.villages[0].trustDelta} vs ${r.villages[1].size}명 ${r.villages[1].trustDelta}`);
}

head('신뢰지수 0~100 범위');
{
  const s = makeSession(4, 2);
  s.villages[0].trust = 96;
  s.villages[1].trust = 3;
  s.goto('round1');
  startRound(s, 'round1');
  for (const t of tokensOf(s, 0)) submitChoice(s, t, 'c');   // +12
  for (const t of tokensOf(s, 1)) submitChoice(s, t, 'a');   // -8
  closeRound(s, () => 1);
  check('위로 100 을 넘지 않음', s.villages[0].trust === 100, String(s.villages[0].trust));
  check('아래로 0 밑으로 안 감', s.villages[1].trust === 0, String(s.villages[1].trust));
}

// ------------------------------------------------------------------ 코인

head('개인 코인');
{
  const s = soloVillage(3);
  s.goto('round1');
  startRound(s, 'round1');
  const [t1, t2, t3] = tokensOf(s, 0);
  submitChoice(s, t1, 'a');
  submitChoice(s, t2, 'b');
  submitChoice(s, t3, 'c');
  closeRound(s, () => 1);
  check('몰래 이득 +3', s.getPlayer(t1).coins === 3);
  check('규칙대로 +1', s.getPlayer(t2).coins === 1);
  check('용기 내어 알리기 0', s.getPlayer(t3).coins === 0);
}

head('연습 라운드는 점수에 반영하지 않는다');
{
  const s = soloVillage(4);
  s.goto('practice');
  startRound(s, 'practice');
  for (const t of tokensOf(s, 0)) submitChoice(s, t, 'a');
  const r = closeRound(s, () => 1);
  check('코인 그대로 0', [...s.players.values()].every((p) => p.coins === 0));
  check('신뢰지수 그대로 60', s.villages[0].trust === 60);
  check('그래도 카운트는 집계', r.villages[0].counts.a === 4);
  check('scoring=false 로 표시', r.scoring === false);
}

// ------------------------------------------------------------------ 제도

head('청렴 감사제 (3라운드부터, a 선택 40% 적발 → -4)');
{
  const s = soloVillage(4);
  s.villages[0].institution = 'audit';

  // 2라운드에서는 제도가 아직 효력이 없다
  s.goto('round2');
  startRound(s, 'round2');
  for (const t of tokensOf(s, 0)) submitChoice(s, t, 'a');
  closeRound(s, () => 0);   // rng 0 = 무조건 적발되는 조건
  check('1·2라운드에는 제도 미적용', [...s.players.values()].every((p) => p.coins === 3));

  s.goto('round3');
  startRound(s, 'round3');
  for (const t of tokensOf(s, 0)) submitChoice(s, t, 'a');
  const r = closeRound(s, () => 0);   // 전원 적발
  check('3라운드에는 적용', r.villages[0].caughtCount === 4, `적발 ${r.villages[0].caughtCount}명`);
  check('적발되면 코인 +3-4 = -1', [...s.players.values()].every((p) => p.coins === 2), '3 → 2');

  const anyOutcome = personalOutcome(s, tokensOf(s, 0)[0]);
  check('적발 사실은 본인 결과에만', anyOutcome.caught === true);
  check('집계에는 적발 "인원 수"만', typeof r.villages[0].caughtCount === 'number'
    && !JSON.stringify(r).includes(tokensOf(s, 0)[0]));
}

head('청렴 서약제 (서약 후 b/c 면 +1)');
{
  const s = soloVillage(3);
  s.villages[0].institution = 'pledge';
  s.goto('round3');
  const [t1, t2, t3] = tokensOf(s, 0);
  pledgeForRound(s, t1);
  pledgeForRound(s, t2);
  startRound(s, 'round3');
  let tooLate = false;
  try { pledgeForRound(s, t3); } catch { tooLate = true; }
  check('시작 후에는 서약 불가', tooLate);
  submitChoice(s, t1, 'b');   // 서약 + 규칙대로 → 1 + 1 = 2
  submitChoice(s, t2, 'a');   // 서약해 놓고 어김 → 3 (벌은 없다)
  submitChoice(s, t3, 'c');   // 서약 안 함 → 0
  const r = closeRound(s, () => 1);
  check('서약 + 규칙대로 = +2', s.getPlayer(t1).coins === 2, String(s.getPlayer(t1).coins));
  check('서약하고 어겨도 벌 없음', s.getPlayer(t2).coins === 3);
  check('서약 안 하면 보너스 없음', s.getPlayer(t3).coins === 0);
  check('보너스 인원 집계', r.villages[0].bonusCount === 1);
}

head('투명 장부제 (진행 중 우리 마을 비율 공개)');
{
  const s = makeSession(4, 2);
  s.villages[0].institution = 'ledger';
  s.goto('round3');
  startRound(s, 'round3');
  const v0 = tokensOf(s, 0);
  submitChoice(s, v0[0], 'a');
  submitChoice(s, v0[1], 'c');
  const tally = villageLiveTally(s, 0);
  check('장부 마을은 실시간 비율이 보인다', tally?.counts.a === 1 && tally?.counts.c === 1, JSON.stringify(tally?.counts));
  check('장부에도 사람 정보는 없다', !JSON.stringify(tally).includes(v0[0]));
  check('제도 없는 마을은 안 보인다', villageLiveTally(s, 1) === null);
}

// ------------------------------------------------------------------ 익명성

head('익명성 — 개인 선택이 어디에도 남지 않는가');
{
  const s = makeSession(5, 4);
  s.goto('round1');
  startRound(s, 'round1');
  const all = [...s.players.values()];
  all.forEach((p, i) => submitChoice(s, p.token, ['a', 'b', 'c'][i % 3]));

  const during = JSON.stringify(s.hostState());
  check('진행 중 진행자 상태에 개인 선택 없음',
    !all.some((p) => during.includes(p.token)) && during.includes('"submitted"'));

  const r = closeRound(s, () => 1);

  check('마감 즉시 원본 맵 삭제', s.secretChoices.size === 0);
  const snap = JSON.stringify(s.toSnapshot());
  check('스냅샷에 토큰별 선택 없음', !/"choice"/.test(snap));
  check('스냅샷에 남는 건 마을별 카운트', /"counts":\s*\{"a":\d+,"b":\d+,"c":\d+\}/.test(snap));
  check('집계 결과에 참가자 토큰 없음', !all.some((p) => JSON.stringify(r).includes(p.token)));

  const hostAfter = JSON.stringify(s.hostState());
  check('마감 후 진행자 상태에도 개인 선택 없음', !all.some((p) => hostAfter.includes(p.token)));

  // 남의 상태를 봐도 남의 선택은 없다
  const mine = s.studentState(all[0].token);
  const otherTokens = all.slice(1).map((p) => p.token);
  check('학생 상태에 본인 결과만', mine.round.myResult !== null
    && !otherTokens.some((t) => JSON.stringify(mine).includes(t)));
  check('본인 선택은 본인에게 보인다', ['a', 'b', 'c'].includes(mine.round.myResult.choice));
}

// ------------------------------------------------------------------ 진행 제어

head('진행자 제어 — 연장 · 되돌리기 · 중복 방지');
{
  const s = soloVillage(4);
  s.goto('round1');
  startRound(s, 'round1');
  const before = remainingMs(s);
  extendRound(s, 30);
  check('시간 연장', remainingMs(s) - before > 29_000);

  const t = tokensOf(s, 0)[0];
  submitChoice(s, t, 'a');
  let twice = false;
  try { submitChoice(s, t, 'b'); } catch { twice = true; }
  check('두 번 제출 불가', twice);

  abortRound(s);
  check('되돌리면 다시 ready', roundPhase(s, 'round1') === 'ready');
  check('되돌리면 모은 선택은 사라진다', s.secretChoices.size === 0);
  check('되돌리면 점수는 그대로', [...s.players.values()].every((p) => p.coins === 0));

  startRound(s, 'round1');
  const r1 = closeRound(s, () => 1);
  const r2 = closeRound(s, () => 1);
  check('두 번 마감해도 한 번만 집계', r1.closedAt === r2.closedAt);

  let reclosed = false;
  try { startRound(s, 'round1'); } catch { reclosed = true; }
  check('끝난 라운드는 다시 시작 불가', reclosed);
}

head('서버 재시작 — 진행 중 라운드는 복구하지 않는다');
{
  const s = makeSession(4, 2);
  s.goto('round1');
  startRound(s, 'round1');
  submitChoice(s, tokensOf(s, 0)[0], 'a');
  const restored = Session.fromSnapshot(s.toSnapshot());
  check('복구 후 라운드는 ready 로 초기화', roundPhase(restored, 'round1') === 'ready');
  check('복구된 세션에 선택이 없음', restored.secretChoices.size === 0);

  const s2 = makeSession(4, 2);
  s2.goto('round1');
  startRound(s2, 'round1');
  for (const t of tokensOf(s2, 0)) submitChoice(s2, t, 'b');
  closeRound(s2, () => 1);
  const restored2 = Session.fromSnapshot(s2.toSnapshot());
  check('마감된 라운드는 closed 로 복구', roundPhase(restored2, 'round1') === 'closed');
  check('집계 결과는 살아남는다', restored2.roundResults.round1.villages[0].counts.b === 4);
  check('신뢰지수도 살아남는다', restored2.villages[0].trust === s2.villages[0].trust);
}

console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
process.exit(bad ? 1 : 0);
