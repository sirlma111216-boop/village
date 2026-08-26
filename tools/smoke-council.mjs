// 5단계 점검 (서버를 켠 상태에서): 마을회의 · 제도 효과 · 소감 벽 · 서약
// 사용: node tools/smoke-council.mjs
import { io } from 'socket.io-client';

const URL = process.env.TV_URL || 'http://localhost:3000';

let bad = 0;
const check = (label, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};
const head = (t) => console.log(`\n▶ ${t}`);

const connect = () => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ['websocket'], reconnection: false });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});
const ask = (s, ev, p = {}) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${ev}`)), 8000);
  s.emit(ev, p, (res) => {
    clearTimeout(t);
    if (res && res.ok === false) reject(new Error(res.error));
    else resolve(res);
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n▶ 신뢰마을 5단계 점검 (${URL})`);

const host = await connect();
const created = await ask(host, 'host:create', { villageCount: 4, roundSeconds: 120 });
const KEY = { code: created.code, hostKey: created.hostKey };
const CODE = created.code;
console.log(`  세션 ${CODE}`);

// 마을마다 4명씩
const PER = 4;
const villages = [[], [], [], []];
const all = [];
for (let i = 0; i < PER * 4; i++) {
  const sock = await connect();
  const res = await ask(sock, 'student:join', { code: CODE });
  const p = { sock, token: res.token, v: res.state.me.villageIndex };
  villages[p.v].push(p);
  all.push(p);
}
check('마을마다 4명', villages.every((v) => v.length === PER), villages.map((v) => v.length).join('/'));

const state = async () => (await ask(host, 'host:attach', KEY)).state;
const goto = (stageId) => ask(host, 'host:goto', { ...KEY, stageId });

// ------------------------------------------------------------------ 마을회의
head('마을회의 — 다수결 · 동점은 앞 카드 · 마음 바꾸기');
{
  await goto('council');

  let blocked = false;
  const before = await connect();
  await ask(before, 'student:join', { code: CODE });
  await goto('rules');
  try { await ask(before, 'student:council', { institutionId: 'audit' }); } catch { blocked = true; }
  check('회의 시간이 아니면 투표 거부', blocked);
  before.disconnect();
  await goto('council');

  // 마을0: 감사제 3표 vs 장부 1표 → audit
  await ask(villages[0][0].sock, 'student:council', { institutionId: 'audit' });
  await ask(villages[0][1].sock, 'student:council', { institutionId: 'audit' });
  await ask(villages[0][2].sock, 'student:council', { institutionId: 'audit' });
  await ask(villages[0][3].sock, 'student:council', { institutionId: 'ledger' });

  // 마을1: 서약제 3표
  for (let i = 0; i < 3; i++) await ask(villages[1][i].sock, 'student:council', { institutionId: 'pledge' });

  // 마을2: 장부제 4표
  for (const p of villages[2]) await ask(p.sock, 'student:council', { institutionId: 'ledger' });

  // 마을3: 2:2 동점 (ledger 2 vs audit 2) → 카드 순서상 앞선 ledger
  await ask(villages[3][0].sock, 'student:council', { institutionId: 'audit' });
  await ask(villages[3][1].sock, 'student:council', { institutionId: 'audit' });
  await ask(villages[3][2].sock, 'student:council', { institutionId: 'ledger' });
  await ask(villages[3][3].sock, 'student:council', { institutionId: 'ledger' });

  const st = await state();
  check('마을0 다수결 → 청렴 감사제', st.villages[0].institution === 'audit', st.villages[0].institution);
  check('마을1 다수결 → 청렴 서약제', st.villages[1].institution === 'pledge', st.villages[1].institution);
  check('마을2 만장일치 → 투명 장부제', st.villages[2].institution === 'ledger', st.villages[2].institution);
  check('마을3 동점 → 카드 순서상 앞선 것', st.villages[3].institution === 'ledger', st.villages[3].institution);

  const row0 = st.council.find((c) => c.villageIndex === 0);
  check('득표수만 집계된다', row0.counts.audit === 3 && row0.counts.ledger === 1, JSON.stringify(row0.counts));
  check('진행자 화면에 투표자 정보 없음', !all.some((p) => JSON.stringify(st.council).includes(p.token)));

  // 마음 바꾸기
  await ask(villages[0][0].sock, 'student:council', { institutionId: 'ledger' });
  const st2 = await state();
  const row = st2.council.find((c) => c.villageIndex === 0);
  check('마음을 바꾸면 총 표수는 그대로', row.voted === 4, `${row.voted}표`);
  check('바꾼 만큼 옮겨 간다', row.counts.audit === 2 && row.counts.ledger === 2, JSON.stringify(row.counts));
  check('2:2 가 되면 앞 카드로 채택 바뀜', st2.villages[0].institution === 'ledger');
  await ask(villages[0][0].sock, 'student:council', { institutionId: 'audit' });   // 되돌린다

  const mine = await ask(villages[0][0].sock, 'student:sync');
  check('내 표는 나에게만', mine.state.myCouncilVote === 'audit');
  check('우리 마을 표만 보인다', mine.state.council.villageIndex === 0 && !Array.isArray(mine.state.council));
}

// ------------------------------------------------------------------ 제도가 실제로 먹히는가
head('제도 효과 — 1·2라운드에는 없고, 3·4라운드에만');
{
  // 라운드 2: 제도가 아직 없어야 한다. 마을0 전원 a.
  await goto('round2');
  await ask(host, 'host:round:start', KEY);
  for (const p of villages[0]) await ask(p.sock, 'student:choose', { choice: 'a' });
  await ask(host, 'host:round:close', KEY);
  await wait(400);
  let st = await state();
  let r2 = st.roundResults.round2.villages[0];
  check('2라운드: 감사 적발 없음', r2.caughtCount === 0);
  check('2라운드: 제도 표시도 없음', r2.institution === null, String(r2.institution));
  const coinsAfterR2 = (await ask(villages[0][0].sock, 'student:sync')).state.me.coins;
  check('2라운드: 몰래 이득 그대로 +3', coinsAfterR2 === 3, String(coinsAfterR2));

  // 라운드 3: 마을0(감사제) 전원 a — 확률이 40% 라 여러 번 돌려 "적발이 일어나는가"를 본다
  await goto('round3');

  // 마을1(서약제) — 라운드 시작 전에 두 명만 서약
  await ask(villages[1][0].sock, 'student:pledge:round');
  await ask(villages[1][1].sock, 'student:pledge:round');
  let tooLateBlocked = false;

  await ask(host, 'host:round:start', KEY);
  try { await ask(villages[1][2].sock, 'student:pledge:round'); } catch { tooLateBlocked = true; }
  check('서약제: 라운드 시작 후에는 서약 불가', tooLateBlocked);

  for (const p of villages[0]) await ask(p.sock, 'student:choose', { choice: 'a' });
  await ask(villages[1][0].sock, 'student:choose', { choice: 'b' });   // 서약 지킴
  await ask(villages[1][1].sock, 'student:choose', { choice: 'a' });   // 서약 어김
  await ask(villages[1][2].sock, 'student:choose', { choice: 'b' });   // 서약 안 함
  await ask(villages[1][3].sock, 'student:choose', { choice: 'c' });

  // 마을2(장부제) — 진행 중 실시간 비율이 보이는가
  await ask(villages[2][0].sock, 'student:choose', { choice: 'c' });
  await wait(600);
  const ledgerView = (await ask(villages[2][1].sock, 'student:sync')).state.round.ledger;
  check('장부제: 우리 마을 실시간 비율이 보인다',
    ledgerView && ledgerView.counts.c === 1, JSON.stringify(ledgerView?.counts));
  const noLedger = (await ask(villages[1][3].sock, 'student:sync')).state.round.ledger;
  check('장부제 없는 마을은 안 보인다', noLedger === null);
  check('장부에도 사람 정보 없음', !all.some((p) => JSON.stringify(ledgerView).includes(p.token)));

  for (let i = 1; i < PER; i++) await ask(villages[2][i].sock, 'student:choose', { choice: 'b' });
  for (const p of villages[3]) await ask(p.sock, 'student:choose', { choice: 'b' });

  await ask(host, 'host:round:close', KEY);
  await wait(500);
  st = await state();
  const r3 = st.roundResults.round3;

  check('3라운드: 제도가 기록된다',
    r3.villages[0].institution === 'audit' && r3.villages[1].institution === 'pledge',
    `${r3.villages[0].institution} / ${r3.villages[1].institution}`);

  // 서약제: 서약하고 b/c 를 고른 사람만 +1
  const kept = (await ask(villages[1][0].sock, 'student:sync')).state;
  const broke = (await ask(villages[1][1].sock, 'student:sync')).state;
  const noPledge = (await ask(villages[1][2].sock, 'student:sync')).state;
  check('서약제: 서약 + 규칙대로 → 코인 +2', kept.round.myResult.coinDelta === 2,
    String(kept.round.myResult.coinDelta));
  check('서약제: 보너스가 본인 결과에 표시', kept.round.myResult.bonus === 1);
  check('서약제: 서약하고 어기면 보너스 없음', broke.round.myResult.bonus === 0);
  check('서약제: 서약 안 하면 보너스 없음', noPledge.round.myResult.bonus === 0);
  check('서약제: 보너스 인원만 집계', r3.villages[1].bonusCount === 1, `${r3.villages[1].bonusCount}명`);

  // 감사제: 적발된 사람이 있으면 그 사람 결과에만 표시되는지
  const audited = [];
  for (const p of villages[0]) {
    const s2 = (await ask(p.sock, 'student:sync')).state;
    audited.push({ token: p.token, caught: s2.round.myResult.caught, delta: s2.round.myResult.coinDelta });
  }
  const caughtCount = audited.filter((a) => a.caught).length;
  check('감사제: 집계의 적발 인원과 개인 결과가 일치',
    caughtCount === r3.villages[0].caughtCount, `${caughtCount}명`);
  check('감사제: 적발되면 +3-4 = -1', audited.every((a) => a.delta === (a.caught ? -1 : 3)));
  check('감사제: 적발 사실은 집계에 "인원 수"로만',
    typeof r3.villages[0].caughtCount === 'number'
    && !JSON.stringify(r3).includes('caught":true'));
  check('감사제: 진행자 화면에 누가 걸렸는지 없음',
    !all.some((p) => JSON.stringify(st).includes(p.token)));

  // 다른 학생 화면에 남의 적발이 새지 않는가
  const neighbour = (await ask(villages[0][0].sock, 'student:sync')).state;
  check('감사제: 남의 적발은 안 보인다',
    !villages[0].slice(1).some((p) => JSON.stringify(neighbour).includes(p.token)));

  // 적발은 40% 확률이라 한 라운드로는 안 나올 수 있다. 4라운드까지 이어 보고,
  // 그래도 0명이면 실패가 아니라 "이번 판에는 안 걸렸다"로 적는다.
  await goto('round4');
  await ask(host, 'host:round:start', KEY);
  for (const p of villages[0]) await ask(p.sock, 'student:choose', { choice: 'a' });
  for (const p of [...villages[1], ...villages[2], ...villages[3]]) {
    await ask(p.sock, 'student:choose', { choice: 'b' });
  }
  await ask(host, 'host:round:close', KEY);
  await wait(500);
  st = await state();
  const r4 = st.roundResults.round4.villages[0];
  const totalCaught = r3.villages[0].caughtCount + r4.caughtCount;

  if (totalCaught > 0) {
    check('감사제: 소켓 경로로도 실제 적발이 일어난다', true, `3·4라운드 합쳐 ${totalCaught}/8명`);
    const anyCaught = [];
    for (const p of villages[0]) {
      const s2 = (await ask(p.sock, 'student:sync')).state;
      anyCaught.push(s2.round.myResult.caught);
    }
    check('감사제: 적발 여부가 본인 화면에만 실린다',
      anyCaught.filter(Boolean).length === r4.caughtCount,
      `${anyCaught.filter(Boolean).length}명`);
  } else {
    console.log(`  ⚪ 감사제 적발 — 이번 판에는 8명 중 0명 (40% 확률, 약 1.7%로 일어남).`
      + ` 확정 검증은 smoke:engine 이 rng 를 고정해 합니다.`);
  }
}

// ------------------------------------------------------------------ 소감 벽
head('소감 벽 — 익명 · 100자 · 금칙어 · 하트');
{
  await goto('reflect');
  const me = all[0];

  const ok1 = await ask(me.sock, 'student:reflect', { text: '  들키지  않으면 괜찮을까,  계속 생각났어  ' });
  check('소감이 붙는다', Boolean(ok1.id), ok1.id);

  let st = await state();
  check('앞뒤·중복 공백이 정리된다',
    st.reflections[0].text === '들키지 않으면 괜찮을까, 계속 생각났어', JSON.stringify(st.reflections[0].text));
  check('카드에 작성자 정보가 없다',
    !('token' in st.reflections[0]) && !('nickname' in st.reflections[0]),
    Object.keys(st.reflections[0]).join(','));
  check('진행자 화면에도 작성자 없음', !all.some((p) => JSON.stringify(st.reflections).includes(p.token)));

  let tooLong = false;
  try { await ask(me.sock, 'student:reflect', { text: '가'.repeat(101) }); } catch { tooLong = true; }
  check('100자를 넘으면 거절', tooLong);

  let banned = false;
  let bannedMsg = '';
  try { await ask(all[1].sock, 'student:reflect', { text: '오늘 시발 재밌었다' }); }
  catch (e) { banned = true; bannedMsg = e.message; }
  check('금칙어는 거절', banned, bannedMsg);

  let spaced = false;
  try { await ask(all[1].sock, 'student:reflect', { text: '시 발' }); } catch { spaced = true; }
  check('사이에 공백을 넣어도 거절', spaced);

  let empty = false;
  try { await ask(all[1].sock, 'student:reflect', { text: '   ' }); } catch { empty = true; }
  check('빈 글은 거절', empty);

  // 도배 방지
  await ask(me.sock, 'student:reflect', { text: '두 번째 소감' });
  await ask(me.sock, 'student:reflect', { text: '세 번째 소감' });
  let capped = false;
  try { await ask(me.sock, 'student:reflect', { text: '네 번째 소감' }); } catch { capped = true; }
  check('한 사람이 3개까지', capped);

  // 하트
  const cardId = (await state()).reflections[0].id;
  const h1 = await ask(all[2].sock, 'student:heart', { id: cardId });
  check('하트가 올라간다', h1.hearts === 1 && h1.mine === true);
  const h2 = await ask(all[3].sock, 'student:heart', { id: cardId });
  check('여러 명이 누르면 쌓인다', h2.hearts === 2);
  const h3 = await ask(all[2].sock, 'student:heart', { id: cardId });
  check('다시 누르면 취소된다', h3.hearts === 1 && h3.mine === false);

  const view = (await ask(all[2].sock, 'student:sync')).state;
  check('내가 누른 하트는 나에게만', Array.isArray(view.myHearts));
  check('소감 벽은 모두에게 같은 내용', view.reflections.length === (await state()).reflections.length);
}

// ------------------------------------------------------------------ 서약
head('서약 — 인원 카운터');
{
  await goto('pledge');
  const first = await ask(all[0].sock, 'student:pledge', { on: true });
  check('서약하면 카운터가 올라간다', first.pledgeCount === 1, String(first.pledgeCount));

  const again = await ask(all[0].sock, 'student:pledge', { on: true });
  check('두 번 눌러도 한 번만 센다', again.pledgeCount === 1);

  for (let i = 1; i < 6; i++) await ask(all[i].sock, 'student:pledge', { on: true });
  let st = await state();
  check('여러 명이 서약', st.pledgeCount === 6, String(st.pledgeCount));

  const off = await ask(all[0].sock, 'student:pledge', { on: false });
  check('취소하면 줄어든다', off.pledgeCount === 5);

  const mine = await ask(all[1].sock, 'student:sync');
  check('내 서약 여부는 나에게', mine.state.myPledged === true);
  check('진행자에게는 인원 수만', typeof (await state()).pledgeCount === 'number');
}

// ------------------------------------------------------------------ 저장
head('스냅샷 — 개인 선택·투표·작성자가 남지 않는가');
{
  const st = await state();
  const snapshotish = JSON.stringify({
    council: st.council,
    reflections: st.reflections,
    pledgeCount: st.pledgeCount,
    roundResults: st.roundResults,
  });
  check('어디에도 참가자 토큰 없음', !all.some((p) => snapshotish.includes(p.token)));
  check('제도 투표는 득표수만', st.council.every((c) => typeof c.voted === 'number' && !('voters' in c)));
  check('소감은 글·하트수·시각만',
    st.reflections.every((r) => Object.keys(r).sort().join(',') === 'at,hearts,id,text'),
    Object.keys(st.reflections[0]).sort().join(','));
}

console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
for (const p of all) p.sock.disconnect();
host.disconnect();
process.exit(bad ? 1 : 0);
