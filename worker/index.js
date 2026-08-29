// Cloudflare Worker 진입점.
//
// 하는 일은 셋뿐이다.
//   1. 정적 파일(화면·CSS·폰트)을 내보낸다 — Workers Assets 가 맡는다
//   2. /api/* 몇 개를 답한다 (단계 목록, 시나리오, 결과 CSV)
//   3. /ws 로 온 WebSocket 을 그 수업의 Durable Object 에게 넘긴다
//
// 수업 상태와 실시간 처리는 전부 Durable Object 안에 있다.

import { STAGES } from '../shared/game/stages.js';
import { institutionName, warmupQuestion, SCENARIOS, INSTITUTIONS, WARMUP_QUESTIONS, STORY } from '../shared/content.js';
import { normalizeCode, makeSessionCode } from '../shared/lib/code.js';

export { VillageSession } from './session-do.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  ...init,
});

/** 삽화 파일이 실제로 있는지 확인한다 (없으면 화면이 이모지로 대신 그린다) */
const EXT_ORDER = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'];

async function resolveIllustration(env, origin, name) {
  if (!name) return null;
  const base = String(name).replace(/\.[a-z0-9]+$/i, '').replace(/[^\w-]/g, '');
  if (!base) return null;
  for (const ext of EXT_ORDER) {
    const path = `/illustrations/${base}.${ext}`;
    const res = await env.ASSETS.fetch(new Request(`${origin}${path}`, { method: 'HEAD' }));
    if (res.ok) return path;
  }
  return null;
}

async function storyWithArt(env, origin) {
  const panels = [];
  for (const panel of STORY.panels) {
    panels.push({ ...panel, imageUrl: await resolveIllustration(env, origin, panel.image) });
  }
  return { ...STORY, panels };
}

async function scenariosWithArt(env, origin) {
  // 구조를 복사해서 imageUrl 만 붙인다 (원본 JSON 은 건드리지 않는다)
  const out = { sets: [] };
  for (const set of SCENARIOS.sets) {
    const scenarios = {};
    for (const [id, sc] of Object.entries(set.scenarios)) {
      scenarios[id] = { ...sc, imageUrl: await resolveIllustration(env, origin, sc.image) };
    }
    out.sets.push({ ...set, scenarios });
  }
  return out;
}

// ------------------------------------------------------------------ CSV

/**
 * 결과 CSV — 마을 단위·라운드 단위 집계만.
 * 개인 단위 행(학생 한 명 = 한 줄)은 어떤 형태로도 만들지 않는다.
 */
function resultsCsv(s) {
  const rows = [];
  const put = (...cells) => rows.push(cells);
  const pct = (n, of) => (of ? Math.round((n / of) * 100) : '');

  put('# 라운드별 · 마을별 집계');
  put('구분', '라운드', '마을', '채택제도', '인원', '제출', '미제출',
    '몰래이득', '규칙대로', '용기내어알리기', '정직선택률(%)',
    '신뢰지수변화', '라운드후신뢰지수', '적발인원', '서약보너스인원');

  for (const stage of STAGES) {
    if (stage.kind !== 'round') continue;
    const r = s.roundResults[stage.id];
    if (!r) continue;
    for (const v of r.villages) {
      put(r.scoring ? '라운드' : '연습', r.scoring ? r.round : '연습', v.name,
        institutionName(v.institution), v.size, v.submitted, Math.max(0, v.size - v.submitted),
        v.counts.a, v.counts.b, v.counts.c, pct(v.counts.b + v.counts.c, v.submitted),
        r.scoring ? v.trustDelta : 0, v.trustAfter, v.caughtCount || 0, v.bonusCount || 0);
    }
  }

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

  put('');
  put('# 마을 최종 (순위는 신뢰지수로만)');
  put('순위', '마을', '인원', '최종신뢰지수', '채택제도', '마을코인합계');
  [...s.villageCoins()].sort((a, b) => b.trust - a.trust).forEach((v, i) => {
    put(i + 1, v.name, v.size, v.trust, institutionName(s.villages[v.index]?.institution), v.coins);
  });

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

  return rows.map((r) => r.map((c) => {
    const v = String(c ?? '');
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\r\n');
}

// ------------------------------------------------------------------ 라우팅

const doFor = (env, code) => env.SESSION.get(env.SESSION.idFromName(code));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ---- 실시간: 그 수업의 Durable Object 에게 넘긴다
    if (pathname === '/ws') {
      const code = normalizeCode(url.searchParams.get('code'));
      if (code.length !== 6) return new Response('코드가 필요합니다.', { status: 400 });
      // 진행자가 보고 있는 주소를 그대로 전달한다 (QR 이 이 주소를 가리킨다)
      const inner = new URL(request.url);
      inner.searchParams.set('origin', url.origin);
      return doFor(env, code).fetch(new Request(inner, request));
    }

    // ---- 새 수업 코드 발급 (Durable Object 는 이름으로 찾으므로 코드가 먼저 필요하다)
    if (pathname === '/api/new-code') {
      return json({ code: makeSessionCode() });
    }

    if (pathname === '/api/stages') return json(STAGES);

    // 수업 콘텐츠 — content/ 는 정적 폴더 밖이라 Worker 가 직접 내보낸다
    if (pathname === '/api/warmup') return json({ questions: WARMUP_QUESTIONS });
    if (pathname === '/api/story') return json(await storyWithArt(env, url.origin));
    if (pathname === '/api/institutions') return json({ institutions: INSTITUTIONS });

    if (pathname === '/api/scenarios') {
      return json(await scenariosWithArt(env, url.origin));
    }

    if (pathname === '/api/health') {
      return json({ ok: true, runtime: 'cloudflare-workers' });
    }

    // ---- 결과 CSV
    const csvMatch = pathname.match(/^\/api\/session\/([A-Za-z0-9]{6})\/results\.csv$/);
    if (csvMatch) {
      const code = normalizeCode(csvMatch[1]);
      const snap = await doFor(env, code).snapshot();
      if (!snap) return new Response('세션을 찾을 수 없습니다.', { status: 404 });
      const { Session } = await import('../shared/game/session.js');
      const s = Session.fromSnapshot(snap);
      const csv = `﻿${resultsCsv(s)}`;   // 엑셀에서 한글이 깨지지 않도록 BOM
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="trust-village-${code}.csv"; `
            + `filename*=UTF-8''${encodeURIComponent(`신뢰마을-${code}.csv`)}`,
        },
      });
    }

    // ---- 진행자 화면
    if (pathname === '/host' || pathname === '/host/') {
      return env.ASSETS.fetch(new Request(`${url.origin}/host.html`, request));
    }

    // ---- 그 밖에는 정적 파일 (없으면 학생 입장 화면)
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
  },
};
