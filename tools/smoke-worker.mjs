// Cloudflare Worker 통합 점검 — 배포되는 그 코드를 그대로 두드린다.
//
//   터미널 1:  npm run dev
//   터미널 2:  npm run smoke:worker
//
// 실제 서비스 주소로 확인하려면:  TV_URL=https://주소 npm run smoke:worker

import { connect, newCode, wait, reporter } from './client.mjs';

const { check, head, finish } = reporter();
const BASE = process.env.TV_URL || 'http://127.0.0.1:8787';
console.log(`\n▶ 신뢰마을 — Cloudflare Worker 통합 점검 (${BASE})`);

// ------------------------------------------------------------------ 정적·API
head('주소 하나로 열리는가');
{
  const home = await fetch(BASE);
  const host = await fetch(`${BASE}/host`);
  check('학생 화면', home.ok && (await home.text()).includes('신뢰마을'), String(home.status));
  check('진행자 화면', host.ok && (await host.text()).includes('진행자'), String(host.status));

  const css = await fetch(`${BASE}/css/base.css`);
  const font = await fetch(`${BASE}/fonts/pretendard.css`);
  check('디자인·글꼴이 함께 배포됨', css.ok && font.ok);

  const stages = await (await fetch(`${BASE}/api/stages`)).json();
  check('15단계', stages.length === 15, String(stages.length));

  const sc = await (await fetch(`${BASE}/api/scenarios`)).json();
  const ids = ['practice', 'r1', 'r2', 'r3', 'r4'];
  check('시나리오 5개', ids.every((id) => sc.sets[0].scenarios[id]));
  check('삽화는 있으면 경로, 없으면 이모지 폴백',
    ids.every((id) => {
      const s = sc.sets[0].scenarios[id];
      return (s.imageUrl === null && s.emoji) || typeof s.imageUrl === 'string';
    }));
}

// ------------------------------------------------------------------ 수업 한 판
const code = await newCode();
const host = await connect(code);
const created = await host.ask('host:create', { code, villageCount: 4, roundSeconds: 15 });
const KEY = { code, hostKey: created.hostKey };
const state = async () => (await host.ask('host:attach', KEY)).state;
const next = () => host.ask('host:next', { ...KEY, revealMax: 4 });
console.log(`  세션 ${code}`);

head('세션과 QR');
{
  check('6자리 코드', /^[A-Z0-9]{6}$/.test(code), code);
  check('QR 이 SVG 로 생성됨', created.join.qr.startsWith('data:image/svg+xml'));
  check('접속 주소가 지금 이 주소', created.join.url.startsWith(BASE.replace(/\/$/, '')), created.join.url);
  check('진행자 열쇠 발급', Boolean(created.hostKey));

  const impostor = await connect(code);
  let blocked = false;
  try { await impostor.ask('host:next', { code, hostKey: '틀린열쇠' }); } catch { blocked = true; }
  check('열쇠 없이는 진행 못 함', blocked);
  impostor.close();
}

head('데모 봇 28명');
{
  const res = await host.ask('host:demo', { ...KEY, on: true, count: 28 });
  check('28명 입장', res.demo.count === 28, `${res.demo.count}명`);
  const st = await state();
  check('마을에 고르게', Math.max(...st.villages.map((v) => v.size)) - Math.min(...st.villages.map((v) => v.size)) <= 1,
    st.villages.map((v) => v.size).join('/'));
}

head('워밍업');
{
  await next();
  await wait(2500);
  const st = await state();
  const total = Object.values(st.warmup.w1 || {}).reduce((a, b) => a + b, 0);
  check('봇이 투표하고 집계된다', total === 28, `${total}표`);
  check('집계는 카운트만', typeof st.warmup.w1[0] === 'number');
}

head('수업 한 판 — 연습 + 4라운드');
const honest = [];
{
  await next(); await next(); await next();   // story → rules → practice

  for (const label of ['연습', 'R1', 'R2']) {
    await next();
    await wait(11_000);
    await host.ask('host:round:close', KEY).catch(() => {});
    await wait(500);
    const r = (await state()).round.results;
    honest.push({ label, rate: r.totals.honestRate });
    check(`${label} 집계`, r.totals.submitted >= 20, `제출 ${r.totals.submitted}/28`);
    await next();
  }

  check('중간 집계 도달', (await state()).stageId === 'interim');
  await next();
  await wait(2500);
  const st = await state();
  check('마을회의에서 제도가 뽑힌다', st.villages.every((v) => v.institution),
    st.villages.map((v) => v.institution).join('/'));

  await next();
  for (const label of ['R3', 'R4']) {
    await next();
    await wait(11_000);
    await host.ask('host:round:close', KEY).catch(() => {});
    await wait(500);
    const r = (await state()).round.results;
    honest.push({ label, rate: r.totals.honestRate });
    await next();
  }

  console.log('    라운드별 정직 선택률:');
  for (const h of honest) console.log(`      ${h.label.padEnd(3)} ${String(h.rate).padStart(3)}%`);
  const avg = (xs) => Math.round(xs.reduce((a, h) => a + h.rate, 0) / xs.length);
  const early = honest.filter((h) => ['R1', 'R2'].includes(h.label));
  const late = honest.filter((h) => ['R3', 'R4'].includes(h.label));
  check('초반엔 몰래 이득이 다수', avg(early) < 50, `${avg(early)}%`);
  check('제도 도입 뒤 정직이 오른다', avg(late) - avg(early) >= 15, `${avg(early)}% → ${avg(late)}%`);
}

head('최종 발표 — 한 장씩');
{
  let st = await state();
  check('발표 단계 도달', st.stageId === 'reveal', st.stageId);
  check('개인 코인 TOP3', st.reveal.coinTop.length === 3);
  const seen = [];
  for (let i = 0; i < 4; i++) { await next(); seen.push((await state()).revealStep); }
  check('네 번 눌러 네 장', seen.join(',') === '1,2,3,4', seen.join(' → '));
}

head('소감 · 서약');
{
  await next();   // reflect
  await wait(3000);
  let st = await state();
  check('소감 벽이 찬다', st.reflections.length >= 5, `${st.reflections.length}장`);
  check('작성자 정보 없음',
    st.reflections.every((r) => Object.keys(r).sort().join(',') === 'at,hearts,id,text'));

  const student = await connect(code);
  await student.ask('student:join', { code });
  let banned = false;
  try { await student.ask('student:reflect', { text: '시 발 재밌었다' }); } catch { banned = true; }
  check('금칙어는 거절', banned);
  const ok = await student.ask('student:reflect', { text: '아무도 안 볼 때가 제일 어려웠다' });
  check('사람 학생도 쓸 수 있다', Boolean(ok.id));
  student.close();

  await next();   // pledge
  await wait(2500);
  st = await state();
  check('서약 인원이 찬다', st.pledgeCount >= 18, `${st.pledgeCount}명`);

  await next();
  check('마무리 도달', (await state()).stageId === 'end');
}

head('결과 CSV — 마을·라운드 단위만');
{
  const res = await fetch(`${BASE}/api/session/${code}/results.csv`);
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  const text = await res.text();
  check('내려받기 가능', res.ok);
  check('엑셀용 BOM', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF);
  check('라운드별 · 마을별 표', text.includes('# 라운드별 · 마을별 집계'));
  check('채택 제도 들어감', /투명 장부제|청렴 감사제|청렴 서약제/.test(text));

  const st = await state();
  check('학생 별명이 한 명도 없음', !st.roster.some((p) => text.includes(p.nickname)));
  check('토큰·선택 원본 없음', !/token|choice|secret/i.test(text));
}

head('익명성 — 개인 선택이 새지 않는가');
{
  const st = await state();
  const blob = JSON.stringify(st);
  // 재접속 토큰은 24자 소문자 문자열이다 — 그 모양이 하나라도 있으면 샌 것
  check('진행자 상태에 참가자 토큰 없음', !/"[a-z0-9]{24}"/.test(blob));
  check('진행자 상태에 개인 선택 없음', !/"choice"/.test(blob));
  check('집계에 남는 건 마을별 카운트', /"counts":\{"a":\d+,"b":\d+,"c":\d+\}/.test(blob));
}

host.close();
finish();
