// localStorage 래퍼 — 저장하는 것은 "세션 코드"와 "무작위 토큰"뿐.
// 이름·학번 같은 개인정보는 어디에도 담지 않는다.

const KEY_STUDENT = 'trust-village.student';
const KEY_HOST = 'trust-village.host';

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 사파리 프라이빗 모드 등 — 저장 못 해도 게임은 굴러간다 */ }
}

export const studentSave = (code, token) => write(KEY_STUDENT, { code, token, at: Date.now() });
export const studentLoad = () => read(KEY_STUDENT);
export const studentClear = () => write(KEY_STUDENT, null);

export const hostSave = (code, hostKey) => write(KEY_HOST, { code, hostKey, at: Date.now() });
export const hostLoad = () => read(KEY_HOST);
export const hostClear = () => write(KEY_HOST, null);
