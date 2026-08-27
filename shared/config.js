// 신뢰마을 — 게임 상수 (한 곳에서만 고친다)

/** 세션 코드: 헷갈리는 0/O/1/I/L 제외 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

/** 마을 */
export const VILLAGE_COUNT_DEFAULT = 4;
export const VILLAGE_COUNT_MIN = 2;
export const VILLAGE_COUNT_MAX = 6;
export const TRUST_START = 60;
export const TRUST_MIN = 0;
export const TRUST_MAX = 100;

/** 신뢰지수 정규화 기준 마을 크기 — 마을 인원이 달라도 공정하게 */
export const TRUST_NORM_SIZE = 4;

/** 선택지 효과 */
export const CHOICES = {
  a: { coin: +3, trust: -2, secretTrust: true },  // 몰래 이득 (마을 영향 ??? 표시)
  b: { coin: +1, trust: +1, secretTrust: false }, // 규칙대로
  c: { coin: 0,  trust: +3, secretTrust: false }, // 용기 내어 알리기
};
export const CHOICE_KEYS = ['a', 'b', 'c'];

/** 제도 */
export const AUDIT_CATCH_RATE = 0.4;   // 청렴 감사제 적발 확률
export const AUDIT_PENALTY = -4;       // 적발 시 개인 코인
export const PLEDGE_BONUS = +1;        // 청렴 서약제 보너스

/** 라운드 */
export const ROUND_SECONDS_DEFAULT = 60;
export const ROUND_SECONDS_MIN = 15;
export const ROUND_SECONDS_MAX = 300;

/** 소감 */
export const REFLECTION_MAX_LEN = 100;

/** 저장 */
export const SNAPSHOT_INTERVAL_MS = 30_000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12시간 지난 세션은 정리
