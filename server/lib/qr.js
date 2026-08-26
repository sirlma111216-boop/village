import QRCode from 'qrcode';

/**
 * QR을 data:image/png 로 만든다. 외부 API를 쓰지 않는 로컬 생성.
 * 프로젝터에서 멀리서도 찍히도록 크게, 여백은 넉넉히.
 */
export async function qrDataUrl(text) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 520,
    color: { dark: '#0f2a4a', light: '#ffffff' },
  });
}
