// 1단계 통합 점검: 세션 생성 → 학생 다수 입장 → 마을 배정 → 재접속 → 진행자 복구
// 사용: (서버를 켠 뒤) node tools/smoke-flow.mjs [학생수]
import { io } from 'socket.io-client';

const URL = process.env.TV_URL || 'http://localhost:3000';
const N = Number(process.argv[2] || 24);

const connect = () => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ['websocket'] });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});

const ask = (s, ev, payload = {}) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${ev}`)), 6000);
  s.emit(ev, payload, (res) => {
    clearTimeout(t);
    if (res && res.ok === false) reject(new Error(res.error));
    else resolve(res);
  });
});

const ok = (label, pass, extra = '') =>
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}${extra ? ' — ' + extra : ''}`);

let failures = 0;
const check = (label, pass, extra) => { if (!pass) failures++; ok(label, pass, extra); };

console.log(`\n▶ 신뢰마을 1단계 점검 (${URL}, 학생 ${N}명)\n`);

// --- 진행자 세션 생성
const host = await connect();
const created = await ask(host, 'host:create', { villageCount: 4, roundSeconds: 60 });
check('세션 생성', /^[A-Z0-9]{6}$/.test(created.code), `코드 ${created.code}`);
check('QR 생성(로컬)', String(created.join.qr).startsWith('data:image/png;base64,'));
check('접속 주소 감지', Boolean(created.join.url), created.join.url);
check('진행자 열쇠 발급', Boolean(created.hostKey));

const CODE = created.code;
const KEY = created.hostKey;

// --- 학생 입장
const students = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const s = await connect();
  const res = await ask(s, 'student:join', { code: CODE });
  students.push({ sock: s, token: res.token, state: res.state });
}
console.log(`  ⏱  ${N}명 입장에 ${Date.now() - t0}ms`);

const nicks = new Set(students.map((s) => s.state.me.nickname));
check('닉네임 중복 없음', nicks.size === N, `${nicks.size}/${N}`);
check('개인정보 필드 없음', students.every((s) => !('name' in s.state.me) && !('id' in s.state.me)));

// --- 마을 배정 균등성
const hostState = (await ask(host, 'host:attach', { code: CODE, hostKey: KEY })).state;
const sizes = hostState.villages.map((v) => v.size);
check('마을 골고루 배정', Math.max(...sizes) - Math.min(...sizes) <= 1, `[${sizes.join(', ')}]`);
check('인원 합계 일치', sizes.reduce((a, b) => a + b, 0) === N);
check('신뢰지수 시작 60', hostState.villages.every((v) => v.trust === 60));
check('진행자 상태에 개인 선택 없음', !JSON.stringify(hostState).includes('secretChoices'));

// --- 코드 정규화 (소문자·공백·하이픈)
const sloppy = await connect();
const sloppyRes = await ask(sloppy, 'student:join', { code: ` ${CODE.toLowerCase()} ` });
check('지저분한 코드 입력 허용', Boolean(sloppyRes.token));
sloppy.disconnect();

// --- 잘못된 코드
let rejected = false;
const bad = await connect();
try { await ask(bad, 'student:join', { code: 'ZZZZZZ' }); } catch { rejected = true; }
check('없는 코드는 거절', rejected);
bad.disconnect();

// --- 진행자 권한
let blocked = false;
const impostor = await connect();
try { await ask(impostor, 'host:next', { code: CODE, hostKey: 'nope' }); } catch { blocked = true; }
check('열쇠 없는 진행 조작 차단', blocked);
impostor.disconnect();

// --- 재접속 복구 (같은 닉네임·마을)
const victim = students[0];
const before = victim.state.me;
victim.sock.disconnect();
await new Promise((r) => setTimeout(r, 300));
const again = await connect();
const back = await ask(again, 'student:join', { code: CODE, token: victim.token });
check('재접속 시 같은 닉네임', back.state.me.nickname === before.nickname, back.state.me.nickname);
check('재접속 시 같은 마을', back.state.me.villageIndex === before.villageIndex);
check('재접속임을 인지', back.returning === true);
victim.sock = again;

// --- 단계 진행
const advanced = await ask(host, 'host:next', { code: CODE, hostKey: KEY });
check('단계 전진', advanced.stageId === 'warmup', advanced.stageId);
const gotStage = await new Promise((resolve) => {
  students[1].sock.once('state', resolve);
  ask(host, 'host:next', { code: CODE, hostKey: KEY });
});
check('학생에게 단계 전파', gotStage.stageId === 'story', gotStage.stageId);

// --- 마을 수 변경은 대기 중에만
let settingsBlocked = false;
try { await ask(host, 'host:settings', { code: CODE, hostKey: KEY, villageCount: 6 }); }
catch { settingsBlocked = true; }
check('진행 중 마을 수 변경 차단', settingsBlocked);

console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}\n`);

for (const s of students) s.sock.disconnect();
host.disconnect();
process.exit(failures ? 1 : 0);
