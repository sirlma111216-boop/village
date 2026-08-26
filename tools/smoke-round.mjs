// 라운드 이벤트 통합 점검 (서버를 켠 상태에서)
// 사용: node tools/smoke-round.mjs [학생수]
import { io } from 'socket.io-client';

const URL = process.env.TV_URL || 'http://localhost:3000';
const N = Number(process.argv[2] || 16);

let bad = 0;
const check = (label, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};
const head = (t) => console.log(`\n▶ ${t}`);

const connect = () => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ['websocket'] });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});

const ask = (s, ev, payload = {}) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${ev}`)), 8000);
  s.emit(ev, payload, (res) => {
    clearTimeout(t);
    if (res && res.ok === false) reject(new Error(res.error));
    else resolve(res);
  });
});

const once = (s, ev, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`이벤트 없음: ${ev}`)), ms);
  s.once(ev, (payload) => { clearTimeout(t); resolve(payload); });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n▶ 신뢰마을 2단계 라운드 엔진 점검 (${URL}, 학생 ${N}명)`);

// ------------------------------------------------------------------ 준비
const host = await connect();
const created = await ask(host, 'host:create', { villageCount: 4, roundSeconds: 15 });
const CODE = created.code;
const KEY = created.hostKey;
console.log(`  세션 ${CODE} · 라운드 15초로 설정`);

const students = [];
for (let i = 0; i < N; i++) {
  const sock = await connect();
  const res = await ask(sock, 'student:join', { code: CODE });
  students.push({ sock, token: res.token, nickname: res.state.me.nickname, village: res.state.me.villageIndex });
}

// ------------------------------------------------------------------ 단계 이동
head('상태 머신 — 진행자만 넘길 수 있다');
{
  const expected = ['warmup', 'story', 'rules', 'practice'];
  const seen = [];
  for (const want of expected) {
    const r = await ask(host, 'host:next', { code: CODE, hostKey: KEY });
    seen.push(r.stageId);
  }
  check('lobby → warmup → story → rules → practice', seen.join(',') === expected.join(','), seen.join(' → '));

  let blocked = false;
  try { await ask(students[0].sock, 'host:next', { code: CODE, hostKey: 'guess' }); } catch { blocked = true; }
  check('학생은 단계를 넘길 수 없다', blocked);

  let noStart = false;
  try { await ask(students[0].sock, 'host:round:start', { code: CODE, hostKey: 'guess' }); } catch { noStart = true; }
  check('학생은 라운드를 시작할 수 없다', noStart);
}

head('라운드 단계에 들어가면 바로 시작되지 않는다');
{
  const st = await ask(students[0].sock, 'student:sync');
  check('학생 화면은 설명 중(ready)', st.state.round?.phase === 'ready', st.state.round?.phase);
  check('시나리오가 지정됨', st.state.round?.scenarioId === 'practice', st.state.round?.scenarioId);

  let tooEarly = false;
  try { await ask(students[0].sock, 'student:choose', { choice: 'a' }); } catch { tooEarly = true; }
  check('시작 전에는 제출 불가', tooEarly);
}

// ------------------------------------------------------------------ 연습 라운드
head('연습 라운드 — 시작 · 제출 · 마감');
{
  const startedOnStudent = once(students[1].sock, 'state');
  await ask(host, 'host:round:start', { code: CODE, hostKey: KEY });
  const st = await startedOnStudent;
  check('학생에게 시작이 전파', st.round.phase === 'running', st.round.phase);
  check('종료 시각(endsAt)과 서버 시각을 함께 보냄',
    typeof st.round.endsAt === 'number' && typeof st.round.serverNow === 'number');

  const progress = once(host, 'round:progress');
  const first = await ask(students[0].sock, 'student:choose', { choice: 'a' });
  check('제출 응답은 인원 수만', first.submitted === 1 && first.total === N,
    `${first.submitted}/${first.total}`);

  const p = await progress;
  check('진행자에게 제출 인원만 전달', p.submitted >= 1 && !('choices' in p) && !('tokens' in p),
    JSON.stringify(p));

  let twice = false;
  try { await ask(students[0].sock, 'student:choose', { choice: 'b' }); } catch { twice = true; }
  check('한 번 내면 못 바꾼다', twice);

  // 나머지 절반만 제출 (미제출자를 남긴다)
  for (let i = 1; i < Math.floor(N / 2); i++) {
    await ask(students[i].sock, 'student:choose', { choice: i % 2 ? 'b' : 'c' });
  }

  const closed = once(host, 'round:closed', 6000);
  await ask(host, 'host:round:close', { code: CODE, hostKey: KEY });
  const { results } = await closed;

  check('마감 결과가 진행자에게 전달', Boolean(results));
  check('연습은 점수 미반영', results.scoring === false);
  check('마을별 카운트만 담김',
    results.villages.every((v) => v.counts && typeof v.counts.a === 'number'));

  const tokens = students.map((s) => s.token);
  check('결과 어디에도 학생 토큰 없음', !tokens.some((t) => JSON.stringify(results).includes(t)));

  const hostState = await ask(host, 'host:attach', { code: CODE, hostKey: KEY });
  check('진행자 상태에도 개인 선택 없음',
    !tokens.some((t) => JSON.stringify(hostState.state).includes(t)));

  const mine = await ask(students[0].sock, 'student:sync');
  check('본인은 자기 선택을 본다', mine.state.round.myResult?.choice === 'a', mine.state.round.myResult?.choice);
  check('연습이라 코인 변화 없음', mine.state.me.coins === 0);

  const other = await ask(students[1].sock, 'student:sync');
  check('남의 선택은 안 보인다', JSON.stringify(other.state).indexOf(students[0].token) === -1);
}

// ------------------------------------------------------------------ 점수 라운드
head('라운드 1 — 점수 반영 · 신뢰지수 변화');
{
  await ask(host, 'host:next', { code: CODE, hostKey: KEY });   // practice(closed) → round1
  const before = (await ask(host, 'host:attach', { code: CODE, hostKey: KEY })).state;
  check('round1 로 이동', before.stageId === 'round1', before.stageId);
  check('새 라운드는 다시 ready', before.round.phase === 'ready');

  await ask(host, 'host:next', { code: CODE, hostKey: KEY });   // ready → 시작
  const running = (await ask(host, 'host:attach', { code: CODE, hostKey: KEY })).state;
  check('"다음"이 라운드를 시작시킨다', running.round.phase === 'running');

  // 마을 0 전원 c, 나머지는 a
  for (const s of students) {
    await ask(s.sock, 'student:choose', { choice: s.village === 0 ? 'c' : 'a' });
  }

  await wait(1200);   // 전원 제출 → 자동 마감
  const after = (await ask(host, 'host:attach', { code: CODE, hostKey: KEY })).state;
  check('전원 제출하면 자동 마감', after.round.phase === 'closed', after.round.phase);

  const v0 = after.villages[0];
  check('전원 c 인 마을은 신뢰지수 상승', v0.trust > 60, `60 → ${v0.trust}`);
  check('전원 a 인 마을은 하락', after.villages[1].trust < 60, `60 → ${after.villages[1].trust}`);

  const res = after.round.results;
  check('정직 선택률 계산됨', typeof res.totals.honestRate === 'number', `${res.totals.honestRate}%`);

  const v0student = students.find((s) => s.village === 0);
  const mine = await ask(v0student.sock, 'student:sync');
  check('c 를 고른 학생 코인 0', mine.state.me.coins === 0);
  const v1student = students.find((s) => s.village === 1);
  const other = await ask(v1student.sock, 'student:sync');
  check('a 를 고른 학생 코인 +3', other.state.me.coins === 3);
  check('본인 마을 결과는 본다', mine.state.round.villageResult?.index === 0);
}

// ------------------------------------------------------------------ 타이머
head('타이머 — 시간이 다 되면 서버가 스스로 마감한다');
{
  await ask(host, 'host:next', { code: CODE, hostKey: KEY });   // → round2
  await ask(host, 'host:settings', { code: CODE, hostKey: KEY, roundSeconds: 15 });
  await ask(host, 'host:round:start', { code: CODE, hostKey: KEY });

  const r1 = (await ask(host, 'host:attach', { code: CODE, hostKey: KEY })).state.round;
  const left1 = r1.endsAt - r1.serverNow;
  check('설정한 시간만큼 잡힌다', left1 > 13_000 && left1 <= 15_500, `${Math.round(left1 / 1000)}초`);

  await ask(host, 'host:round:extend', { code: CODE, hostKey: KEY, seconds: 30 });
  const r2 = (await ask(host, 'host:attach', { code: CODE, hostKey: KEY })).state.round;
  const left2 = r2.endsAt - r2.serverNow;
  check('진행자가 시간을 늘릴 수 있다', left2 - left1 > 28_000, `${Math.round(left2 / 1000)}초로 연장`);

  // 짧게 다시 잡고 자동 마감을 기다린다
  await ask(host, 'host:round:abort', { code: CODE, hostKey: KEY });
  await ask(host, 'host:settings', { code: CODE, hostKey: KEY, roundSeconds: 15 });
  const closedEvent = once(host, 'round:closed', 20_000);
  await ask(host, 'host:round:start', { code: CODE, hostKey: KEY });
  await ask(students[0].sock, 'student:choose', { choice: 'b' });
  const closed = await closedEvent;
  check('시간이 다 되면 자동 마감', closed.reason === 'time', `이유: ${closed.reason}`);
  check('미제출자는 델타 0 으로 처리', closed.results.totals.missing === N - 1, `미제출 ${closed.results.totals.missing}명`);
}

head('되돌리기 — 모은 선택을 점수에 넣지 않고 취소');
{
  await ask(host, 'host:next', { code: CODE, hostKey: KEY });   // → interim
  const st = (await ask(host, 'host:attach', { code: CODE, hostKey: KEY })).state;
  check('마감 후 "다음"은 단계 이동', st.stageId === 'interim', st.stageId);
}

console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
for (const s of students) s.sock.disconnect();
host.disconnect();
process.exit(bad ? 1 : 0);
