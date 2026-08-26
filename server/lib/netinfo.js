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

/**
 * 학생에게 알려 줄 주소.
 *
 * 인터넷에 올린 경우(PUBLIC_URL 설정)에는 그 주소를,
 * 교실 LAN·핫스팟에서는 자동으로 찾은 로컬 IP 를 쓴다.
 * QR 도 이 주소로 만든다.
 */
export function studentUrl(port) {
  return PUBLIC_URL ? `${PUBLIC_URL}/` : joinUrl(port);
}

/** 지금 인터넷에 올라가 있는 상태인가 */
export const isHosted = () => Boolean(PUBLIC_URL);
