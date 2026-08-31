// 단계별 진행자 화면 그리기 — 등록소와 공용 부품.
// 개인의 선택은 이 화면에 그릴 수 없다. 그릴 데이터가 애초에 오지 않는다.

import { el } from '../lib/dom.js';

const renderers = {};

export function registerStage(kind, fn) {
  renderers[kind] = fn;
}

export function renderStage(area, state, ctx) {
  const kind = state.stage?.kind || 'lobby';
  if (area.dataset.kind === kind && typeof area._update === 'function') {
    area._update(state);
    return;
  }
  area._cleanup?.();
  area.innerHTML = '';
  area._update = null;
  area._cleanup = null;
  area.dataset.kind = kind;
  (renderers[kind] || renderTodo)(area, state, ctx);
}

function renderTodo(area, state) {
  area.append(el('div', { class: 'todo-stage' },
    el('p', { class: 'eyebrow' }, '준비 중'),
    el('h2', { class: 't-display-lg' }, state.stage?.label || ''),
    el('p', { class: 't-body-lg' }, '이 단계 화면은 다음 개발 단계에서 만들어집니다.'),
  ));
}

// ==================================================================
// 공용 부품
// ==================================================================

export function stageHead(eyebrow, title, sub) {
  return el('div', { class: 'stage-head' },
    el('p', { class: 'eyebrow' }, eyebrow),
    el('h2', { class: 't-display-lg' }, title),
    sub ? el('p', { class: 't-subhead' }, sub) : null,
  );
}

export const swatch = (color) => el('span', { class: 'swatch', style: { background: color } });

/** a/b/c 분포 띠 — 사람이 아니라 개수만 그린다 */
export function mixBar(counts, submitted) {
  const pct = (n) => (submitted ? Math.round((n / submitted) * 100) : 0);
  return el('div', { class: 'mix' },
    ...['a', 'b', 'c'].map((k) => el('span', {
      class: `mix-seg mix-${k}`,
      style: { width: `${pct(counts[k] || 0)}%` },
      title: `${counts[k] || 0}명`,
    }, pct(counts[k] || 0) >= 12 ? `${pct(counts[k] || 0)}%` : '')),
  );
}

export function choiceLegend() {
  return el('div', { class: 'legend caption' },
    el('span', { class: 'legend-item' },
      el('span', { class: 'legend-key', style: { background: 'var(--choice-a)' } }), '몰래 이득'),
    el('span', { class: 'legend-item' },
      el('span', { class: 'legend-key', style: { background: 'var(--choice-b)' } }), '규칙대로'),
    el('span', { class: 'legend-item' },
      el('span', { class: 'legend-key', style: { background: 'var(--choice-c)' } }), '용기 내어 알리기'),
  );
}

/**
 * 마을 신뢰지수 가로 막대.
 *
 * 폭은 만들 때 바로 넣는다. 예전에는 0 에서 시작해 다음 프레임에 목표 폭을
 * 넣었는데, 이 화면은 상태가 올 때마다 다시 그려져서 그 프레임이 오기 전에
 * 막대가 교체된다. 그러면 폭이 영영 0 으로 남는다.
 * @param {object[]} villages
 * @param {{ranked?:boolean, deltas?:Record<number, number>}} opts
 */
export function trustBars(villages, opts = {}) {
  const rows = opts.ranked
    ? [...villages].sort((a, b) => b.trust - a.trust)
    : villages;

  const list = el('div', { class: 'trust-list' });
  rows.forEach((v, i) => {
    const fill = el('div', {
      class: 'trust-fill',
      style: { background: v.color, width: `${Math.max(2, v.trust)}%` },
    });
    const delta = opts.deltas?.[v.index];
    list.append(el('div', { class: 'trust-row' },
      el('div', { class: 'trust-name t-body-lg' },
        opts.ranked ? el('span', { class: 'trust-rank' }, String(i + 1)) : null,
        swatch(v.color),
        `${v.emoji} ${v.name}`,
      ),
      el('div', { class: 'trust-track' }, fill),
      el('div', { class: 'trust-val' }, String(v.trust)),
      el('div', { class: `trust-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}` },
        delta == null ? '' : delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${delta}`),
    ));
  });
  return list;
}

/** 익명 코인 순위 줄 */
export function coinRows(rows, villages, medals = false) {
  const MEDAL = ['🥇', '🥈', '🥉'];
  return rows.map((r, i) => {
    const v = villages[r.villageIndex];
    return el('div', { class: 'coin-row' },
      medals
        ? el('span', { class: 'podium-medal' }, MEDAL[i] || '')
        : el('span', { class: 'coin-rank' }, String(i + 1)),
      el('span', { class: 'coin-nick t-body-lg' }, `${r.emoji} ${r.nickname}`),
      v ? el('span', { class: 'podium-village t-body-sm' }, swatch(v.color), v.name) : null,
      el('span', { class: 'coin-val' }, String(r.coins)),
    );
  });
}
