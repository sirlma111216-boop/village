// 진행자 화면 — 입장 대기 · 워밍업 · 스토리 · 규칙

import { el, countUp, toast } from '../lib/dom.js';
import { getWarmup, getStory, storyArt, CHOICE_META, CHOICE_ORDER } from '../lib/content.js';
import { registerStage, stageHead, swatch } from './render.js';

// ==================================================================
// 입장 대기
// ==================================================================

registerStage('lobby', (area, state, ctx) => {
  const qrImg = el('img', { alt: '접속 QR 코드', src: ctx.join?.qr || '' });
  const codeBox = el('div', { class: 'join-code', title: '클릭하면 복사' });
  const urlLine = el('div', { class: 'join-url' });

  codeBox.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.code);
      toast('코드를 복사했어요');
    } catch { /* 권한이 없으면 조용히 넘어간다 */ }
  });

  const joinPanel = el('div', { class: 'join-panel' },
    el('p', { class: 'eyebrow' }, '폰으로 들어오세요'),
    el('div', { class: 'qr-frame' }, qrImg),
    urlLine,
    el('p', { class: 'caption' }, '코드'),
    codeBox,
    el('p', { class: 't-body-sm join-hint' }, ''),
  );

  const countNode = el('span', { class: 'roster-num' }, '0');
  const villageGrid = el('div', { class: 'village-grid' });
  const emptyHint = el('p', { class: 't-body-lg empty-hint' }, 'QR을 크게 띄워 주세요.');

  const rosterPanel = el('div', { class: 'roster-panel' },
    el('div', {},
      el('p', { class: 'eyebrow' }, '들어온 사람'),
      el('div', { class: 'roster-count' },
        countNode,
        el('span', { class: 't-subhead' }, '명'),
        el('span', { class: 'chip', style: { marginLeft: 'auto' } }, '이름 대신 익명 별명'),
      ),
    ),
    emptyHint,
    villageGrid,
  );

  area.append(el('div', { class: 'lobby' }, joinPanel, rosterPanel));

  function update(s) {
    countUp(countNode, s.playerCount);
    emptyHint.classList.toggle('hidden', s.playerCount > 0);
    codeBox.textContent = s.code;
    if (ctx.join?.qr) qrImg.src = ctx.join.qr;
    if (ctx.join?.url) urlLine.textContent = ctx.join.url;
    // 배포된 주소면 그대로 안내한다. 내 컴퓨터에서 띄운 것이면 폰은 아직 못 들어온다.
    const hint = joinPanel.querySelector('.join-hint');
    hint.textContent = ctx.join?.hosted
      ? '어디서든 이 주소로 들어올 수 있어요.'
      : '지금은 이 컴퓨터에서만 열려요 — 미리보기입니다.';

    const byVillage = s.villages.map(() => []);
    for (const p of s.roster) (byVillage[p.villageIndex] ||= []).push(p);

    if (villageGrid.children.length !== s.villages.length) {
      villageGrid.innerHTML = '';
      for (const v of s.villages) {
        villageGrid.append(el('div', { class: 'village-box', style: { background: v.color } },
          el('div', { class: 'village-box-head t-card-title' },
            el('span', {}, `${v.emoji} ${v.name}`),
            el('span', { class: 'n' }, '0'),
          ),
          el('div', { class: 'name-list' }),
        ));
      }
    }
    s.villages.forEach((v, i) => {
      const box = villageGrid.children[i];
      if (!box) return;
      const members = byVillage[i] || [];
      box.querySelector('.n').textContent = String(members.length);
      const list = box.querySelector('.name-list');
      const have = new Map([...list.children].map((n) => [n.dataset.nick, n]));
      for (const m of members) {
        let tag = have.get(m.nickname);
        if (!tag) {
          tag = el('span', { class: 'name-tag', 'data-nick': m.nickname }, `${m.emoji} ${m.nickname}`);
          list.append(tag);
        } else have.delete(m.nickname);
        tag.classList.toggle('off', !m.connected);
      }
      for (const stale of have.values()) stale.remove();
    });
  }

  area._update = update;
  update(state);
});

// ==================================================================
// 워밍업 투표
// ==================================================================

registerStage('warmup', (area, state) => {
  const grid = el('div', { class: 'warmup-grid' });
  area.append(
    stageHead('워밍업', '먼저, 두 가지만 물어볼게', '폰에서 골라 주세요. 정답은 없어요.'),
    grid,
  );

  const BLOCKS = ['block-lilac', 'block-mint'];
  let questions = [];
  const bars = new Map();   // `${qid}:${i}` → { fill, pct, count }

  getWarmup().then((qs) => {
    questions = qs;
    grid.innerHTML = '';
    qs.forEach((q, qi) => {
      const opts = el('div', { class: 'warmup-opts' });
      q.options.forEach((o, oi) => {
        const fill = el('div', { class: 'warmup-bar-fill' });
        const pct = el('span', { class: 'warmup-opt-pct t-body-lg' }, '0%');
        const count = el('span', { class: 'caption' }, '0명');
        bars.set(`${q.id}:${oi}`, { fill, pct, count });
        opts.append(el('div', { class: 'warmup-opt' },
          el('div', { class: 'warmup-opt-head' },
            el('span', { class: 'warmup-opt-label t-body-lg' }, `${o.emoji} ${o.label}`),
            pct,
          ),
          el('div', { class: 'warmup-bar' }, fill),
          count,
        ));
      });

      const voted = el('span', { class: 'chip chip-on-block' }, '0명 투표');
      grid.append(el('div', { class: `warmup-card ${BLOCKS[qi % BLOCKS.length]}`, 'data-q': q.id },
        el('p', { class: 'eyebrow' }, q.eyebrow),
        el('h3', { class: 't-display-lg' }, q.text),
        opts,
        el('div', { class: 'warmup-foot' }, voted),
      ));
      grid.lastChild._voted = voted;
    });
    update(state);
  });

  function update(s) {
    for (const q of questions) {
      const tally = s.warmup?.[q.id] || {};
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      q.options.forEach((o, oi) => {
        const node = bars.get(`${q.id}:${oi}`);
        if (!node) return;
        const n = tally[oi] || 0;
        const pct = total ? Math.round((n / total) * 100) : 0;
        node.fill.style.width = `${pct}%`;
        node.pct.textContent = `${pct}%`;
        node.count.textContent = `${n}명`;
      });
      const card = grid.querySelector(`[data-q="${q.id}"]`);
      if (card?._voted) card._voted.textContent = `${total}명 투표 / 접속 ${s.connectedCount}명`;
    }
  }

  area._update = update;
});

// ==================================================================
// 기게스의 반지
// ==================================================================

registerStage('story', (area) => {
  const strip = el('div', { class: 'story-strip' });
  const head = stageHead('옛날 이야기', '기게스의 반지', '');
  area.append(head, strip);

  const BLOCKS = ['block-cream', 'block-coral', 'block-navy'];

  getStory().then((story) => {
    head.querySelector('.t-subhead')?.remove();
    head.append(el('p', { class: 't-subhead' }, story.source));
    strip.innerHTML = '';
    story.panels.forEach((p, i) => {
      strip.append(el('div', { class: `story-panel ${BLOCKS[i % BLOCKS.length]} rise rise-${i}` },
        el('p', { class: 'eyebrow' }, p.eyebrow),
        storyArt(p),
        el('p', { class: 't-subhead' }, p.text),
      ));
    });
    area.append(el('div', { class: 'story-closing' },
      el('p', { class: 't-display-lg' }, story.closing)));
  });
});

// ==================================================================
// 규칙 안내
// ==================================================================

registerStage('rules', (area, state) => {
  const grid = el('div', { class: 'rules-grid' });

  for (const key of CHOICE_ORDER) {
    const m = CHOICE_META[key];
    grid.append(el('div', { class: `rule-card is-${key}` },
      el('p', { class: 'eyebrow' }, key.toUpperCase()),
      el('h3', { class: 't-headline' }, `${m.emoji} ${m.name}`),
      el('div', { class: 'rule-eff t-body-lg' },
        el('div', { class: 'rule-eff-row' }, el('span', {}, '내 코인'), el('b', {}, m.coin)),
        el('div', { class: 'rule-eff-row' }, el('span', {}, '마을 신뢰'), el('b', {}, m.trustReal)),
      ),
      key === 'a'
        ? el('p', { class: 't-body-sm' }, '학생 화면에는 마을 영향이 ??? 로만 보입니다.')
        : null,
    ));
  }

  area.append(
    stageHead('규칙', '한 번에 하나만, 비밀로', '누가 무엇을 골랐는지는 아무도 볼 수 없어요.'),
    grid,
    el('div', { class: 'rules-note' },
      el('div', { class: 'tile' },
        el('p', { class: 'eyebrow' }, '마을 신뢰지수'),
        el('p', { class: 't-body' }, `모든 마을이 ${60} 에서 시작해요. 0 아래로도, 100 위로도 가지 않아요. 마을 인원이 달라도 공정하도록 인원수로 나눠 계산합니다.`)),
      el('div', { class: 'tile' },
        el('p', { class: 'eyebrow' }, '최종 순위' ),
        el('p', { class: 't-body' }, '순위는 마을 신뢰지수로만 정합니다. 개인 코인은 참고용이에요.')),
      el('div', { class: 'tile' },
        el('p', { class: 'eyebrow' }, '라운드'),
        el('p', { class: 't-body' }, `연습 한 번 뒤에 네 번. 한 라운드는 ${state.settings.roundSeconds}초, 필요하면 늘려 줄게요.`)),
    ),
  );
});
