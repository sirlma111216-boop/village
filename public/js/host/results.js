// 진행자 화면 — 중간 집계 · 마을회의 · 최종 발표 · 소감 · 서약 · 마무리

import { el, countUp } from '../lib/dom.js';
import { getInstitutions } from '../lib/content.js';
import { registerStage, stageHead, trustBars, coinRows, mixBar, choiceLegend, swatch } from './render.js';

const BLOCK_CYCLE = ['block-lime', 'block-lilac', 'block-cream', 'block-mint', 'block-pink', 'block-coral'];

// ==================================================================
// 중간 집계
// ==================================================================

registerStage('interim', (area, state) => {
  const bars = el('div', {});
  const coins = el('div', { class: 'coin-panel' });

  area.append(
    stageHead('중간 집계', '두 라운드가 지났습니다', '여기까지의 마을 신뢰지수예요.'),
    el('div', { class: 'interim' },
      el('div', { class: 'stack', style: { gap: 'var(--s-lg)' } }, bars, roundStrip(state)),
      coins,
    ),
  );

  function update(s) {
    bars.innerHTML = '';
    bars.append(trustBars(s.villages, { ranked: false, deltas: deltasOf(s, 'round2') }));

    coins.innerHTML = '';
    coins.append(
      el('p', { class: 'eyebrow' }, '개인 코인 (참고용)'),
      ...coinRows(s.reveal?.coinTop || [], s.villages),
      el('p', { class: 't-body-sm', style: { opacity: 0.6, marginTop: 'var(--s-sm)' } },
        '순위는 코인이 아니라 마을 신뢰지수로 정해요.'),
    );
  }

  area._update = update;
  update(state);
});

/** 라운드별 선택 분포를 한 줄씩 */
function roundStrip(state) {
  const wrap = el('div', { class: 'stack', style: { gap: 'var(--s-sm)' } });
  const rounds = Object.values(state.roundResults || {})
    .filter((r) => r.scoring)
    .sort((a, b) => a.round - b.round);
  if (!rounds.length) return wrap;

  wrap.append(el('p', { class: 'eyebrow' }, '라운드별 선택'));
  for (const r of rounds) {
    wrap.append(el('div', { class: 'stack', style: { gap: '4px' } },
      el('div', { class: 'spread caption' },
        el('span', {}, `라운드 ${r.round}`),
        el('span', {}, r.totals.honestRate == null ? '—' : `정직 ${r.totals.honestRate}%`)),
      mixBar(r.totals, r.totals.submitted),
    ));
  }
  wrap.append(choiceLegend());
  return wrap;
}

function deltasOf(state, stageId) {
  const r = state.roundResults?.[stageId];
  if (!r) return {};
  return Object.fromEntries(r.villages.map((v) => [v.index, v.trustDelta]));
}

// ==================================================================
// 마을회의
// ==================================================================

registerStage('council', (area, state) => {
  const grid = el('div', { class: 'council-grid' });
  const status = el('div', { class: 'council-status' });

  area.append(
    stageHead('마을회의', '우리 마을의 규칙을 정하자', '마을끼리 이야기한 뒤, 폰에서 하나를 고르세요. 채택한 제도는 3·4라운드에 적용됩니다.'),
    grid,
    status,
  );

  getInstitutions().then((list) => {
    grid.innerHTML = '';
    list.forEach((inst, i) => {
      grid.append(el('div', { class: `inst-card i-${i}` },
        el('div', { class: 'inst-emoji' }, inst.emoji),
        el('h3', { class: 't-headline' }, inst.name),
        el('p', { class: 't-body-lg' }, inst.detail),
        el('p', { class: 'inst-cost t-body-sm' }, inst.cost),
      ));
    });
  });

  let institutions = [];
  getInstitutions().then((list) => { institutions = list; update(state); });
  const instName = (id) => institutions.find((x) => x.id === id)?.name || id;
  const instEmoji = (id) => institutions.find((x) => x.id === id)?.emoji || '';

  function update(s) {
    status.innerHTML = '';
    status.append(el('p', { class: 'eyebrow' }, '마을별 진행 상황'));

    for (const row of s.council || []) {
      const v = s.villages[row.villageIndex];
      if (!v) continue;
      const bars = el('div', { class: 'council-bars' },
        ...institutions.map((inst) => {
          const n = row.counts[inst.id] || 0;
          const pct = row.voted ? Math.round((n / row.voted) * 100) : 0;
          return el('span', {
            class: `council-seg${row.leading === inst.id ? ' is-lead' : ''}`,
            style: { width: `${pct}%` },
            title: `${inst.name} ${n}표`,
          }, n ? String(n) : '');
        }),
      );

      status.append(el('div', { class: 'council-village' },
        el('span', { class: 'council-name t-body-lg' }, swatch(v.color), `${v.emoji} ${v.name}`),
        bars,
        el('span', { class: 'caption council-votes' }, `${row.voted}/${row.size}`),
        row.leading
          ? el('span', { class: 'chip chip-solid council-picked' },
            `${instEmoji(row.leading)} ${instName(row.leading)}`)
          : el('span', { class: 'council-waiting' }, '토의 중'),
      ));
    }

    status.append(el('p', { class: 't-body-sm', style: { opacity: 0.55, marginTop: 'var(--s-sm)' } },
      '득표가 바뀌면 채택 제도도 바로 바뀝니다. 동점이면 왼쪽 카드가 채택돼요.'));
  }

  area._update = update;
  update(state);
});

// ==================================================================
// 최종 발표 — 버튼을 누를 때마다 한 장씩
// ==================================================================

export const REVEAL_MAX = 4;
export const REVEAL_TITLES = [
  '개인 코인 TOP 3',
  '마을별 코인',
  '마을 신뢰지수 순위',
  '정직 선택률',
];

registerStage('reveal', (area, state) => {
  const slot = el('div', { class: 'reveal' });
  area.append(
    stageHead('최종 발표', '결과를 하나씩 열어 봅시다', ''),
    slot,
  );

  let shown = -1;

  function update(s) {
    const step = Math.min(s.revealStep ?? 0, REVEAL_MAX);
    if (step === shown) return;

    // 뒤로 갔으면 카드를 걷어낸다
    if (step < shown) {
      slot.innerHTML = '';
      shown = 0;
      for (let i = 1; i <= step; i++) slot.append(revealCard(i, s));
      shown = step;
      return;
    }
    if (shown < 0) {
      slot.innerHTML = '';
      shown = 0;
      if (step === 0) slot.append(cue(1));
    }
    for (let i = shown + 1; i <= step; i++) {
      slot.querySelector('.reveal-cue')?.remove();
      slot.append(revealCard(i, s));
      if (i < REVEAL_MAX) slot.append(cue(i + 1));
    }
    shown = step;
  }

  function cue(next) {
    return el('div', { class: 'reveal-cue' },
      el('div', { class: 'reveal-cue-num' }, String(next).padStart(2, '0')),
      el('p', { class: 't-subhead' }, `다음: ${REVEAL_TITLES[next - 1]}`),
      el('p', { class: 'eyebrow', style: { opacity: 0.45 } }, '다음 → 을 누르세요'),
    );
  }

  area._update = update;
  update(state);
});

function revealCard(step, s) {
  const villages = s.villages;

  if (step === 1) {
    const top = s.reveal?.coinTop || [];
    return el('div', { class: 'reveal-card s-1 cut-in' },
      el('p', { class: 'eyebrow' }, '01 — 개인 코인'),
      el('h3', { class: 't-display-lg' }, '코인을 가장 많이 모은 사람'),
      el('div', { class: 'podium' },
        ...(top.length ? coinRows(top, villages, true).map((row) => {
          row.className = 'podium-row';
          return row;
        }) : [el('p', { class: 't-subhead' }, '아직 코인을 모은 사람이 없어요.')])),
      el('p', { class: 't-body-lg', style: { opacity: 0.7 } },
        '이름 대신 별명이에요. 누가 무엇을 골랐는지는 여전히 아무도 모릅니다.'),
    );
  }

  if (step === 2) {
    const rows = [...(s.reveal?.villageCoins || [])].sort((a, b) => b.coins - a.coins);
    const max = Math.max(1, ...rows.map((r) => r.coins));
    return el('div', { class: 'reveal-card s-2 cut-in' },
      el('p', { class: 'eyebrow' }, '02 — 마을별 코인'),
      el('h3', { class: 't-display-lg' }, '마을이 모은 코인'),
      el('div', { class: 'trust-list' },
        ...rows.map((r, i) => {
          const fill = el('div', {
            class: 'trust-fill',
            style: {
              background: 'var(--ink)',
              // 폭은 그 자리에서. 다음 프레임으로 미루면 다시 그려질 때 0 으로 남는다.
              width: `${Math.max(2, (r.coins / max) * 100)}%`,
              opacity: 0.85,
            },
          });
          return el('div', { class: 'trust-row' },
            el('div', { class: 'trust-name t-body-lg' },
              el('span', { class: 'trust-rank' }, String(i + 1)), swatch(r.color), `${r.emoji} ${r.name}`),
            el('div', { class: 'trust-track', style: { background: 'rgba(255,255,255,0.55)' } }, fill),
            el('div', { class: 'trust-val' }, String(r.coins)),
            el('div', { class: 'trust-delta flat' }, `${r.size}명`),
          );
        })),
      el('p', { class: 't-body-lg' }, '코인이 많은 마을이 신뢰도 높을까요?'),
    );
  }

  if (step === 3) {
    const ranked = [...villages].sort((a, b) => b.trust - a.trust);
    const coinTopVillage = [...(s.reveal?.villageCoins || [])].sort((a, b) => b.coins - a.coins)[0];
    const trustRankOfCoinLeader = coinTopVillage
      ? ranked.findIndex((v) => v.index === coinTopVillage.index) + 1 : 0;

    return el('div', { class: 'reveal-card s-3 cut-in' },
      el('p', { class: 'eyebrow' }, '03 — 최종 순위'),
      el('h3', { class: 't-display-lg' }, '마을 신뢰지수'),
      trustBars(villages, { ranked: true }),
      trustRankOfCoinLeader > 1
        ? el('div', { class: 'reveal-twist t-subhead' },
          `코인 1위는 ${coinTopVillage.name}인데, 신뢰지수는 ${trustRankOfCoinLeader}위예요.`)
        : el('p', { class: 't-body-lg' }, '순위는 신뢰지수로만 정합니다.'),
    );
  }

  // step 4 — 정직 선택률 그래프 + 마을회의 시점 표시선
  const rows = s.reveal?.honestByRound || [];
  const chart = el('div', { class: 'honest-chart', style: { '--cols': String(Math.max(1, rows.length)) } });

  rows.forEach((r) => {
    const bar = el('div', { class: `honest-bar ${r.honestRate == null ? 'empty' : ''}` },
      r.honestRate == null ? '—' : `${r.honestRate}%`);
    // 높이는 그 자리에서 정한다. requestAnimationFrame 으로 미루면 그 사이에
    // 카드가 다시 그려져 값이 붙지 않고, 막대가 전부 같은 높이로 남는다.
    bar.style.height = `${r.honestRate == null ? 12 : Math.max(12, r.honestRate)}%`;
    chart.append(el('div', { class: 'honest-col' },
      el('div', { class: 'honest-bar-wrap' }, bar),
      el('span', { class: 'honest-label' }, r.label),
    ));
  });

  // 마을회의는 2라운드와 3라운드 사이 → 두 칸 경계에 선을 긋는다
  const councilAt = rows.findIndex((r) => r.round === 3);
  if (councilAt > 0) {
    const pct = (councilAt / rows.length) * 100;
    chart.append(el('div', {
      class: 'council-marker',
      style: { left: `calc(${pct}% - 6px)` },
    }, el('span', {}, '마을회의')));
  }

  return el('div', { class: 'reveal-card s-4 cut-in' },
    el('p', { class: 'eyebrow' }, '04 — 정직 선택률'),
    el('h3', { class: 't-display-lg' }, '라운드마다 얼마나 정직했나'),
    chart,
    el('p', { class: 't-body-lg' },
      '정직 선택률 = (규칙대로 + 용기 내어 알리기) ÷ 제출 인원. 마을회의 뒤에 선이 올라갔나요?'),
  );
}

// ==================================================================
// 소감 벽
// ==================================================================

registerStage('reflect', (area, state) => {
  const wall = el('div', { class: 'wall' });
  const empty = el('p', { class: 't-subhead wall-empty' }, '학생 폰에서 소감을 보내면 여기에 붙습니다.');

  area.append(
    stageHead('소감', '오늘 우리가 겪은 것', '익명이에요. 100자까지.'),
    empty,
    wall,
  );

  const seen = new Set();

  function update(s) {
    const items = s.reflections || [];
    empty.classList.toggle('hidden', items.length > 0);
    items.forEach((r, i) => {
      let card = wall.querySelector(`[data-r="${r.id}"]`);
      if (!card) {
        card = el('div', { class: `wall-card ${BLOCK_CYCLE[i % BLOCK_CYCLE.length]}`, 'data-r': r.id },
          el('p', { class: 't-body-lg' }, r.text),
          el('p', { class: 'hearts' }, '♥ ', el('span', { class: 'heart-n' }, String(r.hearts || 0))),
        );
        wall.append(card);
        seen.add(r.id);
      } else {
        card.querySelector('.heart-n').textContent = String(r.hearts || 0);
      }
    });
  }

  area._update = update;
  update(state);
});

// ==================================================================
// 서약
// ==================================================================

registerStage('pledge', (area, state) => {
  const num = el('div', { class: 'pledge-count' }, '0');
  const total = el('span', { class: 't-subhead' }, '');
  const fill = el('div', { class: 'pledge-meter-fill' });

  area.append(el('div', { class: 'pledge-block' },
    el('p', { class: 'eyebrow' }, '오늘의 서약'),
    el('h2', { class: 't-display-lg pledge-words' },
      '아무도 보지 않을 때에도, 나는 우리 마을의 신뢰를 지키겠습니다.'),
    el('div', { class: 'pledge-meter' }, fill),
    el('div', { class: 'row', style: { gap: 'var(--s-sm)' } }, num, total),
    el('p', { class: 't-body-lg' }, '폰에서 서약 버튼을 눌러 주세요.'),
  ));

  function update(s) {
    // 분모는 "지금 여기 있는 사람" — 학생 화면의 카운터와 같은 기준이다.
    // 간 사람까지 세면 막대가 끝내 차지 않는다.
    const n = s.pledgeCount || 0;
    const here = Math.max(s.connectedCount || 0, n);
    countUp(num, n, 600);
    total.textContent = `/ ${here}명`;
    fill.style.width = here ? `${(n / here) * 100}%` : '0%';
  }

  area._update = update;
  update(state);
});

// ==================================================================
// 마무리
// ==================================================================

registerStage('end', (area, state, ctx) => {
  const grid = el('div', { class: 'end-grid' });

  area.append(
    stageHead('마무리', '수고했어요', '결과는 개인 식별 없이 집계만 내려받을 수 있어요.'),
    grid,
    el('div', { class: 'row', style: { gap: 'var(--s-sm)', marginTop: 'var(--s-lg)' } },
      el('a', {
        class: 'btn',
        href: `/api/session/${state.code}/results.csv`,
        download: `신뢰마을-${state.code}.csv`,
      }, '결과 CSV 내려받기'),
      el('button', {
        class: 'btn btn-secondary',
        onClick: () => ctx.send('host:goto', { stageId: 'reveal' }),
      }, '발표 화면으로 돌아가기'),
    ),
  );

  function update(s) {
    const ranked = [...s.villages].sort((a, b) => b.trust - a.trust);
    const best = ranked[0];
    const honest = (s.reveal?.honestByRound || []).filter((r) => r.honestRate != null);
    const avg = honest.length
      ? Math.round(honest.reduce((a, r) => a + r.honestRate, 0) / honest.length) : null;

    grid.innerHTML = '';
    grid.append(
      el('div', { class: 'end-stat', style: { background: best?.color || 'var(--surface-soft)' } },
        el('p', { class: 'eyebrow' }, '신뢰지수 1위'),
        el('p', { class: 't-card-title' }, best ? `${best.emoji} ${best.name}` : '—'),
        el('p', { class: 'end-stat-num' }, best ? String(best.trust) : '—')),
      el('div', { class: 'end-stat', style: { background: 'var(--surface-soft)' } },
        el('p', { class: 'eyebrow' }, '평균 정직 선택률'),
        el('p', { class: 'end-stat-num' }, avg == null ? '—' : `${avg}%`)),
      el('div', { class: 'end-stat', style: { background: 'var(--surface-soft)' } },
        el('p', { class: 'eyebrow' }, '함께한 사람'),
        el('p', { class: 'end-stat-num' }, String(s.playerCount))),
      el('div', { class: 'end-stat', style: { background: 'var(--surface-soft)' } },
        el('p', { class: 'eyebrow' }, '서약'),
        el('p', { class: 'end-stat-num' }, String(s.pledgeCount || 0))),
    );
  }

  area._update = update;
  update(state);
});
