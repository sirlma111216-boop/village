// 4단계 점검 (서버를 켠 상태에서): 학생 화면이 기대는 서버 계약과 복구 경로
// 사용: node tools/smoke-student.mjs
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

console.log(`\n▶ 신뢰마을 4단계 학생 화면 점검 (${URL})`);

const host = await connect();
const created = await ask(host, 'host:create', { villageCount: 4, roundSeconds: 120 });
const KEY = { code: created.code, hostKey: created.hostKey };
const CODE = created.code;
console.log(`  세션 ${CODE}`);

// 미제출자를 남겨 두어 라운드가 자동 마감되지 않게 한다
const filler = [];
for (let i = 0; i < 5; i++) {
  const s = await connect();
  await ask(s, 'student:join', { code: CODE });
  filler.push(s);
}

// ------------------------------------------------------------------ 입장
head('입장 — 코드 6자리만으로');
let me = await connect();
let joined = await ask(me, 'student:join', { code: CODE });
const TOKEN = joined.token;
const NICK = joined.state.me.nickname;
const VILLAGE = joined.state.me.villageIndex;

check('닉네임을 서버가 지어 준다', /\S+ \S+/.test(NICK), NICK);
check('마을이 배정된다', Number.isInteger(VILLAGE));
check('개인정보 필드가 없다',
  !('name' in joined.state.me) && !('id' in joined.state.me) && !('token' in joined.state.me));
check('재접속용 토큰을 받는다', typeof TOKEN === 'string' && TOKEN.length > 10);
check('내 마을 정보가 온다', joined.state.village?.name && joined.state.village?.color);
check('다른 마을은 이름·신뢰지수까지만', joined.state.villages.every((v) => !('members' in v)));

let rejected = false;
try {
  const bad2 = await connect();
  await ask(bad2, 'student:join', { code: 'ZZZZZZ' });
  bad2.disconnect();
} catch { rejected = true; }
check('없는 코드는 거절', rejected);

// ------------------------------------------------------------------ 단계별 화면 재료
head('단계마다 화면이 그릴 재료가 온다');
{
  await ask(host, 'host:next', KEY);   // warmup
  let st = (await ask(me, 'student:sync')).state;
  check('워밍업: 집계와 내 표가 분리돼 온다',
    st.warmup !== undefined && st.myWarmup !== undefined);

  await ask(me, 'student:warmup', { questionId: 'w1', optionIndex: 1 });
  st = (await ask(me, 'student:sync')).state;
  check('내 표는 나에게만', st.myWarmup.w1 === 1);
  check('집계는 카운트만', typeof (st.warmup.w1?.[1]) === 'number');

  for (const [stage, need] of [['story', 'stage'], ['rules', 'stage'], ['practice', 'round']]) {
    await ask(host, 'host:next', KEY);
    st = (await ask(me, 'student:sync')).state;
    check(`${stage}: ${need} 정보 도착`,
      need === 'round' ? Boolean(st.round) : Boolean(st.stage?.kind), st.stage?.kind);
  }
}

// ------------------------------------------------------------------ 라운드
head('라운드 — 선택 · 잠금 · 결과');
{
  await ask(host, 'host:round:start', KEY);
  let st = (await ask(me, 'student:sync')).state;
  check('시작하면 선택할 수 있다', st.round.phase === 'running' && st.round.mySubmitted === false);

  const res = await ask(me, 'student:choose', { choice: 'c' });
  check('제출 응답은 인원 수만', typeof res.submitted === 'number' && !('choices' in res));

  st = (await ask(me, 'student:sync')).state;
  check('잠금 화면 재료: 제출했음', st.round.mySubmitted === true);
  check('잠금 화면 재료: 내 선택은 나에게만', st.round.myChoice === 'c');
  check('잠금 화면 재료: 제출 인원 수', typeof st.round.submitted === 'number' && typeof st.round.total === 'number',
    `${st.round.submitted}/${st.round.total}`);

  let twice = false;
  try { await ask(me, 'student:choose', { choice: 'a' }); } catch { twice = true; }
  check('한 번 내면 바꿀 수 없다', twice);

  await ask(host, 'host:round:close', KEY);
  await wait(400);
  st = (await ask(me, 'student:sync')).state;
  check('결과: 내 선택이 나에게만 보인다', st.round.myResult?.choice === 'c');
  check('결과: 내 코인 변화', typeof st.round.myResult.coinDelta === 'number', String(st.round.myResult.coinDelta));
  check('결과: 우리 마을 변화', typeof st.round.villageResult?.trustDelta === 'number',
    `${st.round.villageResult.trustBefore} → ${st.round.villageResult.trustAfter}`);
  check('결과: 우리 마을 선택 분포(카운트만)',
    st.round.villageResult.counts && typeof st.round.villageResult.counts.a === 'number');
}

// ------------------------------------------------------------------ 복구
head('복구 (1) — 새로고침: 토큰만으로 그대로 되살아난다');
{
  me.disconnect();
  await wait(300);
  me = await connect();
  const back = await ask(me, 'student:join', { code: CODE, token: TOKEN });
  check('같은 닉네임', back.state.me.nickname === NICK, back.state.me.nickname);
  check('같은 마을', back.state.me.villageIndex === VILLAGE);
  check('같은 코인', back.state.me.coins === 0);
  check('같은 단계', back.state.stageId === 'practice', back.state.stageId);
  check('재접속으로 인식', back.returning === true);
  check('내 결과도 그대로', back.state.round.myResult?.choice === 'c');
}

head('복구 (2) — 절전에서 깨어남: 연결만 살리고 상태를 다시 받는다');
{
  const st = (await ask(me, 'student:sync')).state;
  check('sync 한 번으로 전체 상태', Boolean(st.me && st.village && st.stage));
  check('sync 에도 남의 선택은 없다', !JSON.stringify(st).includes('"players"'));
}

head('복구 (3) — 늦게 들어온 학생은 진행 중인 단계에 바로 합류');
{
  await ask(host, 'host:next', KEY);          // round1
  await ask(host, 'host:round:start', KEY);
  const late = await connect();
  const res = await ask(late, 'student:join', { code: CODE });
  check('바로 라운드 화면 재료를 받는다', res.state.round?.phase === 'running', res.state.round?.phase);
  check('시나리오도 함께', res.state.round.scenarioId === 'r1', res.state.round.scenarioId);
  check('아직 제출 안 한 상태', res.state.round.mySubmitted === false);
  late.disconnect();
}

head('복구 (4) — 다른 기기로 들어가면 이전 화면은 물러난다');
{
  const other = await connect();
  const replaced = new Promise((r) => me.once('replaced', () => r(true)));
  await ask(other, 'student:join', { code: CODE, token: TOKEN });
  const gotIt = await Promise.race([replaced, wait(1500).then(() => false)]);
  check('이전 소켓에 알림이 간다', gotIt === true);
  me.disconnect();
  me = other;
}

head('복구 (5) — 수업이 끝난 뒤의 옛 토큰');
{
  const zombie = await connect();
  let cleared = false;
  try { await ask(zombie, 'student:join', { code: 'AAAAAA', token: TOKEN }); }
  catch { cleared = true; }
  check('없는 세션이면 거절 (화면은 입장으로 되돌아간다)', cleared);
  zombie.disconnect();
}

console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
for (const s of filler) s.disconnect();
me.disconnect();
host.disconnect();
process.exit(bad ? 1 : 0);
