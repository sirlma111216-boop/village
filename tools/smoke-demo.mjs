// 6단계 점검 (서버를 켠 상태에서): 데모 봇 모드로 수업 한 판을 통째로 돌린다.
// 삽화 폴백 · 봇 분포 곡선 · CSV 익명성까지 함께 본다.
// 사용: node tools/smoke-demo.mjs
import { io } from 'socket.io-client';

const URL = process.env.TV_URL || 'http://localhost:3000';

let bad = 0;
const check = (label, pass, extra = '') => {
  if (!pass) bad++;
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};
const head = (t) => console.log(`\n▶ ${t}`);

const connect = () => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ['websocket'], reconnection: false });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});
const ask = (s, ev, p = {}) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${ev}`)), 10_000);
  s.emit(ev, p, (res) => {
    clearTimeout(t);
    if (res && res.ok === false) reject(new Error(res.error));
    else resolve(res);
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n▶ 신뢰마을 6단계 점검 — 데모 봇으로 수업 한 판 (${URL})`);

// ------------------------------------------------------------------ 시나리오 · 삽화
head('시나리오와 삽화');
{
  const data = await (await fetch(`${URL}/api/scenarios`)).json();
  const set = data.sets[0];
  const ids = ['practice', 'r1', 'r2', 'r3', 'r4'];
  check('연습 + 4라운드 모두 있음', ids.every((id) => set.scenarios[id]), Object.keys(set.scenarios).join(','));

  const titles = ids.map((id) => set.scenarios[id].title);
  check('제목이 요청대로', titles.join(' / ') ===
    '떡볶이 거스름돈 / 급식 새치기 찬스 / 심판의 유혹 / 학급비의 비밀 / 시험지 쪽지', titles.join(' / '));

  check('선택지가 셋씩', ids.every((id) => ['a', 'b', 'c'].every((k) => set.scenarios[id].choices[k]?.label)));
  check('브랜드명 없음', !/카카오|카톡|라인|배민|쿠팡|네이버/.test(JSON.stringify(set)));

  check('삽화 파일이 없으면 imageUrl 은 null (이모지 폴백)',
    ids.every((id) => set.scenarios[id].imageUrl === null || typeof set.scenarios[id].imageUrl === 'string'));
  check('폴백용 이모지·색이 준비돼 있음',
    ids.every((id) => set.scenarios[id].emoji && set.scenarios[id].tone),
    ids.map((id) => set.scenarios[id].emoji).join(' '));
}

// ------------------------------------------------------------------ 데모 봇
const host = await connect();
const created = await ask(host, 'host:create', { villageCount: 4, roundSeconds: 15 });
const KEY = { code: created.code, hostKey: created.hostKey };
const state = async () => (await ask(host, 'host:attach', KEY)).state;
const next = () => ask(host, 'host:next', { ...KEY, revealMax: 4 });
console.log(`  세션 ${created.code}`);

head('데모 봇 켜기');
{
  const res = await ask(host, 'host:demo', { ...KEY, on: true, count: 28 });
  check('28명이 들어온다', res.demo.count === 28, `${res.demo.count}명`);

  const st = await state();
  check('마을에 고르게 나뉜다',
    Math.max(...st.villages.map((v) => v.size)) - Math.min(...st.villages.map((v) => v.size)) <= 1,
    st.villages.map((v) => v.size).join('/'));
  check('접속 인원에 포함된다', st.connectedCount === 28, String(st.connectedCount));
  check('진행자 화면이 데모임을 안다', st.demo.on === true);
  check('명패에도 익명 별명뿐',
    st.roster.every((p) => p.nickname && !('token' in p)), `${st.roster.length}명`);
}

head('워밍업 — 봇이 알아서 투표');
{
  await next();
  await wait(2200);
  const st = await state();
  const total = Object.values(st.warmup.w1 || {}).reduce((a, b) => a + b, 0);
  check('두 문항 모두 투표됨', total === 28 && Object.values(st.warmup.w2 || {}).reduce((a, b) => a + b, 0) === 28,
    `w1 ${total}표`);
}

head('수업 한 판 — 연습 + 4라운드');
{
  await next();   // story
  await next();   // rules
  await next();   // practice

  const honest = [];
  for (const label of ['연습', 'R1', 'R2']) {
    await next();          // 라운드 시작
    await wait(11_000);   // 봇이 시간차를 두고 낸다      // 봇이 낸다
    await ask(host, 'host:round:close', KEY);
    await wait(400);
    const st = await state();
    const r = st.round.results;
    honest.push({ label, rate: r.totals.honestRate, submitted: r.totals.submitted, a: r.totals.a });
    check(`${label}: 봇이 제출한다 (몇 명은 일부러 미제출)`,
      r.totals.submitted >= 21 && r.totals.submitted <= 28, `${r.totals.submitted}/28명`);
    await next();          // 다음 단계
  }

  // interim → council
  let st = await state();
  check('중간 집계 도달', st.stageId === 'interim', st.stageId);
  await next();
  await wait(2200);
  st = await state();
  check('마을회의: 봇이 제도를 고른다',
    st.villages.every((v) => v.institution), st.villages.map((v) => v.institution).join('/'));
  check('마을마다 다른 제도가 뽑힌다',
    new Set(st.villages.map((v) => v.institution)).size >= 2);

  await next();   // round3
  for (const label of ['R3', 'R4']) {
    await next();
    await wait(11_000);   // 봇이 시간차를 두고 낸다
    await ask(host, 'host:round:close', KEY);
    await wait(400);
    const s2 = await state();
    const r = s2.round.results;
    honest.push({ label, rate: r.totals.honestRate, submitted: r.totals.submitted, a: r.totals.a });
    await next();
  }

  console.log('    라운드별 정직 선택률:');
  for (const h of honest) console.log(`      ${h.label.padEnd(3)} ${String(h.rate).padStart(3)}%  (몰래이득 ${h.a}명)`);

  const early = honest.filter((h) => ['R1', 'R2'].includes(h.label));
  const late = honest.filter((h) => ['R3', 'R4'].includes(h.label));
  const avg = (xs) => Math.round(xs.reduce((a, h) => a + h.rate, 0) / xs.length);

  // 28명 표본이라 한 판씩 보면 ±10%p 는 예사로 흔들린다.
  // 두 라운드 평균으로 보되, 주장은 "정직이 소수"까지만 — 기대값은 33% 안팎이다.
  check('초반엔 몰래 이득이 다수', avg(early) < 50, `R1·R2 정직 평균 ${avg(early)}% (기대 33% 안팎)`);
  check('제도 도입 뒤 정직이 뚜렷하게 오른다', avg(late) - avg(early) >= 15,
    `${avg(early)}% → ${avg(late)}% (+${avg(late) - avg(early)}p)`);
}

head('발표 · 소감 · 서약 — 봇이 마지막까지');
{
  let st = await state();
  check('최종 발표 도달', st.stageId === 'reveal', st.stageId);
  check('개인 코인 TOP3 준비됨', st.reveal.coinTop.length === 3);
  check('라운드별 정직 선택률 4개', st.reveal.honestByRound.filter((r) => r.honestRate != null).length === 4);

  for (let i = 0; i < 4; i++) await next();   // 네 장 공개
  await next();                               // reflect
  await wait(2600);
  st = await state();
  check('소감 벽에 카드가 붙는다', st.reflections.length >= 5, `${st.reflections.length}장`);
  check('하트도 눌린다', st.reflections.some((r) => r.hearts > 0));
  check('소감에 작성자 정보 없음',
    st.reflections.every((r) => Object.keys(r).sort().join(',') === 'at,hearts,id,text'));

  await next();   // pledge
  await wait(2200);
  st = await state();
  check('서약 인원이 찬다', st.pledgeCount >= 18, `${st.pledgeCount}/28명`);

  await next();   // end
  check('마무리 도달', (await state()).stageId === 'end');
}

// ------------------------------------------------------------------ CSV
head('결과 CSV — 마을별 · 라운드별 집계, 개인 단위 없음');
{
  const res = await fetch(`${URL}/api/session/${created.code}/results.csv`);
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  const text = await res.text();
  const lines = text.split('\r\n');

  check('내려받기 가능', res.ok);
  check('엑셀용 BOM', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF);
  check('라운드별·마을별 표', text.includes('# 라운드별 · 마을별 집계'));
  check('라운드 전체 합계 표', text.includes('# 라운드별 학급 전체'));
  check('마을 최종 표', text.includes('# 마을 최종 (순위는 신뢰지수로만)'));
  check('채택 제도가 들어간다', /투명 장부제|청렴 감사제|청렴 서약제/.test(text));
  check('적발·보너스 인원 수가 들어간다', text.includes('적발인원') && text.includes('서약보너스인원'));

  // 첫 구간(라운드별 · 마을별)만 세어야 한다 — 뒤 구간에도 '연습'으로 시작하는 줄이 있다
  const start = lines.findIndex((l) => l.startsWith('# 라운드별 · 마을별'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('# 라운드별 학급 전체'));
  const villageRows = lines.slice(start + 2, end).filter((l) => l.trim());
  check('마을 × 라운드 행이 모두 있다', villageRows.length === 20, `${villageRows.length}행`);

  // ★ 개인 단위 데이터가 없어야 한다
  const st = await state();
  const nicknames = st.roster.map((p) => p.nickname);
  check('학생 별명이 한 명도 없다', !nicknames.some((n) => text.includes(n)));
  check('개인 코인 순위가 없다', !text.includes('개인') && !/코인TOP|TOP3/i.test(text));
  check('토큰·선택 원본 없음', !/token|choice|secret/i.test(text));

  const villageNames = st.villages.map((v) => v.name);
  check('마을 이름은 있다 (집계 단위)', villageNames.every((n) => text.includes(n)));
}

head('데모 봇 끄기');
{
  const before = (await state()).playerCount;
  const res = await ask(host, 'host:demo', { ...KEY, on: false });
  check('전원 내보내진다', res.demo.count === 0);
  const st = await state();
  check('세션에서 사라진다', st.playerCount === 0, `${before} → ${st.playerCount}`);
  check('데모 꺼짐으로 표시', st.demo.on === false);
}

console.log(`\n${bad ? `❌ 실패 ${bad}건` : '✅ 전부 통과'}\n`);
host.disconnect();
process.exit(bad ? 1 : 0);
