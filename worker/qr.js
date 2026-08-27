// QR 만들기 — 파일시스템도 캔버스도 없는 Workers 안에서 도는 순수 JS 경로.
//
// qrcode 패키지의 기본 진입점은 Node 의 fs 를 끌고 오므로 쓰지 않고,
// 인코더와 SVG 렌더러만 직접 가져다 쓴다. 결과는 data URL 이라
// 화면에서는 예전과 똑같이 <img src="..."> 로 붙는다.

import QRCode from 'qrcode/lib/core/qrcode.js';
import svgRenderer from 'qrcode/lib/renderer/svg-tag.js';

/**
 * @param {string} text QR 에 담을 주소
 * @returns {string} data:image/svg+xml URL
 */
export function qrDataUrl(text) {
  const data = QRCode.create(String(text), { errorCorrectionLevel: 'M' });
  const svg = svgRenderer.render(data, {
    margin: 2,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
  // SVG 를 그대로 URL 에 담는다 (base64 보다 짧고 사람이 읽을 수 있다)
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
