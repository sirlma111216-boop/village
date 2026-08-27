// 점검 스크립트가 쓰는 아주 작은 클라이언트.
// 브라우저의 public/js/lib/net.js 와 같은 규약(ask / on)을 Node 에서 흉내 낸다.

const BASE = process.env.TV_URL || 'http://127.0.0.1:8787';

export function wsBase() { return BASE; }

export async function newCode() {
  const res = await fetch(`${BASE}/api/new-code`);
  return (await res.json()).code;
}

/**
 * 한 사람(진행자 또는 학생) 몫의 연결.
 * @param {string} code 수업 코드
 */
export function connect(code) {
  const url = `${BASE.replace(/^http/, 'ws')}/ws?code=${encodeURIComponent(code)}`;
  const ws = new WebSocket(url);
  const waiting = new Map();
  const listeners = new Map();
  let seq = 0;

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error(`연결 실패: ${url}`)));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'ack') {
      const p = waiting.get(msg.i);
      if (!p) return;
      waiting.delete(msg.i);
      clearTimeout(p.timer);
      if (msg.err) p.reject(new Error(msg.err));
      else p.resolve(msg.d || {});
      return;
    }
    for (const fn of listeners.get(msg.t) || []) fn(msg.d);
  });

  const api = {
    ws,
    ask(type, payload = {}, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`응답 없음: ${type}`));
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ t: type, i: id, d: payload }));
      });
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    once(type, ms = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`이벤트 없음: ${type}`)), ms);
        const fn = (d) => { clearTimeout(timer); listeners.get(type)?.delete(fn); resolve(d); };
        api.on(type, fn);
      });
    },
    close() { try { ws.close(); } catch { /* 무시 */ } },
  };

  return ready;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 점검 스크립트 공통 출력 */
export function reporter() {
  let bad = 0;
  return {
    check(label, pass, extra = '') {
      if (!pass) bad++;
      console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
    },
    head(t) { console.log(`\n▶ ${t}`); },
    finish() {
      console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
      process.exit(bad ? 1 : 0);
    },
  };
}
