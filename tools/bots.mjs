// 데모 학생 봇 — 혼자 화면을 확인하거나 수업 전 리허설을 할 때 씁니다.
// 라운드가 열리면 알아서 하나를 고르고, 서약제 마을이면 서약도 합니다.
//
//   node tools/bots.mjs <코드> [인원] [--honest 0.6] [--delay 4]
//
//   --honest  b/c(정직한 선택)를 고를 확률 (기본 0.55)
//   --delay   라운드가 열린 뒤 제출까지 기다리는 최대 초 (기본 6)
//   Ctrl+C 로 종료.

import { io } from 'socket.io-client';

const URL = process.env.TV_URL || 'http://localhost:3000';
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const code = (positional[0] || '').toUpperCase();
const count = Number(positional[1] || 8);
const honestRate = flag('honest', 0.55);
const maxDelay = flag('delay', 6);

if (!code) {
  console.log('사용법: node tools/bots.mjs <코드> [인원] [--honest 0.6] [--delay 4]');
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (s, ev, payload = {}) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 6000);
  s.emit(ev, payload, (res) => { clearTimeout(t); resolve(res); });
});

/** 봇마다 성향이 조금씩 다르게 — 화면이 단조롭지 않도록 */
function pickChoice(bias) {
  if (Math.random() > bias) return 'a';
  return Math.random() < 0.68 ? 'b' : 'c';
}

const warmupQuestions = ['w1', 'w2'];
const INSTITUTIONS = ['ledger', 'audit', 'pledge'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 데모용 소감 문장 — 실제 수업에서는 학생이 직접 씁니다 */
const REFLECTIONS = [
  '들키지 않으면 괜찮을까, 계속 생각났어',
  '우리 마을 신뢰가 떨어질 때 마음이 이상했다',
  '몰래 이득을 골랐는데 아무도 몰라서 더 찝찝했어',
  '감사제가 있으니까 한 번 더 생각하게 됐다',
  '솔직히 코인이 탐났다',
  '용기 내어 알리기는 생각보다 어려웠어',
  '규칙대로 한 사람들이 손해 보는 것 같아서 속상했다',
  '내 선택이 마을 전체를 바꾼다는 게 신기했다',
  '아무도 안 볼 때가 제일 어려웠다',
  '다음엔 처음부터 정직하게 할래',
];
const bots = [];
let live = 0;

for (let i = 0; i < count; i++) {
  const sock = io(URL, { transports: ['websocket'] });
  await new Promise((r) => sock.on('connect', r));
  const res = await ask(sock, 'student:join', { code });
  if (!res?.ok) {
    console.log('  ❌', res?.error || '입장 실패');
    sock.disconnect();
    continue;
  }

  const bot = {
    sock,
    token: res.token,
    nickname: res.state.me.nickname,
    bias: Math.max(0.05, Math.min(0.95, honestRate + (Math.random() - 0.5) * 0.5)),
    // 마을마다 다른 제도가 뽑히도록 마을 번호로 성향을 갈라 둔다 (30%는 딴 데 던진다)
    institutionBias: INSTITUTIONS[(res.state.me.villageIndex + (Math.random() < 0.7 ? 0 : 1)) % 3],
    doneStage: null,
    pledgedStage: null,
  };
  bots.push(bot);
  live++;
  console.log(`  ${res.state.me.emoji} ${bot.nickname} → ${res.state.village.name}`);

  sock.on('state', (state) => onState(bot, state));

  // 서버가 다시 뜨거나 연결이 끊겼다 붙으면 토큰으로 다시 들어간다.
  // (실제 학생 화면도 똑같이 동작한다 — 이게 없으면 서버에 "접속 중"으로 잡히지 않는다)
  sock.on('connect', async () => {
    const again = await ask(sock, 'student:join', { code, token: bot.token });
    if (again?.ok) {
      bot.doneStage = null;
      onState(bot, again.state);
    }
  });

  onState(bot, res.state);
}

async function onState(bot, state) {
  // 워밍업 투표도 흉내 낸다 (화면 확인용)
  if (state.stageId === 'warmup' && !bot.warmedUp) {
    bot.warmedUp = true;
    for (const qid of warmupQuestions) {
      await wait(300 + Math.random() * 2500);
      await ask(bot.sock, 'student:warmup', { questionId: qid, optionIndex: Math.floor(Math.random() * 3) });
    }
  }

  // 마을회의 — 마을마다 다른 제도가 뽑히도록 성향을 조금씩 갈라 둔다
  if (state.stageId === 'council' && !bot.councilVoted) {
    bot.councilVoted = true;
    await wait(600 + Math.random() * 4000);
    await ask(bot.sock, 'student:council', { institutionId: bot.institutionBias });
  }

  // 소감 벽
  if (state.stageId === 'reflect' && !bot.reflected) {
    bot.reflected = true;
    await wait(1000 + Math.random() * 6000);
    await ask(bot.sock, 'student:reflect', { text: pick(REFLECTIONS) });
    // 다른 사람 소감에 하트도 눌러 본다
    await wait(1200 + Math.random() * 3000);
    const cards = (await ask(bot.sock, 'student:sync'))?.state?.reflections || [];
    for (const c of cards) {
      if (Math.random() < 0.35) await ask(bot.sock, 'student:heart', { id: c.id });
    }
  }

  // 서약
  if (state.stageId === 'pledge' && !bot.pledgedFinal) {
    bot.pledgedFinal = true;
    await wait(800 + Math.random() * 5000);
    if (Math.random() < 0.85) await ask(bot.sock, 'student:pledge', { on: true });
  }

  const r = state.round;
  if (!r) return;

  // 서약제 마을이면 라운드 시작 전에 서약해 둔다
  if (r.phase === 'ready' && r.institution === 'pledge'
      && bot.pledgedStage !== r.stageId && Math.random() < 0.7) {
    bot.pledgedStage = r.stageId;
    await ask(bot.sock, 'student:pledge:round');
  }

  if (r.phase !== 'running' || r.mySubmitted || bot.doneStage === r.stageId) return;
  bot.doneStage = r.stageId;

  // 다 같이 동시에 누르지 않도록 조금씩 흩뜨린다
  await wait(400 + Math.random() * maxDelay * 1000);
  const res = await ask(bot.sock, 'student:choose', { choice: pickChoice(bot.bias) });
  if (!res?.ok && res?.error) bot.doneStage = null;   // 아직 안 열렸으면 다음 기회에
}

console.log(`\n봇 ${live}명 접속 중 — 라운드가 열리면 알아서 제출합니다. Ctrl+C 로 종료.`);

process.on('SIGINT', () => {
  for (const b of bots) b.sock.disconnect();
  console.log('\n봇을 내보냈습니다.');
  process.exit(0);
});
