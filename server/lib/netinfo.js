import os from 'node:os';
import { PUBLIC_URL } from '../config.js';

/** 사설망 대역인가? (교실 LAN / 진행자 핫스팟) */
function isPrivateV4(ip) {
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/**
 * 학생 폰이 접속할 수 있는 로컬 IPv4 주소 목록.
 * 사설망 → 그 외 순으로 정렬해서 첫 번째를 QR 주소로 쓴다.
 * (핫스팟 대역 192.168.x / 172.20.x 를 먼저 잡도록)
 */
export function localAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      found.push({ name, address: a.address, private: isPrivateV4(a.address) });
    }
  }
  found.sort((x, y) => {
    if (x.private !== y.private) return x.private ? -1 : 1;
    // 가상 어댑터(VirtualBox/VMware/WSL/Docker)는 뒤로 민다
    const virt = (n) => /virtual|vmware|vbox|docker|wsl|hyper-v|loopback/i.test(n) ? 1 : 0;
    return virt(x.name) - virt(y.name);
  });
  return found;
}

/** QR·안내에 쓸 대표 주소 */
export function primaryAddress() {
  return localAddresses()[0]?.address || 'localhost';
}

export function joinUrl(port, address = primaryAddress()) {
  return `http://${address}:${port}/`;
}

/** localhost 로 열린 주소는 그 노트북 안에서만 통한다 */
const isLoopback = (host = '') =>
  /^(localhost|127\.|\[::1\]|::1)/i.test(String(host).split(':')[0] || host);

/**
 * 진행자 브라우저가 실제로 접속한 주소를 그대로 읽는다.
 * 배포된 서버라면 도메인이, 노트북이라면 localhost 나 LAN IP 가 들어온다.
 */
export function originFromHeaders(headers = {}) {
  const host = headers['x-forwarded-host'] || headers.host;
  if (!host || isLoopback(host)) return null;
  // 프록시가 알려 주면 그대로 믿는다. 아니면 우리 서버는 TLS 를 직접 하지 않으므로 http.
  const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (headers['x-forwarded-host'] ? 'https' : 'http');
  return `${proto}://${host}`;
}

/**
 * 학생에게 알려 줄 주소. QR 도 이 주소로 만든다.
 *
 * 1. PUBLIC_URL 을 넣어 뒀으면 그것 (직접 지정하고 싶을 때)
 * 2. 아니면 진행자가 지금 보고 있는 주소 그대로 — 배포하면 저절로 도메인이 잡힌다
 * 3. 둘 다 없으면(노트북에서 localhost 로 열었을 때) 같은 와이파이용 로컬 IP
 */
export function studentUrl(port, headers) {
  if (PUBLIC_URL) return `${PUBLIC_URL}/`;
  const origin = originFromHeaders(headers);
  if (origin) return `${origin}/`;
  return joinUrl(port);
}

/** 인터넷 도메인으로 접속 중인가 (= 같은 와이파이 안내가 필요 없는 상태) */
export function isHosted(headers) {
  if (PUBLIC_URL) return true;
  const origin = originFromHeaders(headers);
  if (!origin) return false;
  // 192.168.x 같은 사설망 주소면 아직 교실 LAN 이다
  const host = origin.replace(/^https?:\/\//, '').split(':')[0];
  return !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}
