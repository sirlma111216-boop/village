// 서버 재시작 복구 점검: 스냅샷의 학생 토큰으로 다시 붙어 같은 닉네임/마을인지 본다.
// 사용: node tools/smoke-restore.mjs
import fs from 'node:fs';
import path from 'node:path';
import { io } from 'socket.io-client';

const URL = process.env.TV_URL || 'http://localhost:3000';
const dir = path.resolve('data/sessions');
const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
if (!file) { console.log('❌ 스냅샷이 없습니다.'); process.exit(1); }

const snap = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const player = snap.players[0];
console.log(`\n▶ 복구 점검: ${snap.code} / 저장된 학생 ${snap.players.length}명\n`);

const s = io(URL, { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));

const res = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 6000);
  s.emit('student:join', { code: snap.code, token: player.token }, (r) => { clearTimeout(t); resolve(r); });
});

let bad = 0;
const check = (label, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};

check('재시작 후 입장 성공', res.ok !== false);
check('닉네임 유지', res.state?.me.nickname === player.nickname, res.state?.me.nickname);
check('마을 유지', res.state?.me.villageIndex === player.villageIndex);
check('코인 유지', res.state?.me.coins === player.coins);
check('진행 단계 유지', res.state?.stageId === snap.stageId, res.state?.stageId);
check('재접속으로 인식', res.returning === true);

console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
s.disconnect();
process.exit(bad ? 1 : 0);
