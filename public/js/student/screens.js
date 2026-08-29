// 학생 화면 — 단계별 화면 등록소.
// 서버가 보내 주는 값은 전부 "나 자신의" 것이다. 남의 선택은 애초에 오지 않는다.

import { el, countUp } from '../lib/dom.js';
import { getWarmup, getStory, storyArt, getInstitutions, CHOICE_META, CHOICE_ORDER } from '../lib/content.js';
import { createRoundScreen } from './round.js';

/** kind → (handlers) => { root, update, cleanup } */
const screens = {};
export const registerScreen = (kind, factory) => { screens[kind] = factory; };

export function createScreen(kind, handlers) {
  const factory = screens[kind] || todoScreen;
  return factory(handlers);
}

// ------------------------------------------------------------------ 아직 없는 단계

function todoScreen() {
  const label = el('h2', { class: 't-card-title' }, '진행 중');
  const root = el('div', { class: 'todo-stage cut-in' },
    el('p', { class: 'eyebrow' }, '준비 중'),
    label,
    el('p', { class: 't-body' }, '이 화면은 다음 개발 단계에서 만들어집니다.'),
    el('p', { class: 't-body-sm', style: { opacity: 0.5 } }, '선생님 화면을 봐 주세요.'),
  );
  return { root, update: (s) => { label.textContent = s.stage?.label || '진행 중'; } };
}

/** 여러 화면이 함께 쓰는 "앞을 봐 주세요" 안내 */
function lookUp(text = '앞 화면을 봐 주세요') {
  return el('div', { class: 'lookup' },
    el('span', { class: 'lookup-mark' }, '👆'),
    el('p', { class: 't-body-lg' }, text),
  );
}

/** 내 코인 · 우리 마을 신뢰지수 요약 (여러 단계에서 재사용) */
function myNumbers() {
  const coins = el('span', { class: 'fig-num' }, '0');
  const trust = el('span', { class: 'fig-num' }, '60');
  const villageName = el('span', { class: 't-body-sm' }, '');
  const card = el('div', { class: 'figures' },
    el('div', { class: 'fig' },
      el('p', { class: 'caption' }, '내 코인'),
      coins),
    el('div', { class: 'fig' },
      el('p', { class: 'caption' }, '우리 마을 신뢰지수'),
      trust,
      villageName),
  );
  return {
    node: card,
    update(s) {
      countUp(coins, s.me.coins, 500);
      countUp(trust, s.village?.trust ?? 0, 700);
      villageName.textContent = s.village ? `${s.village.emoji} ${s.village.name}` : '';
    },
  };
}

// ==================================================================
// 라운드
// ==================================================================

registerScreen('round', (handlers) => createRoundScreen(handlers));

// ==================================================================
// 워밍업 투표
// ==================================================================

registerScreen('warmup', ({ onWarmupVote }) => {
  const list = el('div', { class: 'q-list' });
  const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } },
    el('div', { class: 'stage-intro' },
      el('p', { class: 'eyebrow' }, '워밍업'),
      el('h2', { class: 's-title' }, '두 가지만 물어볼게'),
      el('p', { class: 't-body' }, '정답은 없어. 지금 생각대로 골라 줘.'),
    ),
    list,
  );

  let questions = [];
  const nodes = new Map();   // qid → { buttons:Map(idx→node), bars:Map(idx→{fill,pct}) }

  getWarmup().then((qs) => {
    questions = qs;
    list.innerHTML = '';
    const BLOCKS = ['block-lilac', 'block-mint'];
    qs.forEach((q, qi) => {
      const buttons = new Map();
      const bars = new Map();
      const opts = el('div', { class: 'q-opts' });

      q.options.forEach((o, oi) => {
        const fill = el('div', { class: 'q-bar-fill' });
        const pct = el('span', { class: 'q-pct caption' }, '');
        const btn = el('button', {
          class: 'q-opt',
          type: 'button',
          onClick: () => onWarmupVote(q.id, oi),
        },
          el('span', { class: 'q-bar' }, fill),
          el('span', { class: 'q-opt-body' },
            el('span', { class: 'q-emoji' }, o.emoji),
            el('span', { class: 'q-label' }, o.label),
            pct,
          ),
        );
        buttons.set(oi, btn);
        bars.set(oi, { fill, pct });
        opts.append(btn);
      });

      nodes.set(q.id, { buttons, bars });
      list.append(el('div', { class: `q-card ${BLOCKS[qi % BLOCKS.length]}` },
        el('p', { class: 'eyebrow' }, q.eyebrow),
        el('h3', { class: 'q-text' }, q.text),
        opts,
      ));
    });
  });

  function update(s) {
    for (const q of questions) {
      const n = nodes.get(q.id);
      if (!n) continue;
      const mine = s.myWarmup?.[q.id];
      const tally = s.warmup?.[q.id] || {};
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      const voted = mine != null;

      q.options.forEach((o, oi) => {
        const btn = n.buttons.get(oi);
        const { fill, pct } = n.bars.get(oi);
        btn.classList.toggle('picked', mine === oi);
        // 투표하기 전에는 남들 결과를 보여 주지 않는다 — 눈치보지 않게
        const share = voted && total ? Math.round(((tally[oi] || 0) / total) * 100) : 0;
        fill.style.width = voted ? `${share}%` : '0%';
        pct.textContent = voted ? `${share}%` : '';
      });
    }
  }

  return { root, update };
});

// ==================================================================
// 기게스의 반지
// ==================================================================

registerScreen('story', () => {
  const strip = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } });
  const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } }, strip);

  getStory().then((story) => {
    const BLOCKS = ['block-cream', 'block-coral', 'block-navy'];
    strip.innerHTML = '';
    strip.append(el('div', { class: 'stage-intro' },
      el('p', { class: 'eyebrow' }, '옛날 이야기'),
      el('h2', { class: 's-title' }, story.title),
      el('p', { class: 't-body-sm', style: { opacity: 0.6 } }, story.source),
    ));
    story.panels.forEach((p, i) => {
      strip.append(el('div', { class: `panel ${BLOCKS[i % BLOCKS.length]} rise rise-${i}` },
        el('p', { class: 'eyebrow' }, p.eyebrow),
        storyArt(p, { className: 'panel-art', emojiClass: 'panel-emoji' }),
        el('p', { class: 't-body-lg' }, p.text),
      ));
    });
    strip.append(el('p', { class: 's-title', style: { marginTop: 'var(--s-sm)' } }, story.closing));
  });

  return { root, update: () => {} };
});

// ==================================================================
// 규칙
// ==================================================================

registerScreen('rules', () => {
  const cards = el('div', { class: 'stack', style: { gap: 'var(--s-sm)' } });

  for (const key of CHOICE_ORDER) {
    const m = CHOICE_META[key];
    cards.append(el('div', { class: `rule-card is-${key}` },
      el('p', { class: 'rc-key' }, key.toUpperCase()),
      el('h3', { class: 't-card-title' }, `${m.emoji} ${m.name}`),
      el('div', { class: 'rule-eff' },
        el('span', {}, `내 코인 ${m.coin}`),
        el('span', {}, `마을 신뢰 ${key === 'a' ? '???' : m.trustReal}`),
      ),
    ));
  }

  const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } },
    el('div', { class: 'stage-intro' },
      el('p', { class: 'eyebrow' }, '규칙'),
      el('h2', { class: 's-title' }, '셋 중 하나를, 비밀로'),
      el('p', { class: 't-body' }, '누가 무엇을 골랐는지는 선생님도 볼 수 없어.'),
    ),
    cards,
    el('div', { class: 'notice' },
      '순위는 <b>마을 신뢰지수</b>로만 정해. 코인은 참고용이야.'),
  );
  root.querySelector('.notice').innerHTML = '순위는 <b>마을 신뢰지수</b>로만 정해. 코인은 참고용이야.';

  return { root, update: () => {} };
});

// ==================================================================
// 중간 집계 · 최종 발표 · 마무리 — 앞 화면을 보는 시간
// ==================================================================

function summaryScreen({ eyebrow, title, note }) {
  return () => {
    const figs = myNumbers();
    const rank = el('div', { class: 'rank-list' });
    const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } },
      el('div', { class: 'stage-intro' },
        el('p', { class: 'eyebrow' }, eyebrow),
        el('h2', { class: 's-title' }, title),
      ),
      figs.node,
      rank,
      note ? el('p', { class: 't-body-sm', style: { opacity: 0.6 } }, note) : null,
      lookUp(),
    );

    function update(s) {
      figs.update(s);
      const ranked = [...s.villages].sort((a, b) => b.trust - a.trust);
      rank.innerHTML = '';
      rank.append(el('p', { class: 'caption' }, '마을 신뢰지수'));
      ranked.forEach((v, i) => {
        const mine = v.index === s.me.villageIndex;
        rank.append(el('div', { class: `rank-row${mine ? ' is-mine' : ''}` },
          el('span', { class: 'rank-no' }, String(i + 1)),
          el('span', { class: 'swatch', style: { background: v.color } }),
          el('span', { class: 'rank-name' }, `${v.emoji} ${v.name}${mine ? ' · 우리' : ''}`),
          el('span', { class: 'rank-val' }, String(v.trust)),
        ));
      });
    }

    return { root, update };
  };
}

registerScreen('interim', summaryScreen({
  eyebrow: '중간 집계',
  title: '여기까지 왔어',
  note: '아직 두 라운드 남았어. 뒤집을 수 있어.',
}));

registerScreen('reveal', summaryScreen({
  eyebrow: '최종 발표',
  title: '결과를 열고 있어',
  note: '앞 화면에서 하나씩 공개돼. 코인 1등이 꼭 신뢰 1등은 아니야.',
}));

registerScreen('end', () => {
  const figs = myNumbers();
  const result = el('div', { class: 'end-card' });
  const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } },
    el('div', { class: 'stage-intro' },
      el('p', { class: 'eyebrow' }, '수업 끝'),
      el('h2', { class: 's-title' }, '오늘 고마웠어'),
    ),
    result,
    figs.node,
    el('div', { class: 'notice' },
      '네가 무엇을 골랐는지는 아무 데도 저장되지 않았어. 마을별 숫자만 남아 있어.'),
  );

  function update(s) {
    figs.update(s);
    const ranked = [...s.villages].sort((a, b) => b.trust - a.trust);
    const myRank = ranked.findIndex((v) => v.index === s.me.villageIndex) + 1;
    const v = s.village;
    result.innerHTML = '';
    result.style.background = v?.color || 'var(--surface-soft)';
    result.append(
      el('p', { class: 'caption' }, '우리 마을'),
      el('p', { class: 's-title' }, v ? `${v.emoji} ${v.name}` : '-'),
      el('p', { class: 't-body-lg' }, `신뢰지수 ${v?.trust ?? 0} · ${myRank}위`),
    );
  }

  return { root, update };
});
