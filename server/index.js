import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';

import { PORT } from './config.js';
import { store } from './game/store.js';
import { attachSockets } from './sockets/index.js';
import { localAddresses, joinUrl } from './lib/netinfo.js';
import { STAGES } from './game/stages.js';
import { scenariosWithArt, institutionName, warmupQuestion } from './lib/content.js';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONTENT_DIR = path.join(ROOT, 'content');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// 교실 LAN 전용 — 캐시 때문에 옛 화면이 남지 않도록 HTML 은 항상 새로 받는다
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use('/content', express.static(CONTENT_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

app.get('/host', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/** 진행자 안내용 — 어느 주소로 들어오면 되는지 */
app.get('/api/network', (req, res) => {
  res.json({ port: PORT, addresses: localAddresses(), url: joinUrl(PORT) });
});

app.get('/api/stages', (req, res) => res.json(STAGES));

/**
 * 시나리오 — 삽화 경로를 서버가 찾아서 붙여 준다.
 * 선생님이 illustrations/ 에 어떤 확장자로 넣든 화면은 신경 쓸 필요가 없다.
 */
app.get('/api/scenarios', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(scenariosWithArt());
});

/**
 * 결과 CSV — 마을 단위·라운드 단위 집계만.
 *
 * 여기에 들어갈 수 있는 것은 "몇 명이 무엇을 골랐는가"까지다.
 * "누가 골랐는가"는 서버 메모리에도 이미 남아 있지 않고,
 * 개인 단위 행(학생 한 명 = 한 줄)은 어떤 형태로도 만들지 않는다.
 * 개인 코인 순위조차 넣지 않는다 — 익명 별명이라도 개인 단위이기 때문.
 */
app.get('/api/session/:code/results.csv', (req, res) => {
  const s = store.get(req.params.code);
  if (!s) return res.status(404).send('세션을 찾을 수 없습니다.');

  const rows = [];
  const put = (...cells) => rows.push(cells);
  const pct = (n, of) => (of ? Math.round((n / of) * 100) : '');

  // ── 1. 라운드 × 마을 (이 파일의 본체)
  put('# 라운드별 · 마을별 집계');
  put('구분', '라운드', '마을', '채택제도', '인원', '제출', '미제출',
    '몰래이득', '규칙대로', '용기내어알리기', '정직선택률(%)',
    '신뢰지수변화', '라운드후신뢰지수', '적발인원', '서약보너스인원');

  for (const stage of STAGES) {
    if (stage.kind !== 'round') continue;
    const r = s.roundResults[stage.id];
    if (!r) continue;
    for (const v of r.villages) {
      const honest = v.counts.b + v.counts.c;
      put(
        r.scoring ? '라운드' : '연습',
        r.scoring ? r.round : '연습',
        v.name,
        institutionName(v.institution),
        v.size, v.submitted, Math.max(0, v.size - v.submitted),
        v.counts.a, v.counts.b, v.counts.c, pct(honest, v.submitted),
        r.scoring ? v.trustDelta : 0,
        v.trustAfter,
        v.caughtCount || 0, v.bonusCount || 0,
      );
    }
  }

  // ── 2. 라운드 전체 합계
  put('');
  put('# 라운드별 학급 전체');
  put('라운드', '제출', '미제출', '몰래이득', '규칙대로', '용기내어알리기', '정직선택률(%)');
  for (const stage of STAGES) {
    if (stage.kind !== 'round') continue;
    const r = s.roundResults[stage.id];
    if (!r) continue;
    const t = r.totals;
    put(r.scoring ? r.round : '연습', t.submitted, t.missing, t.a, t.b, t.c, t.honestRate ?? '');
  }

  // ── 3. 마을 최종
  put('');
  put('# 마을 최종 (순위는 신뢰지수로만)');
  put('순위', '마을', '인원', '최종신뢰지수', '채택제도', '마을코인합계');
  const ranked = s.villageCoins().sort((a, b) => b.trust - a.trust);
  ranked.forEach((v, i) => {
    put(i + 1, v.name, v.size, v.trust, institutionName(s.villages[v.index]?.institution), v.coins);
  });

  // ── 4. 워밍업 (선택지별 표수만)
  const warmupIds = Object.keys(s.warmup);
  if (warmupIds.length) {
    put('');
    put('# 워밍업 투표');
    put('문항', '질문', '보기', '표수');
    for (const qid of warmupIds) {
      const q = warmupQuestion(qid);
      for (const [opt, n] of Object.entries(s.warmup[qid])) {
        put(qid, q?.text || '', q?.options?.[Number(opt)]?.label || `보기${Number(opt) + 1}`, n);
      }
    }
  }

  // ── 5. 마무리 (수·글만)
  put('');
  put('# 수업 마무리');
  put('항목', '값');
  put('참여 인원', s.playerCount);
  put('서약 인원', s.pledgeCount);
  put('소감 수', s.reflections.length);
  put('하트 합계', s.reflections.reduce((sum, r) => sum + (r.hearts || 0), 0));

  if (s.reflections.length) {
    put('');
    put('# 익명 소감 (작성자 정보 없음)');
    put('소감', '하트');
    for (const r of s.reflections) put(r.text, r.hearts || 0);
  }

  const csv = rows.map((r) => r.map((c) => {
    const v = String(c ?? '');
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="trust-village-${s.code}.csv"; filename*=UTF-8''${encodeURIComponent(`신뢰마을-${s.code}.csv`)}`);
  res.send('﻿' + csv);   // 엑셀에서 한글이 깨지지 않도록 BOM
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sessions: store.sessions.size, uptime: Math.round(process.uptime()) });
});

const server = http.createServer(app);
const io = new SocketServer(server, {
  // 교실 와이파이가 불안정할 때를 대비해 여유 있게
  pingInterval: 20_000,
  pingTimeout: 25_000,
  maxHttpBufferSize: 1e5,
});

attachSockets(io, { port: PORT });

await store.restore();
store.startAutosave();

server.listen(PORT, '0.0.0.0', () => {
  const addrs = localAddresses();
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  🏘️  신뢰마을 (Trust Village) 서버가 열렸습니다');
  console.log(line);
  console.log(`  진행자 화면 :  http://localhost:${PORT}/host`);
  console.log(`  학생 접속   :  ${joinUrl(PORT)}`);
  if (addrs.length > 1) {
    console.log('  (다른 주소)  : ' + addrs.slice(1).map((a) => `http://${a.address}:${PORT}/`).join('  '));
  }
  if (!addrs.length) {
    console.log('  ⚠️  네트워크 주소를 찾지 못했습니다. 와이파이/핫스팟을 켜 주세요.');
  }
  console.log(`${line}\n`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[${signal}] 저장 후 종료합니다…`);
  store.stopAutosave();
  store.flushSync();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
