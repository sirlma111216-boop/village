// 서버와의 연결 — 표준 WebSocket 하나.
//
// 화면 코드가 예전 Socket.IO 와 똑같은 모양으로 쓰도록 감쌌다.
//   socket.on('host:state', fn)          — 서버가 밀어 주는 것 받기
//   await ask('host:next', { ... })      — 요청하고 응답 기다리기
// 그래서 이 파일만 바뀌었고 진행자·학생 화면은 한 줄도 손대지 않았다.

import { el } from './dom.js';

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 4000;

let ws = null;
let sessionCode = null;
let seq = 0;
let backoff = RECONNECT_MIN;
let closedForGood = false;

const waiting = new Map();          // 요청 id → { resolve, reject, timer }
const listeners = new Map();        // 메시지 종류 → 함수들
const onceConnect = [];             // 연결될 때까지 미뤄 둔 것

function emitLocal(type, data) {
  for (const fn of listeners.get(type) || []) {
    try { fn(data); } catch (err) { console.error(err); }
  }
}

/** Socket.IO 의 socket.on 과 같은 자리 */
export const socket = {
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  off(type, fn) { listeners.get(type)?.delete(fn); },
  get connected() { return ws?.readyState === WebSocket.OPEN; },
  connect() { open(); },
};

// ------------------------------------------------------------------ 연결

function wsUrl(code) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?code=${encodeURIComponent(code)}`;
}

function open() {
  if (!sessionCode || closedForGood) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(wsUrl(sessionCode));

  ws.addEventListener('open', () => {
    backoff = RECONNECT_MIN;
    emitLocal('__connect');
    const queued = onceConnect.splice(0);
    for (const fn of queued) fn();
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg?.t) return;

    if (msg.t === 'ack') {
      const pending = waiting.get(msg.i);
      if (!pending) return;
      waiting.delete(msg.i);
      clearTimeout(pending.timer);
      if (msg.err) pending.reject(new Error(msg.err));
      else pending.resolve(msg.d || {});
      return;
    }
    emitLocal(msg.t, msg.d);
  });

  ws.addEventListener('close', () => {
    emitLocal('__disconnect');
    if (closedForGood) return;
    setTimeout(open, backoff);
    backoff = Math.min(RECONNECT_MAX, Math.round(backoff * 1.6));
  });

  ws.addEventListener('error', () => { try { ws.close(); } catch { /* 무시 */ } });
}

/**
 * 이 브라우저가 붙을 수업을 정한다. 코드를 알아야 연결할 수 있다.
 * (수업 하나가 서버에서 독립된 방 하나이기 때문)
 */
export function connectTo(code) {
  const next = String(code || '').toUpperCase();
  if (sessionCode === next && socket.connected) return;
  sessionCode = next;
  closedForGood = false;
  if (ws) { try { ws.close(); } catch { /* 무시 */ } ws = null; }
  open();
}

export const currentCode = () => sessionCode;

// ------------------------------------------------------------------ 요청

/** 응답을 기다리는 요청. 연결이 아직이면 붙을 때까지 기다렸다 보낸다. */
export function ask(type, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;

    const fire = () => {
      if (ws?.readyState !== WebSocket.OPEN) {
        reject(new Error('서버에 연결되어 있지 않습니다.'));
        return;
      }
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('서버가 응답하지 않습니다.'));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ t: type, i: id, d: payload }));
    };

    if (ws?.readyState === WebSocket.OPEN) fire();
    else {
      onceConnect.push(fire);
      open();
      // 연결 자체가 안 되면 여기서 끊는다
      setTimeout(() => {
        const at = onceConnect.indexOf(fire);
        if (at >= 0) { onceConnect.splice(at, 1); reject(new Error('서버에 연결하지 못했습니다.')); }
      }, timeoutMs);
    }
  });
}

// ------------------------------------------------------------------ 연결 상태 배너

export function mountConnectionBanner(onReconnect) {
  const bar = el('div', { class: 'offline-bar' }, '연결이 끊겼어요 — 다시 연결하는 중…');
  document.body.append(bar);
  socket.on('__disconnect', () => bar.classList.add('show'));
  socket.on('__connect', () => {
    bar.classList.remove('show');
    if (typeof onReconnect === 'function') onReconnect();
  });
  return bar;
}
