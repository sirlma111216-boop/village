// 아주 작은 DOM 도우미 — 빌드 도구 없이 쓰기 위한 최소한만.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') node.textContent = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** el() 처럼 null·false 자식을 걸러서 붙인다 (node.append 는 "null" 을 글자로 찍는다) */
export function mount(node, ...children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function show(node, on = true) {
  if (node) node.classList.toggle('hidden', !on);
}

/** 화면(section[data-screen]) 하나만 보이게 전환 */
export function showScreen(name, root = document) {
  for (const s of $$('[data-screen]', root)) {
    s.classList.toggle('hidden', s.dataset.screen !== name);
  }
}

let toastTimer = null;
export function toast(message, kind = '') {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast' });
    document.body.append(node);
  }
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

/** 숫자가 스르륵 올라가는 카운터 (입장 인원, 코인 등) */
export function countUp(node, to, ms = 400) {
  const from = Number(node.dataset.value || node.textContent.replace(/[^\d-]/g, '') || 0);
  node.dataset.value = to;
  // 탭이 가려져 있으면 requestAnimationFrame 이 멈춘다 — 그때는 그냥 값을 박아 넣는다
  const still = document.visibilityState !== 'visible'
    || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (from === to || still) { node.textContent = String(to); return; }
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1 && Number(node.dataset.value) === to) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // 프레임이 한 번도 오지 않는 경우(창이 가려졌을 때 등)에도 숫자는 맞아야 한다
  setTimeout(() => {
    if (Number(node.dataset.value) === to) node.textContent = String(to);
  }, ms + 120);
}
