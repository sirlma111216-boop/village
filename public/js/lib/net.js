// Socket.IO 감싸기 — 약속(Promise) 형태의 emit 과 연결 상태 배너.
// socket.io 클라이언트는 서버가 /socket.io/socket.io.js 로 직접 제공한다(외부 CDN 없음).

import { el } from './dom.js';

export const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  timeout: 8000,
});

/** 콜백 응답을 기다리는 emit. 응답이 없으면 거부한다. */
export function ask(event, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('서버가 응답하지 않습니다.'));
    }, timeoutMs);
    socket.emit(event, payload, (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (res && res.ok === false) reject(new Error(res.error || '알 수 없는 오류'));
      else resolve(res);
    });
  });
}

/** 상단 "연결이 끊겼어요" 배너를 자동으로 붙인다. */
export function mountConnectionBanner(onReconnect) {
  const bar = el('div', { class: 'offline-bar' }, '📡 연결이 끊겼어요 — 다시 연결하는 중…');
  document.body.append(bar);
  socket.on('disconnect', () => bar.classList.add('show'));
  socket.on('connect', () => {
    bar.classList.remove('show');
    if (typeof onReconnect === 'function') onReconnect();
  });
  return bar;
}
