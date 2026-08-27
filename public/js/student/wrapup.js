// 학생 화면 — 마을회의 · 소감 벽 · 서약.
// 수업의 마지막 세 장면. 여기서도 남의 선택은 오지 않고, 오는 것은 숫자와 글뿐이다.

import { el, countUp } from '../lib/dom.js';
import { getInstitutions } from '../lib/content.js';
import { registerScreen } from './screens.js';

// ==================================================================
// 마을회의 — 제도 카드 3개 · 득표수 · 투표 버튼
// ==================================================================

registerScreen('council', ({ onCouncilVote }) => {
  const cards = el('div', { class: 'stack', style: { gap: 'var(--s-sm)' } });
  const status = el('div', { class: 'council-now' });

  const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } },
    el('div', { class: 'stage-intro' },
      el('p', { class: 'eyebrow' }, '마을회의'),
      el('h2', { class: 's-title' }, '우리 마을 규칙을 정하자'),
      el('p', { class: 't-body' }, '마을끼리 이야기해 보고 하나를 골라. 3·4라운드에 실제로 적용돼.'),
    ),
    status,
    cards,
    el('p', { class: 't-body-sm', style: { opacity: 0.55 } },
      '마음은 바꿀 수 있어. 우리 마을 표만 보이고, 누가 뭘 골랐는지는 안 보여.'),
  );

  let list = [];
  const nodes = new Map();

  getInstitutions().then((items) => {
    list = items;
    const BLOCKS = ['block-mint', 'block-coral', 'block-lilac'];
    cards.innerHTML = '';
    items.forEach((inst, i) => {
      const count = el('span', { class: 'vote-count' }, '0표');
      const bar = el('div', { class: 'vote-bar-fill' });
      const btn = el('button', {
        class: 'btn btn-on-block block-full',
        type: 'button',
        onClick: () => onCouncilVote(inst.id),
      }, '이걸로 하자');

      const card = el('div', { class: `inst-card ${BLOCKS[i % BLOCKS.length]}`, 'data-inst': inst.id },
        el('div', { class: 'inst-head' }, el('span', { class: 'inst-big' }, inst.emoji), count),
        el('h3', { class: 't-card-title' }, inst.name),
        el('p', { class: 't-body' }, inst.detail),
        el('p', { class: 't-body-sm', style: { opacity: 0.7 } }, inst.cost),
        el('div', { class: 'vote-bar' }, bar),
        btn,
      );
      nodes.set(inst.id, { btn, count, bar, card });
      cards.append(card);
    });
  });

  function update(s) {
    const c = s.council;
    if (!c) return;
    const mine = s.myCouncilVote;
    const lead = list.find((x) => x.id === c.leading);

    status.innerHTML = '';
    status.append(
      el('span', { class: 'chip' }, `${c.voted} / ${c.size}명 투표`),
      c.leading
        ? el('span', { class: 'chip chip-solid' }, `현재 1위 · ${lead ? lead.name : c.leading}`)
        : el('span', { class: 'chip' }, '아직 표가 없어'),
    );

    for (const inst of list) {
      const n = nodes.get(inst.id);
      if (!n) continue;
      const votes = c.counts[inst.id] || 0;
      n.count.textContent = `${votes}표`;
      n.bar.style.width = c.voted ? `${Math.round((votes / c.voted) * 100)}%` : '0%';
      n.card.classList.toggle('is-mine', mine === inst.id);
      n.btn.textContent = mine === inst.id ? '내가 고른 것' : '이걸로 하자';
      n.btn.disabled = mine === inst.id;
    }
  }

  return { root, update };
});

// ==================================================================
// 소감 벽 — 익명 카드 + 하트
// ==================================================================

const WALL_BLOCKS = ['block-lime', 'block-lilac', 'block-cream', 'block-mint', 'block-pink', 'block-coral'];

registerScreen('reflect', ({ onReflect, onHeart, maxLen = 100, maxPerStudent = 3 }) => {
  const input = el('textarea', {
    class: 'reflect-input',
    maxlength: String(maxLen),
    rows: '3',
    placeholder: '오늘 겪은 걸 한 줄로 남겨 줘',
    'aria-label': '소감 쓰기',
  });
  const counter = el('span', { class: 'caption reflect-counter' }, `0 / ${maxLen}`);
  const sendBtn = el('button', { class: 'btn', type: 'button', disabled: true }, '벽에 붙이기');
  const note = el('p', { class: 't-body-sm reflect-note' }, '이름은 붙지 않아. 아무도 누가 썼는지 몰라.');

  const composer = el('div', { class: 'reflect-composer' },
    input,
    el('div', { class: 'reflect-foot' }, counter, sendBtn),
    note,
  );
  const doneNote = el('p', { class: 't-body-sm hidden', style: { opacity: 0.5, textAlign: 'center' } },
    '다 썼어. 이제 다른 사람 소감에 하트를 눌러 줘.');

  const wall = el('div', { class: 'wall' });
  const empty = el('p', {
    class: 't-body-sm',
    style: { opacity: 0.45, textAlign: 'center', padding: 'var(--s-lg) 0' },
  }, '아직 아무도 안 붙였어. 첫 번째가 되어 볼래?');

  const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } },
    el('div', { class: 'stage-intro' },
      el('p', { class: 'eyebrow' }, '소감'),
      el('h2', { class: 's-title' }, '오늘, 어땠어?'),
    ),
    composer,
    doneNote,
    empty,
    wall,
  );

  function resetNote() {
    note.textContent = '이름은 붙지 않아. 아무도 누가 썼는지 몰라.';
    note.classList.remove('error');
  }

  input.addEventListener('input', () => {
    const n = [...input.value].length;
    counter.textContent = `${n} / ${maxLen}`;
    counter.classList.toggle('over', n > maxLen);
    sendBtn.disabled = n === 0 || n > maxLen;
    resetNote();
  });

  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    const res = await onReflect(input.value);
    if (res?.ok) {
      input.value = '';
      counter.textContent = `0 / ${maxLen}`;
      note.textContent = '붙였어. 고마워.';
      note.classList.remove('error');
    } else {
      note.textContent = res?.error || '보내지 못했어.';
      note.classList.add('error');
      sendBtn.disabled = false;
    }
  });

  function update(s) {
    const items = s.reflections || [];
    const mine = new Set(s.myHearts || []);
    empty.classList.toggle('hidden', items.length > 0);

    const left = maxPerStudent - (s.myReflections || 0);
    composer.classList.toggle('hidden', left <= 0);
    doneNote.classList.toggle('hidden', left > 0);

    for (const r of items) {
      let card = wall.querySelector(`[data-r="${r.id}"]`);
      if (!card) {
        card = el('div', {
          class: `wall-card ${WALL_BLOCKS[wall.children.length % WALL_BLOCKS.length]}`,
          'data-r': r.id,
        },
          el('p', { class: 't-body' }, r.text),
          el('button', { class: 'heart-btn', type: 'button', onClick: () => onHeart(r.id) },
            el('span', { class: 'heart-ico' }, '♥'),
            el('span', { class: 'heart-n' }, String(r.hearts || 0)),
          ),
        );
        wall.append(card);
      }
      card.querySelector('.heart-n').textContent = String(r.hearts || 0);
      card.querySelector('.heart-btn').classList.toggle('on', mine.has(r.id));
    }
  }

  return { root, update };
});

// ==================================================================
// 서약
// ==================================================================

registerScreen('pledge', ({ onPledgeFinal }) => {
  const fill = el('div', { class: 'pledge-fill' });
  const count = el('span', { class: 'pledge-n' }, '0');
  const total = el('span', { class: 't-body' }, '');

  const btn = el('button', {
    class: 'btn btn-lg block-full',
    type: 'button',
    onClick: () => onPledgeFinal(true),
  }, '나도 서약할게');

  const done = el('div', { class: 'pledge-done hidden' },
    el('span', { class: 'pledge-check' }, '✓'),
    el('p', { class: 't-body-lg' }, '서약했어'),
    el('button', { class: 'btn btn-text', type: 'button', onClick: () => onPledgeFinal(false) }, '취소'),
  );

  const root = el('div', { class: 'stack', style: { gap: 'var(--s-md)' } },
    el('div', { class: 'pledge-block' },
      el('p', { class: 'eyebrow' }, '오늘의 서약'),
      el('h2', { class: 'pledge-words' },
        '아무도 보지 않을 때에도, 나는 우리 마을의 신뢰를 지키겠습니다.'),
      el('div', { class: 'pledge-meter' }, fill),
      el('div', { class: 'row', style: { gap: '0.4em', justifyContent: 'center' } }, count, total),
    ),
    btn,
    done,
  );

  function update(s) {
    // 분모는 "지금 여기 있는 사람" — 진행자 화면의 막대와 같은 기준이다
    const n = s.pledgeCount || 0;
    const here = Math.max(s.connectedCount || 0, n);
    countUp(count, n, 500);
    total.textContent = `/ ${here}명이 서약했어`;
    fill.style.width = here ? `${(n / here) * 100}%` : '0%';
    btn.classList.toggle('hidden', Boolean(s.myPledged));
    done.classList.toggle('hidden', !s.myPledged);
  }

  return { root, update };
});
