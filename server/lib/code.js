import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH } from '../config.js';

/** 6자리 세션 코드. 이미 쓰이는 코드는 피한다. */
export function makeSessionCode(isTaken = () => false) {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    if (!isTaken(code)) return code;
  }
  throw new Error('세션 코드를 만들 수 없습니다.');
}

/**
 * 학생이 입력한 코드 정규화.
 * 코드 알파벳에는 0·1·I·L·O 가 아예 없다. 학생이 그 글자를 입력했다면
 * 잘못 읽은 것이므로 조용히 버리고, 알파벳에 있는 글자만 남긴다.
 */
export function normalizeCode(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let out = '';
  for (const ch of cleaned) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out.slice(0, CODE_LENGTH);
}

/** 재접속용 토큰 — 개인정보가 아닌 무작위 문자열 */
export function makeToken() {
  let t = '';
  for (let i = 0; i < 24; i++) t += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return t.toLowerCase();
}
