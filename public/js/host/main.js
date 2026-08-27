// 진행자 화면 — 서버 상태를 받아 그리기만 한다. 판단은 전부 서버가 한다.

import { $, $$, showScreen, toast, el } from '../lib/dom.js';
import { socket, ask, connectTo, mountConnectionBanner } from '../lib/net.js';
import { hostSave, hostLoad, hostClear } from '../lib/storage.js';
import { renderStage } from './render.js';
import './stages.js';    // 입장 대기 · 워밍업 · 스토리 · 규칙
import './round.js';     // 라운드
import { REVEAL_MAX, REVEAL_TITLES } from './results.js';   // 집계 · 발표 · 소감 · 서약 · 마무리

const ctx = {
  code: null,
  hostKey: null,
  join: null,
  state: null,
  stages: [],
  /** 단계 화면이 진행자 권한으로 서버에 요청할 때 쓰는 통로 */
  send: (event, payload = {}) =>
    ask(event, { ...payload, code: ctx.code, hostKey: ctx.hostKey })
      .catch((err) => toast(err.message, 'error')),
};

// ------------------------------------------------------------------ 수업 만들기

function wireToggle(id, initial) {
  const root = $(`#${id}`);
  let value = initial;
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('.toggle-tab');
    if (!tab) return;
    $$('.toggle-tab', root).forEach((t) => t.classList.toggle('is-on', t === tab));
    value = Number(tab.dataset.value);
  });
  return () => value;
}

const getVillageCount = wireToggle('villageChooser', 4);
const getRoundSeconds = wireToggle('secondsChooser', 60);
const getDemoCount = wireToggle('demoChooser', 0);

$('#createBtn').addEventListener('click', async () => {
  const btn = $('#createBtn');
  btn.disabled = true;
  try {
    // 수업 코드를 먼저 받는다 — 서버에서 수업 하나가 독립된 방 하나라 코드가 있어야 붙는다
    const { code } = await (await fetch('/api/new-code')).json();
    connectTo(code);
    const res = await ask('host:create', {
      code,
      villageCount: getVillageCount(),
      roundSeconds: getRoundSeconds(),
    });
    ctx.code = res.code;
    ctx.hostKey = res.hostKey;
    ctx.join = res.join;
    hostSave(res.code, res.hostKey);
    showScreen('run');
    applyState(res.state);
    // 설정에서 데모 봇을 골랐으면 바로 불러들인다
    const demo = getDemoCount();
    if (demo > 0) ctx.send('host:demo', { on: true, count: demo });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#newSessionBtn').addEventListener('click', () => {
  if (!confirm('지금 수업을 두고 새 수업을 시작할까요?\n진행 중이던 수업은 서버에 그대로 남습니다.')) return;
  hostClear();
  ctx.code = null;
  ctx.hostKey = null;
  ctx.state = null;
  showScreen('setup');
});

// ------------------------------------------------------------------ 진행

function applyState(state) {
  ctx.state = state;
  $('#topCode').textContent = state.code;
  $('#topCount').textContent = String(state.connectedCount);
  renderDemo(state);
  $('#csvBtn').href = `/api/session/${state.code}/results.csv`;
  $('#csvBtn').setAttribute('download', `신뢰마을-${state.code}.csv`);

  $('#stageNum').textContent = String(state.stageIndex + 1).padStart(2, '0');
  $('#stageTotal').textContent = String(state.stageCount).padStart(2, '0');
  $('#stageLabel').textContent = state.stage?.label || '';
  $('#stageNext').textContent = nextHint(state);

  $('#prevBtn').disabled = state.stageIndex <= 0;
  $('#nextBtn').disabled = isLastAction(state);
  $('#nextBtn').textContent = nextLabel(state);

  renderTrack(state);
  renderStage($('#stageArea'), state, ctx);
}

/** 데모 봇 상태 표시와 스위치 */
function renderDemo(state) {
  const on = Boolean(state.demo?.on);
  const count = state.demo?.count || 0;
  $('#demoFlag').classList.toggle('hidden', !on || !count);
  $('#demoCount').textContent = String(count);
  $('#demoBtn').textContent = on ? '데모 끄기' : '데모 봇';
  $('#demoBtn').classList.toggle('is-on', on);
}

$('#demoBtn').addEventListener('click', () => {
  const on = Boolean(ctx.state?.demo?.on);
  if (on) {
    if (!confirm('데모 봇을 모두 내보낼까요?\n가상 학생이 남긴 선택·소감·서약도 함께 사라집니다.')) return;
    ctx.send('host:demo', { on: false });
  } else {
    ctx.send('host:demo', { on: true, count: 28 });
    toast('가상 학생 28명이 들어옵니다');
  }
});

/** "다음"이 지금 무엇을 하는지 — 라운드와 발표에서는 뜻이 달라진다 */
function nextLabel(state) {
  if (state.stage?.kind === 'round') {
    if (state.round?.phase === 'ready') return '라운드 시작 →';
    if (state.round?.phase === 'running') return '지금 마감 →';
  }
  if (state.stage?.kind === 'reveal' && (state.revealStep ?? 0) < REVEAL_MAX) {
    return '공개 →';
  }
  if (state.stageIndex >= state.stageCount - 1) return '수업 끝';
  return '다음 →';
}

/** 아래 왼쪽에 작게 붙는 "다음에 올 것" */
function nextHint(state) {
  if (state.stage?.kind === 'round') {
    if (state.round?.phase === 'ready') return '다음: 타이머 시작';
    if (state.round?.phase === 'running') return '다음: 마감하고 집계';
  }
  if (state.stage?.kind === 'reveal') {
    const step = state.revealStep ?? 0;
    if (step < REVEAL_MAX) return `다음: ${REVEAL_TITLES[step]} (${step + 1}/${REVEAL_MAX})`;
  }
  const next = ctx.stages[state.stageIndex + 1];
  return next ? `다음: ${next.label}` : '마지막 단계입니다';
}

function isLastAction(state) {
  return state.stageIndex >= state.stageCount - 1;
}

function renderTrack(state) {
  const track = $('#progressTrack');
  if (track.children.length !== state.stageCount) {
    track.innerHTML = '';
    for (let i = 0; i < state.stageCount; i++) {
      track.append(el('button', {
        class: 'progress-seg',
        type: 'button',
        title: ctx.stages[i]?.label || '',
        'aria-label': ctx.stages[i]?.label || `${i + 1}단계`,
        onClick: () => jumpTo(i),
      }));
    }
  }
  [...track.children].forEach((seg, i) => {
    seg.classList.toggle('done', i < state.stageIndex);
    seg.classList.toggle('now', i === state.stageIndex);
    if (ctx.stages[i]) seg.title = ctx.stages[i].label;
  });
}

async function jumpTo(index) {
  const stage = ctx.stages[index];
  if (!stage || !ctx.code) return;
  if (Math.abs(index - ctx.state.stageIndex) > 1
    && !confirm(`"${stage.label}" 단계로 건너뛸까요?`)) return;
  ctx.send('host:goto', { stageId: stage.id });
}

$('#nextBtn').addEventListener('click', () => step('host:next'));
$('#prevBtn').addEventListener('click', () => step('host:prev'));

function step(event) {
  if (!ctx.code) return;
  ctx.send(event, { revealMax: REVEAL_MAX });
}

// 프레젠테이션 리모컨(→/←)으로도 넘긴다
window.addEventListener('keydown', (e) => {
  if (!ctx.code || e.target.matches('input, textarea')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); step('host:next'); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step('host:prev'); }
});

// ------------------------------------------------------------------ 서버에서 오는 것

socket.on('host:state', (state) => {
  if (state.code !== ctx.code) return;
  applyState(state);
});

/** 제출이 들어올 때마다 오는 가벼운 갱신 — 인원 수만 온다 */
socket.on('round:progress', (p) => {
  if (!ctx.state?.round || ctx.state.round.stageId !== p.stageId) return;
  ctx.state.round.submitted = p.submitted;
  ctx.state.round.total = p.total;
  $('#stageArea')._update?.(ctx.state);
});

socket.on('warmup:tally', ({ warmup, playerCount }) => {
  if (!ctx.state) return;
  ctx.state.warmup = warmup;
  ctx.state.connectedCount = playerCount;
  $('#stageArea')._update?.(ctx.state);
});

socket.on('round:closed', ({ results }) => {
  if (!results) return;
  toast(results.scoring === false ? '연습 라운드 마감' : `라운드 ${results.round} 집계 완료`);
});

// ------------------------------------------------------------------ 복구

async function attachSaved(manual = false) {
  const saved = hostLoad();
  if (!saved?.code || !saved?.hostKey) return false;
  try {
    connectTo(saved.code);
    const res = await ask('host:attach', { code: saved.code, hostKey: saved.hostKey });
    ctx.code = res.code;
    ctx.hostKey = saved.hostKey;
    ctx.join = res.join;
    showScreen('run');
    applyState(res.state);
    return true;
  } catch (err) {
    if (manual) toast(err.message, 'error');
    hostClear();
    showScreen('setup');
    return false;
  }
}

mountConnectionBanner(() => { if (ctx.code) attachSaved(false); });

(async function boot() {
  try {
    ctx.stages = await (await fetch('/api/stages')).json();
  } catch { ctx.stages = []; }
  // 새로고침·재시작 뒤에도 하던 수업으로 그대로 돌아온다
  if (hostLoad()?.code) await attachSaved(false);
})();
