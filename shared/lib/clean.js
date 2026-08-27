// 소감 다듬기 — 길이 자르기와 아주 단순한 금칙어 거르기.
//
// 완벽한 필터는 만들 수 없고, 만들 필요도 없다. 이 교실에는 진행자가 있고
// 소감은 화면에 그대로 뜬다. 여기서 막는 것은 "실수로 튀어나오는 말" 정도이며,
// 걸러진 글은 조용히 지우는 대신 학생에게 다시 쓰라고 알려 준다.

import { REFLECTION_MAX_LEN } from '../config.js';

/**
 * 금칙어. 교실에서 가장 흔한 것들만 짧게 둔다.
 * content/ 가 아니라 코드에 두는 이유: 학생이 열어 볼 수 있는 자리에
 * 욕설 목록을 늘어놓고 싶지 않아서다.
 */
const BANNED = [
  '시발', '씨발', '시바', '씨바', '십새', '씹창', '씹녀', '씹놈',
  '병신', '븅신', '빙신',
  '지랄', '개새', '개색', '새끼', '색기',
  '좆', '좇', '존나', '존내', '졸라',
  'ㅅㅂ', 'ㅄ', 'ㅂㅅ', 'ㅈㄹ', 'ㄱㅅㄲ', 'ㅆㅂ',
  '엠창', '애미', '느금',
  '꺼져', '죽어라', '자살',
  'fuck', 'shit', 'bitch', 'asshole',
];

/**
 * 사이에 낀 공백·기호·반복을 걷어 내고 본다.
 * "시 발", "시*발" 같은 것을 함께 잡기 위한 최소한의 정규화.
 */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[\s.,!?~*^\-_=+/\\|<>()[\]{}'"`@#$%&:;]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1');   // ㅋㅋㅋㅋ → ㅋㅋ
}

const NORMALIZED_BANNED = BANNED.map(normalize);

/** 금칙어에 걸리면 그 단어를 돌려준다. 아니면 null. */
export function findBanned(text) {
  const flat = normalize(String(text ?? ''));
  const hit = NORMALIZED_BANNED.findIndex((word) => word && flat.includes(word));
  return hit >= 0 ? BANNED[hit] : null;
}

/**
 * 소감 한 줄을 다듬는다.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function cleanReflection(raw) {
  const text = String(raw ?? '')
    .replace(/\p{C}/gu, ' ')   // 제어·서식 문자 제거
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return { ok: false, reason: '한 글자라도 써 줘.' };
  if ([...text].length > REFLECTION_MAX_LEN) {
    return { ok: false, reason: `${REFLECTION_MAX_LEN}자까지 쓸 수 있어.` };
  }
  if (findBanned(text)) {
    return { ok: false, reason: '그 말은 벽에 붙이지 않을게. 다시 써 줄래?' };
  }
  return { ok: true, text };
}
