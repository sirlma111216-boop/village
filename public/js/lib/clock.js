// 남은 시간 표시 — 학생 폰 시계가 틀어져 있어도 맞도록 서버 시각과의 차이를 보정한다.

let offset = 0;        // 서버시각 - 내시각
let lastSeen = 0;      // 마지막으로 맞춘 서버 시각

/**
 * 서버 시각으로 시계를 맞춘다.
 *
 * 주의: 화면은 "제출 인원만 바뀐" 가벼운 갱신에도 다시 그려지는데,
 * 그때 들고 있는 serverNow 는 마지막 전체 상태를 받던 시점의 값이라 이미 낡았다.
 * 그 값으로 다시 맞추면 오프셋이 계속 뒤로 밀려 카운트다운이 멈춘 것처럼 보인다.
 * 그래서 "전보다 새로운 시각"일 때만 맞춘다.
 */
export function syncClock(serverNow) {
  if (typeof serverNow !== 'number' || serverNow <= lastSeen) return;
  lastSeen = serverNow;
  offset = serverNow - Date.now();
}

export const serverTime = () => Date.now() + offset;

/**
 * endsAt 까지 매초 tick 을 호출한다. 반환된 함수를 부르면 멈춘다.
 * @param {number} endsAt 서버 기준 종료 시각(ms)
 * @param {(secondsLeft:number, ratio:number) => void} tick
 */
export function startCountdown(endsAt, totalSeconds, tick) {
  let stopped = false;
  let lastShown = -1;

  function frame() {
    if (stopped) return;
    const leftMs = Math.max(0, endsAt - serverTime());
    const left = Math.ceil(leftMs / 1000);
    const ratio = totalSeconds > 0 ? Math.max(0, Math.min(1, leftMs / (totalSeconds * 1000))) : 0;
    if (left !== lastShown) {
      lastShown = left;
      tick(left, ratio);
    }
    if (leftMs <= 0) return;
    setTimeout(frame, 200);
  }
  frame();

  return () => { stopped = true; };
}

export const formatClock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s);
};
