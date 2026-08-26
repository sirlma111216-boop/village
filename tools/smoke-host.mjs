// 3단계 점검 (서버를 켠 상태에서): 단계 진행 · 워밍업 집계 · 최종 발표 공개 순서 · CSV
// 사용: node tools/smoke-host.mjs [학생수]
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
const ask = (s, ev, p = {}) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${ev}`)), 8000);
  s.emit(ev, p, (res) => {
    clearTimeout(t);
    if (res && res.ok === false) reject(new Error(res.error));
    else resolve(res);
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n▶ 신뢰마을 3단계 진행자 화면 점검 (${URL}, 학생 ${N}명)`);

const host = await connect();
const created = await ask(host, 'host:create', { villageCount: 4, roundSeconds: 15 });
const KEY = { code: created.code, hostKey: created.hostKey };
console.log(`  세션 ${created.code}`);

const students = [];
for (let i = 0; i < N; i++) {
  const sock = await connect();
  const res = await ask(sock, 'student:join', { code: created.code });
  students.push({ sock, token: res.token, village: res.state.me.villageIndex });
}

const state = async () => (await ask(host, 'host:attach', KEY)).state;

// ------------------------------------------------------------------ 단계
head('상태 머신 — 15단계가 순서대로');
{
  const st = await state();
  check('단계 수 15', st.stageCount === 15, String(st.stageCount));
  check('현재 단계 번호 제공', st.stageIndex === 0);
  check('접속 인원 제공', st.connectedCount === N, `${st.connectedCount}/${N}`);
}

// ------------------------------------------------------------------ 워밍업
head('워밍업 — 폰에서 투표, 화면에 집계');
{
  await ask(host, 'host:next', KEY);
  check('워밍업 단계', (await state()).stageId === 'warmup');

  for (let i = 0; i < students.length; i++) {
    await ask(students[i].sock, 'student:warmup', { questionId: 'w1', optionIndex: i % 3 });
  }
  await wait(500);
  const st = await state();
  const tally = st.warmup.w1 || {};
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  check('표가 집계된다', total === N, `${total}표`);
  check('집계에 개인 정보 없음',
    !students.some((s) => JSON.stringify(st.warmup).includes(s.token)));

  // 마음 바꾸기
  await ask(students[0].sock, 'student:warmup', { questionId: 'w1', optionIndex: 2 });
  await wait(400);
  const after = (await state()).warmup.w1;
  check('바꿔도 표 총합은 그대로',
    Object.values(after).reduce((a, b) => a + b, 0) === N,
    JSON.stringify(after));

  const mine = await ask(students[0].sock, 'student:sync');
  check('본인 선택은 본인에게만', mine.state.myWarmup.w1 === 2);

  let blocked = false;
  await ask(host, 'host:next', KEY);   // → story
  try { await ask(students[1].sock, 'student:warmup', { questionId: 'w1', optionIndex: 0 }); }
  catch { blocked = true; }
  check('워밍업 단계가 아니면 투표 거부', blocked);
}

// ------------------------------------------------------------------ 라운드 4개
head('라운드 4개를 돌려 발표 데이터를 만든다');
{
  await ask(host, 'host:next', KEY);   // rules
  await ask(host, 'host:next', KEY);   // practice
  for (const stage of ['practice', 'round1', 'round2']) {
    await ask(host, 'host:round:start', KEY);
    for (const s of students) {
      await ask(s.sock, 'student:choose', { choice: s.village === 0 ? 'a' : ['b', 'c'][s.village % 2] });
    }
    await wait(900);
    if (stage === 'round2') break;
    await ask(host, 'host:next', KEY);
  }
  await ask(host, 'host:next', KEY);   // interim
  check('중간 집계 도달', (await state()).stageId === 'interim');

  await ask(host, 'host:next', KEY);   // council
  await ask(host, 'host:next', KEY);   // round3
  for (const stage of ['round3', 'round4']) {
    await ask(host, 'host:round:start', KEY);
    for (const s of students) await ask(s.sock, 'student:choose', { choice: s.village === 0 ? 'a' : 'c' });
    await wait(900);
    await ask(host, 'host:next', KEY);
  }
  check('최종 발표 도달', (await state()).stageId === 'reveal');
}

// ------------------------------------------------------------------ 발표
head('최종 발표 — 버튼을 누를 때마다 한 장씩');
{
  let st = await state();
  check('처음엔 아무것도 공개 안 됨', st.revealStep === 0);
  check('개인 코인 TOP3 준비됨', st.reveal.coinTop.length === 3, `${st.reveal.coinTop.length}명`);
  check('TOP3 는 익명 별명만',
    st.reveal.coinTop.every((r) => r.nickname && !('token' in r) && !('name' in r)));
  check('마을별 코인 준비됨', st.reveal.villageCoins.length === 4);
  check('라운드별 정직 선택률 준비됨', st.reveal.honestByRound.length === 4,
    st.reveal.honestByRound.map((r) => `${r.label}:${r.honestRate}%`).join(' '));

  const seen = [];
  for (let i = 1; i <= 4; i++) {
    await ask(host, 'host:next', { ...KEY, revealMax: 4 });
    seen.push((await state()).revealStep);
  }
  check('네 번 눌러 네 장이 열린다', seen.join(',') === '1,2,3,4', seen.join(' → '));

  st = await state();
  check('네 장 다 열리면 그 다음은 단계 이동', st.stageId === 'reveal');
  await ask(host, 'host:next', { ...KEY, revealMax: 4 });
  check('소감 단계로 넘어감', (await state()).stageId === 'reflect');

  await ask(host, 'host:reveal:back', KEY);
  check('한 장 되돌리기', (await state()).revealStep === 3);
}

// ------------------------------------------------------------------ 새로고침 복구
head('진행자 새로고침 — 서버 상태로 완전 복원');
{
  const fresh = await connect();
  const res = await ask(fresh, 'host:attach', KEY);
  check('다른 창에서도 같은 상태', res.state.stageId === 'reflect');
  check('공개 단계도 복원', res.state.revealStep === 3);
  check('QR·주소 다시 제공', String(res.join.qr).startsWith('data:image/png;base64,'));
  fresh.disconnect();
}

// ------------------------------------------------------------------ CSV
head('결과 CSV — 개인 식별 없는 집계만');
{
  const r = await fetch(`${URL}/api/session/${created.code}/results.csv`);
  // fetch 의 text() 는 선행 BOM 을 떼어 내므로, BOM 확인은 원본 바이트로 한다
  const bytes = new Uint8Array(await r.clone().arrayBuffer());
  const text = await r.text();
  check('내려받기 가능', r.ok);
  check('머리글 있음', text.includes('구분,라운드,마을'));
  check('라운드 집계 들어감', /라운드,1,/.test(text));
  check('개인 선택·토큰 없음',
    !students.some((s) => text.includes(s.token)) && !/choice/i.test(text));
  check('엑셀용 BOM (원본 바이트 EF BB BF)',
    bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
    [...bytes.slice(0, 3)].map((b) => b.toString(16).toUpperCase()).join(' '));
}

console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
for (const s of students) s.sock.disconnect();
host.disconnect();
process.exit(bad ? 1 : 0);
