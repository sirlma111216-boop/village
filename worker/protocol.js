// 서버와 브라우저가 함께 쓰는 메시지 형식.
//
// Socket.IO 대신 표준 WebSocket 한 줄로 주고받는다. 필요한 건 세 가지뿐:
//   요청+응답   { t: 'host:next', i: 7, d: {...} }  →  { t: 'ack', i: 7, d: {...} }
//   서버 밀어주기 { t: 'host:state', d: {...} }
//   오류        { t: 'ack', i: 7, err: '...' }
//
// 이 정도면 되기 때문에 라이브러리를 얹지 않았다. 브라우저 쪽 코드가
// Socket.IO 와 같은 모양(ask / on)을 그대로 쓰도록 감싸 두었다.

export const encode = (msg) => JSON.stringify(msg);

export function decode(raw) {
  try {
    const msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    return msg && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

/** 요청에 대한 응답 */
export const ack = (id, data) => encode({ t: 'ack', i: id, d: data });
export const nack = (id, message) => encode({ t: 'ack', i: id, err: message });

/** 서버가 먼저 보내는 알림 */
export const push = (type, data) => encode({ t: type, d: data });
