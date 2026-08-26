// 학생 화면 — 입장, 익명 닉네임 확인, 단계별 화면, 그리고 절전·새로고침 복구.
//
// 복구 원칙: 이 화면은 아무것도 기억하지 않는다.
// localStorage 에 두는 것은 세션 코드와 무작위 토큰 두 개뿐이고,
// 닉네임·마을·코인·현재 단계는 매번 서버에서 새로 받아 온다.

import { $, showScreen, toast, el } from '../lib/dom.js';
import { socket, ask, mountConnectionBanner } from '../lib/net.js';
import { studentSave, studentLoad, studentClear } from '../lib/storage.js';
import { createScreen } from './screens.js';
import './wrapup.js';   // 마을회의 · 소감 · 서약 화면 등록

const ctx = { code: null, token: null, state: null, joining: false };

/** 서버와 맞춰 둔 값 (server/config.js · sockets/index.js) */
const REFLECTION_MAX_LEN = 100;
const REFLECTIONS_PER_STUDENT = 3;

const codeInput = $('#codeInput');
const joinBtn = $('#joinBtn');
const joinHelp = $('#joinHelp');

const HELP_DEFAULT = '칠판에 뜬 코드를 그대로 입력하세요.';

// ==================================================================
// 입장
// ==================================================================

const cleanCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

codeInput.addEventListener('input', () => {
  const cleaned = cleanCode(codeInput.value);
  if (codeInput.value !== cleaned) codeInput.value = cleaned;
  joinBtn.disabled = cleaned.length !== 6;
  joinHelp.classList.remove('error');
  joinHelp.textContent = HELP_DEFAULT;
});

codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !joinBtn.disabled) doJoin(codeInput.value);
});

joinBtn.addEventListener('click', () => doJoin(codeInput.value));

/**
 * 입장 또는 재입장.
 * @param {string} rawCode 6자리 코드
 * @param {string|null} token 있으면 같은 사람으로 되살아난다
 * @param {boolean} silent 자동 복구일 때는 조용히
 */
async function doJoin(rawCode, token = null, silent = false) {
  const code = cleanCode(rawCode);
  if (code.length !== 6 && !token) return;
  if (ctx.joining) return;
  ctx.joining = true;

  if (!silent) { joinBtn.disabled = true; joinBtn.textContent = '들어가는 중…'; }

  try {
    const res = await ask('student:join', { code, token });
    ctx.code = code;
    ctx.token = res.token;
    studentSave(code, res.token);
    applyState(res.state);
    if (res.returning && !silent) toast('돌아왔어요. 그대로 이어서 해요');
  } catch (err) {
    if (token) {
      // 저장된 토큰이 더 이상 통하지 않는다 — 처음부터 다시
      studentClear();
      ctx.token = null;
      ctx.code = null;
      showScreen('join');
      joinHelp.textContent = '이전 수업이 끝났어요. 코드를 새로 입력해 주세요.';
      joinHelp.classList.add('error');
    } else {
      joinHelp.textContent = err.message;
      joinHelp.classList.add('error');
      codeInput.select();
    }
  } finally {
    ctx.joining = false;
    joinBtn.textContent = '들어가기';
    joinBtn.disabled = cleanCode(codeInput.value).length !== 6;
  }
}

// ==================================================================
// 상태 반영
// ==================================================================

function applyState(state) {
  if (!state) return;
  ctx.state = state;
  const { me, village } = state;

  $('#meEmoji').textContent = me.emoji;
  $('#meNick').textContent = me.nickname;
  $('#barEmoji').textContent = me.emoji;
  $('#barNick').textContent = me.nickname;
  $('#barCoins').textContent = String(me.coins);
  $('#barStage').textContent = state.stage?.label || '';

  if (village) {
    $('#villageName').textContent = `${village.emoji} ${village.name}`;
    $('#villageSize').textContent = `${village.size}명`;
    $('#villageTrust').textContent = String(village.trust);
    $('#villageCard').style.background = village.color;
    const bar = $('#barVillage');
    bar.innerHTML = '';
    bar.append(
      el('span', { class: 'swatch', style: { background: village.color } }),
      document.createTextNode(village.name),
    );
  }

  if (state.stageId === 'lobby') {
    showScreen('lobby');
    screen?.cleanup?.();
    screen = null;
    $('#stageArea').dataset.kind = '';
  } else {
    showScreen('stage');
    renderStage(state);
  }

  keepAwake(state.round?.phase === 'running');
}

let screen = null;

function renderStage(state) {
  const area = $('#stageArea');
  const kind = state.stage?.kind || '';
  if (area.dataset.kind !== kind) {
    screen?.cleanup?.();
    area.innerHTML = '';
    area.dataset.kind = kind;
    screen = createScreen(kind, {
      onChoose: sendChoice,
      onPledge: sendPledge,
      onWarmupVote: sendWarmupVote,
      onCouncilVote: sendCouncilVote,
      onReflect: sendReflection,
      onHeart: sendHeart,
      onPledgeFinal: sendFinalPledge,
      maxLen: REFLECTION_MAX_LEN,
      maxPerStudent: REFLECTIONS_PER_STUDENT,
    });
    area.append(screen.root);
  }
  screen?.update?.(state);
}

// ==================================================================
// 학생이 하는 것
// ==================================================================

/** 비밀 선택 제출 — 서버가 돌려주는 건 "몇 명이 냈는지"뿐이다. */
async function sendChoice(choice) {
  try {
    await ask('student:choose', { choice });
    buzz();
  } catch (err) {
    toast(err.message, 'error');
    await resync();
  }
}

async function sendWarmupVote(questionId, optionIndex) {
  try {
    await ask('student:warmup', { questionId, optionIndex });
    buzz();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 청렴 서약제 (라운드 시작 전) */
async function sendPledge() {
  try {
    await ask('student:pledge:round');
    toast('서약했어. 지키면 코인 +1');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 마을회의 — 우리 마을 제도 투표. 마음은 바꿀 수 있다. */
async function sendCouncilVote(institutionId) {
  try {
    await ask('student:council', { institutionId });
    buzz();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 익명 소감. 화면은 성공/실패만 알면 되므로 예외를 값으로 돌려준다. */
async function sendReflection(text) {
  try {
    await ask('student:reflect', { text });
    buzz();
    // 내가 몇 장 썼는지는 화면이 바로 알아야 한다 (전체 상태를 기다리지 않고)
    if (ctx.state) ctx.state.myReflections = (ctx.state.myReflections || 0) + 1;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendHeart(id) {
  try {
    const res = await ask('student:heart', { id });
    buzz();
    if (ctx.state) {
      const mine = new Set(ctx.state.myHearts || []);
      if (res.mine) mine.add(id); else mine.delete(id);
      ctx.state.myHearts = [...mine];
      const card = ctx.state.reflections?.find((r) => r.id === id);
      if (card) card.hearts = res.hearts;
      screen?.update?.(ctx.state);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 마지막 서약 */
async function sendFinalPledge(on) {
  try {
    await ask('student:pledge', { on });
    if (on) buzz();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 손끝에 살짝 반응 — 사용자가 화면을 만진 뒤에만 (브라우저 정책) */
let touched = false;
document.addEventListener('pointerdown', () => { touched = true; }, { once: true, passive: true });
function buzz() {
  if (!touched) return;
  try { navigator.vibrate?.(18); } catch { /* 지원 안 하면 그만 */ }
}

// ==================================================================
// 서버에서 오는 것
// ==================================================================

socket.on('state', applyState);

socket.on('counts', ({ villageSizes }) => {
  const v = ctx.state?.me?.villageIndex;
  if (v == null || !villageSizes) return;
  $('#villageSize').textContent = `${villageSizes[v] ?? 0}명`;
});

/** 제출 인원 수만 오는 가벼운 갱신 (잠금 화면의 "n / m명 제출") */
socket.on('round:progress', (p) => {
  if (!ctx.state?.round || ctx.state.round.stageId !== p.stageId) return;
  ctx.state.round.submitted = p.submitted;
  ctx.state.round.total = p.total;
  screen?.update?.(ctx.state);
});

/** 투명 장부제 마을에만 오는 실시간 비율 (익명 집계) */
socket.on('ledger', (tally) => {
  if (!ctx.state?.round) return;
  ctx.state.round.ledger = tally;
  screen?.update?.(ctx.state);
});

/** 우리 마을 제도 득표수 (같은 마을에만 온다) */
socket.on('council:tally', (tally) => {
  if (!ctx.state) return;
  ctx.state.council = tally;
  screen?.update?.(ctx.state);
});

/** 소감 벽 — 새 카드와 하트 수만 오간다 */
socket.on('reflect:add', (card) => {
  if (!ctx.state) return;
  ctx.state.reflections = [...(ctx.state.reflections || []), card];
  screen?.update?.(ctx.state);
});

socket.on('reflect:heart', ({ id, hearts }) => {
  const card = ctx.state?.reflections?.find((r) => r.id === id);
  if (!card) return;
  card.hearts = hearts;
  screen?.update?.(ctx.state);
});

socket.on('pledge:count', ({ pledgeCount }) => {
  if (!ctx.state) return;
  ctx.state.pledgeCount = pledgeCount;
  screen?.update?.(ctx.state);
});

socket.on('replaced', () => {
  toast('다른 기기에서 접속했어요. 이 화면은 이제 쓰지 않아요.', 'error');
});

// ==================================================================
// 복구 — 폰이 자거나, 새로고침하거나, 와이파이가 끊겼다 돌아와도
// ==================================================================

/** 저장된 토큰으로 다시 들어간다. 실패하면 입장 화면으로. */
function rejoin(silent = true) {
  const saved = studentLoad();
  if (!saved?.code || !saved?.token) return;
  doJoin(saved.code, saved.token, silent);
}

/** 연결은 살아 있는데 화면만 뒤처졌을 때 — 상태만 새로 받는다. */
async function resync() {
  if (!ctx.token) return;
  try {
    const res = await ask('student:sync');
    applyState(res.state);
  } catch {
    rejoin();
  }
}

// (1) 소켓이 다시 붙으면 토큰으로 재입장 — 서버 재시작·와이파이 복귀를 함께 덮는다
mountConnectionBanner(() => { if (studentLoad()?.token) rejoin(); });

// (2) 화면을 다시 켰을 때
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !ctx.token) return;
  if (socket.connected) resync();
  else socket.connect();
});

// (3) iOS 사파리는 뒤로가기 캐시에서 페이지를 통째로 되살린다 — 소켓이 죽어 있을 수 있다
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (socket.connected) resync();
  else socket.connect();
});

// (4) 기기가 네트워크를 되찾았을 때
window.addEventListener('online', () => {
  if (!socket.connected) socket.connect();
});

/**
 * (5) 라운드 중에는 화면이 꺼지지 않게 붙잡아 둔다.
 * 지원하지 않는 브라우저에서는 조용히 넘어간다.
 */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx.state?.round?.phase === 'running') keepAwake(true);
});

// ==================================================================
// 시작
// ==================================================================

(function boot() {
  // QR 로 들어오면 ?c=CODE 가 붙어 있다
  const fromQr = cleanCode(new URLSearchParams(location.search).get('c'));
  const saved = studentLoad();

  // 주소창을 깨끗하게 — 새로고침해도 코드가 다시 붙지 않도록
  if (fromQr && history.replaceState) history.replaceState(null, '', location.pathname);

  if (saved?.code && saved?.token && (!fromQr || fromQr === saved.code)) {
    showScreen('join');
    joinHelp.textContent = '다시 들어가는 중…';
    doJoin(saved.code, saved.token, true);
    return;
  }

  showScreen('join');
  if (fromQr) {
    codeInput.value = fromQr;
    joinBtn.disabled = fromQr.length !== 6;
    if (fromQr.length === 6) doJoin(fromQr);
  }
})();
