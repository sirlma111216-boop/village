// 학생 라운드 화면 — 시나리오 · 선택 버튼 3개 · 제출 잠금 · 내 결과.
// 서버가 보내 주는 값은 전부 "나 자신의" 것이다. 남의 선택은 애초에 오지 않는다.

import { el } from '../lib/dom.js';
import { getScenario, getInstitution, scenarioArt, CHOICE_META, CHOICE_ORDER } from '../lib/content.js';
import { syncClock, startCountdown, formatClock } from '../lib/clock.js';

export function createRoundScreen({ onChoose, onPledge }) {
  let stopClock = null;
  let loadedScenario = null;
  let sending = false;

  const badge = el('span', { class: 'eyebrow' });
  const timer = el('span', { class: 'r-timer' }, '');
  const title = el('h2', { class: 'r-title' });
  const artSlot = el('div', { class: 'art-slot' });
  const story = el('p', { class: 't-body-lg' });

  const buttons = el('div', { class: 'r-choices' });
  const choiceNodes = new Map();

  // 자물쇠는 직접 그린다 — 이모지는 기기마다 모양이 달라 크게 키우면 흐트러진다
  const lockMark = el('div', { class: 'lock-mark', 'aria-hidden': 'true' });
  lockMark.innerHTML = `<svg viewBox="0 0 48 60" width="100%" height="100%">
    <path d="M11 26V17a13 13 0 0 1 26 0v9" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
    <rect x="3" y="25" width="42" height="32" rx="8" fill="currentColor"/>
    <circle cx="24" cy="38" r="4.6" fill="#fff"/>
    <rect x="21.7" y="38" width="4.6" height="9" rx="2.3" fill="#fff"/>
  </svg>`;

  const lockChoice = el('div', { class: 'lock-choice' });
  const lockCount = el('p', { class: 'caption lock-count' }, '');
  const lock = el('div', { class: 'r-lock hidden' },
    lockMark,
    el('h3', { class: 'lock-title' }, '제출 완료'),
    el('p', { class: 'lock-line' }, '네 선택은 아무도 볼 수 없어'),
    lockChoice,
    el('p', { class: 't-body-sm lock-sub' }, '선생님이 마감할 때까지 기다려 줘'),
    lockCount,
  );

  const resultBox = el('div', { class: 'hidden' });
  const instBox = el('div', { class: 'hidden' });
  const ledgerBox = el('div', { class: 'hidden' });

  const root = el('div', { class: 'r-wrap' },
    el('div', { class: 'r-card' },
      el('div', { class: 'r-head' }, badge, timer),
      title,
      artSlot,
      story,
      instBox,
      ledgerBox,
      buttons,
      lock,
    ),
    resultBox,
  );

  // ---------------------------------------------------------------- 선택 버튼
  function buildButtons(scenario) {
    buttons.innerHTML = '';
    choiceNodes.clear();
    for (const key of CHOICE_ORDER) {
      const meta = CHOICE_META[key];
      const c = scenario.choices[key];
      const node = el('button', {
        class: `r-choice is-${key}`,
        type: 'button',
        onClick: () => pick(key),
      },
        el('span', { class: 'rc-key' }, key.toUpperCase()),
        el('span', { class: 'rc-label' }, c.label),
        el('span', { class: 'rc-sub' }, c.sub),
        el('span', { class: 'rc-eff' },
          el('span', {}, `코인 ${meta.coin}`),
          // a 의 마을 영향은 학생에게 감춘다 — 이 수업의 핵심 장치
          el('span', { class: `rc-trust ${key === 'a' ? 'unknown' : ''}` }, `신뢰 ${meta.trust}`),
        ),
      );
      choiceNodes.set(key, node);
      buttons.append(node);
    }
  }

  async function pick(key) {
    if (sending) return;
    sending = true;
    for (const n of choiceNodes.values()) n.disabled = true;
    choiceNodes.get(key)?.classList.add('picked');
    try { await onChoose(key); } finally { sending = false; }
  }

  // ---------------------------------------------------------------- 내 결과
  function renderResult(round) {
    const mine = round.myResult;
    const vr = round.villageResult;
    resultBox.innerHTML = '';
    if (!mine && !vr) return;

    const rows = [];

    if (mine) {
      const meta = CHOICE_META[mine.choice];
      rows.push(el('div', { class: 'stack', style: { gap: 'var(--s-xs)' } },
        el('p', { class: 'caption' }, '내가 고른 것 · 나만 보여'),
        el('div', { class: `res-choice is-${mine.choice}` }, `${meta.emoji} ${meta.name}`),
      ));

      if (mine.scoring) {
        rows.push(el('div', { class: 'res-coin' },
          el('span', { class: 't-body-lg' }, '내 코인'),
          el('b', {}, `${mine.coinDelta > 0 ? '+' : ''}${mine.coinDelta}`),
        ));
        if (mine.caught) {
          rows.push(el('div', { class: 'res-caught t-body-lg' },
            '감사에 적발됐어. 코인 4개를 잃었어.',
            el('span', { class: 't-body-sm block-line' }, '이 사실은 네 화면에만 보여.')));
        }
        if (mine.bonus) rows.push(el('div', { class: 'res-bonus t-body-lg' }, '서약을 지켰어. 코인 +1'));
      } else {
        rows.push(el('p', { class: 't-body-sm', style: { opacity: 0.6 } }, '연습이라 점수에는 들어가지 않아.'));
      }
    }

    if (vr) {
      const d = vr.trustDelta;
      rows.push(el('div', { class: 'res-village', style: { background: vr.color } },
        el('p', { class: 'caption' }, `${vr.emoji} ${vr.name} 신뢰지수`),
        el('div', { class: 'res-trust' },
          el('span', { class: 'trust-before' }, String(vr.trustBefore)),
          el('span', { class: 'trust-arrow' }, '→'),
          el('span', { class: 'trust-after' }, String(vr.trustAfter)),
          el('span', { class: `trust-delta ${d === 0 ? 'flat' : ''}` },
            d === 0 ? '변화 없음' : `${d > 0 ? '+' : ''}${d}`),
        ),
        el('div', { class: 'res-mix' },
          ...CHOICE_ORDER.map((k) => {
            const pct = vr.submitted ? Math.round((vr.counts[k] / vr.submitted) * 100) : 0;
            return el('span', { class: `mix-seg mix-${k}`, style: { width: `${pct}%` } },
              pct >= 14 ? `${pct}%` : '');
          }),
        ),
        el('p', { class: 't-body-sm res-note' },
          '우리 마을이 무엇을 골랐는지는 숫자로만 보여. 누가 골랐는지는 아무도 몰라.'),
      ));
    }

    resultBox.append(el('div', { class: 'res-card cut-in' }, ...rows.filter(Boolean)));
  }

  // ---------------------------------------------------------------- 제도
  async function renderInstitution(round) {
    if (!round.institution) { instBox.classList.add('hidden'); return; }
    const inst = await getInstitution(round.institution);
    if (!inst) return;
    instBox.className = 'r-inst';
    instBox.innerHTML = '';
    instBox.append(
      el('span', { class: 'inst-emoji' }, inst.emoji),
      el('span', { class: 'inst-body' },
        el('b', { class: 't-body' }, inst.name),
        el('span', { class: 't-body-sm', style: { opacity: 0.65 } }, inst.summary),
      ),
    );
    if (inst.id === 'pledge' && round.phase === 'ready') {
      instBox.append(round.pledgedThisRound
        ? el('span', { class: 'chip chip-solid' }, '서약함')
        : el('button', { class: 'btn btn-sm', onClick: onPledge }, '서약하기'));
    }
  }

  function renderLedger(round) {
    const l = round.ledger;
    if (!l) { ledgerBox.classList.add('hidden'); return; }
    ledgerBox.className = 'r-ledger';
    ledgerBox.innerHTML = '';
    const pct = (n) => (l.submitted ? Math.round((n / l.submitted) * 100) : 0);
    ledgerBox.append(
      el('p', { class: 'caption' }, `투명 장부 · 우리 마을 ${l.submitted}/${l.size}명 제출`),
      el('div', { class: 'res-mix' },
        ...CHOICE_ORDER.map((k) => el('span', {
          class: `mix-seg mix-${k}`, style: { width: `${pct(l.counts[k])}%` },
        }, pct(l.counts[k]) >= 16 ? `${pct(l.counts[k])}%` : '')),
      ),
    );
  }

  // ---------------------------------------------------------------- 갱신
  async function update(state) {
    const r = state.round;
    if (!r) return;

    if (loadedScenario !== r.scenarioId) {
      loadedScenario = r.scenarioId;
      const sc = await getScenario(r.scenarioId, state.settings.scenarioSet);
      if (sc) {
        title.textContent = sc.title;
        story.textContent = sc.story;
        artSlot.replaceChildren(scenarioArt(sc, { className: 'r-art' }));
        buildButtons(sc);
      }
    }

    badge.textContent = r.scoring === false ? '연습 · 점수 안 들어가' : `라운드 ${r.round}`;

    renderInstitution(r);
    renderLedger(r);

    const submitted = r.mySubmitted || Boolean(r.myResult);
    const closed = r.phase === 'closed';

    buttons.classList.toggle('hidden', closed || submitted || r.phase !== 'running');
    lock.classList.toggle('hidden', !(submitted && !closed));
    resultBox.classList.toggle('hidden', !closed);

    if (submitted && !closed) {
      if (r.myChoice) {
        const meta = CHOICE_META[r.myChoice];
        lockChoice.textContent = `${meta.emoji} ${meta.name}`;
        lockChoice.className = `lock-choice is-${r.myChoice}`;
      }
      // 몇 명이 냈는지만 — 누가 무엇을 냈는지는 여기에도 오지 않는다
      lockCount.textContent = r.total ? `${r.submitted} / ${r.total}명 제출` : '';
    }

    stopClock?.();
    stopClock = null;

    if (r.phase === 'running' && r.endsAt) {
      syncClock(r.serverNow);
      stopClock = startCountdown(r.endsAt, r.seconds + (r.extendedSeconds || 0), (left) => {
        timer.textContent = formatClock(left);
        timer.className = `r-timer${left <= 10 ? ' hurry' : ''}`;
      });
    } else if (closed) {
      timer.textContent = '마감';
      timer.className = 'r-timer done';
    } else {
      timer.textContent = '곧 시작해요';
      timer.className = 'r-timer waiting';
    }

    if (closed) renderResult(r);
    else for (const n of choiceNodes.values()) { n.disabled = false; n.classList.remove('picked'); }
  }

  return { root, update, cleanup: () => stopClock?.() };
}
