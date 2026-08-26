// 진행자 라운드 화면 — 시나리오 · 남은 시간 · 제출 인원 · 마감 결과.
// 개인의 선택은 그리지 않는다. 그릴 데이터 자체가 오지 않는다.

import { el, countUp } from '../lib/dom.js';
import { getScenario, scenarioArt, CHOICE_META, CHOICE_ORDER } from '../lib/content.js';
import { syncClock, startCountdown, formatClock } from '../lib/clock.js';
import { registerStage, trustBars, mixBar, choiceLegend, swatch } from './render.js';

registerStage('round', (area, state, ctx) => {
  let stopClock = null;

  const eyebrow = el('p', { class: 'eyebrow' });
  const title = el('h2', { class: 't-display-lg' });
  const story = el('p', { class: 't-subhead scene-story' });
  const artSlot = el('div', { class: 'art-slot' });
  const choiceList = el('div', { class: 'scene-choices' });

  const timerNum = el('div', { class: 'timer-num' }, '--');
  const timerFill = el('div', { class: 'timer-line-fill' });
  const timerCap = el('p', { class: 'caption timer-cap' }, '아직 시작 전');

  const submitNum = el('span', { class: 'submit-num' }, '0');
  const submitTotal = el('span', { class: 'submit-total' }, '/ 0');
  const submitFill = el('div', { class: 'submit-bar-fill' });

  const startBtn = el('button', { class: 'btn', onClick: () => ctx.send('host:round:start') }, '라운드 시작');
  const extendBtn = el('button', { class: 'btn btn-secondary', onClick: () => ctx.send('host:round:extend', { seconds: 30 }) }, '+30초');
  const closeBtn = el('button', { class: 'btn', onClick: () => ctx.send('host:round:close') }, '지금 마감');
  const abortBtn = el('button', {
    class: 'btn btn-secondary',
    onClick: () => {
      if (confirm('모은 선택을 버리고 처음부터 다시 할까요?\n점수에는 반영되지 않습니다.')) ctx.send('host:round:abort');
    },
  }, '다시');

  const timerPanel = el('div', { class: 'timer-panel' },
    el('div', { class: 'stack', style: { justifyItems: 'center', gap: 'var(--s-xs)', width: '100%' } },
      timerNum,
      el('div', { class: 'timer-line' }, timerFill),
      timerCap,
    ),
    el('div', { class: 'submit-panel' },
      el('p', { class: 'eyebrow' }, '제출'),
      el('div', { class: 'submit-figures' }, submitNum, submitTotal),
      el('div', { class: 'submit-bar' }, submitFill),
      el('p', { class: 'caption submit-note' }, '누가 무엇을 냈는지는 보이지 않습니다'),
    ),
    el('div', { class: 'round-actions' }, startBtn, extendBtn, closeBtn, abortBtn),
  );

  const resultPanel = el('div', { class: 'stack hidden', style: { gap: 'var(--s-md)' } });

  area.append(el('div', { class: 'round-layout' },
    el('div', { class: 'scene' },
      el('div', { class: 'stage-head', style: { marginBottom: 0 } }, eyebrow, title),
      artSlot,
      story,
      choiceList,
    ),
    el('div', { class: 'round-side' }, timerPanel, resultPanel),
  ));

  // ---------------------------------------------------------------- 시나리오
  let loaded = null;
  async function loadScenario(scenarioId, setId) {
    if (loaded === scenarioId || !scenarioId) return;
    loaded = scenarioId;
    const sc = await getScenario(scenarioId, setId);
    if (!sc) return;
    title.textContent = sc.title;
    story.textContent = sc.story;
    artSlot.replaceChildren(scenarioArt(sc, { className: 'scene-art' }));
    choiceList.innerHTML = '';
    for (const key of CHOICE_ORDER) {
      const m = CHOICE_META[key];
      const c = sc.choices[key];
      choiceList.append(el('div', { class: `scene-choice is-${key}` },
        el('span', { class: 'sc-key' }, key.toUpperCase()),
        el('span', { class: 'sc-body' },
          el('span', { class: 'sc-label t-body-lg' }, c.label),
          el('span', { class: 'sc-sub' }, c.sub),
        ),
        el('span', { class: 'sc-eff' }, `${m.coin} / ${m.trustReal}`),
      ));
    }
  }

  // ---------------------------------------------------------------- 마감 결과
  function renderResults(results, villages) {
    resultPanel.innerHTML = '';
    if (!results) return;

    const deltas = Object.fromEntries(results.villages.map((v) => [v.index, v.trustDelta]));
    resultPanel.append(
      el('p', { class: 'eyebrow' }, results.scoring ? '마을 신뢰지수' : '연습 결과 · 점수 미반영'),
      results.scoring ? trustBars(villages, { deltas }) : null,
      el('p', { class: 'eyebrow', style: { marginTop: 'var(--s-sm)' } }, '마을별 선택'),
      ...results.villages.map((v) => el('div', { class: 'stack', style: { gap: '4px' } },
        el('div', { class: 'spread caption' },
          el('span', { class: 'row', style: { gap: '0.4em' } }, swatch(v.color), v.name),
          el('span', {}, `${v.submitted}/${v.size}`)),
        mixBar(v.counts, v.submitted),
      )),
      choiceLegend(),
      el('div', { class: 'result-foot caption' },
        el('span', {}, `제출 ${results.totals.submitted}명`),
        results.totals.missing ? el('span', { style: { opacity: 0.5 } }, `미제출 ${results.totals.missing}명`) : null,
        results.totals.honestRate != null
          ? el('span', { class: 'chip chip-solid' }, `정직 선택률 ${results.totals.honestRate}%`) : null,
      ),
    );
  }

  // ---------------------------------------------------------------- 갱신
  function update(s) {
    const r = s.round;
    loadScenario(r?.scenarioId || s.stage.scenario, s.settings.scenarioSet);
    eyebrow.textContent = r?.scoring === false ? '연습 · 점수 미반영' : `라운드 ${r?.round ?? ''}`;

    const phase = r?.phase || 'ready';
    startBtn.classList.toggle('hidden', phase !== 'ready');
    extendBtn.classList.toggle('hidden', phase !== 'running');
    closeBtn.classList.toggle('hidden', phase !== 'running');
    abortBtn.classList.toggle('hidden', phase !== 'running');
    resultPanel.classList.toggle('hidden', phase !== 'closed');
    timerPanel.classList.toggle('is-closed', phase === 'closed');

    // 마감 뒤에는 실시간 카운트가 비어 있다(선택 원본을 지웠으므로) — 집계값을 쓴다
    const done = phase === 'closed' ? (r?.results || s.roundResults?.[s.stageId]) : null;
    const total = done ? done.totals.total : (r?.total ?? s.connectedCount);
    const submitted = done ? done.totals.submitted : (r?.submitted ?? 0);
    countUp(submitNum, submitted, 250);
    submitTotal.textContent = `/ ${total}`;
    submitFill.style.width = total ? `${(submitted / total) * 100}%` : '0%';

    stopClock?.();
    stopClock = null;

    if (phase === 'running' && r.endsAt) {
      syncClock(r.serverNow);
      timerCap.textContent = r.extendedSeconds ? `${r.extendedSeconds}초 연장됨` : '남은 시간';
      stopClock = startCountdown(r.endsAt, r.seconds + (r.extendedSeconds || 0), (left, ratio) => {
        timerNum.textContent = formatClock(left);
        timerFill.style.width = `${ratio * 100}%`;
        timerNum.classList.toggle('hurry', left <= 10);
        timerFill.classList.toggle('hurry', left <= 10);
      });
    } else if (phase === 'ready') {
      timerNum.textContent = formatClock(r?.seconds ?? s.settings.roundSeconds);
      timerNum.classList.remove('hurry');
      timerFill.classList.remove('hurry');
      timerFill.style.width = '100%';
      timerCap.textContent = '시나리오를 읽어 주고 시작하세요';
    } else {
      timerNum.textContent = '끝';
      timerFill.style.width = '0%';
      timerNum.classList.remove('hurry');
      timerCap.textContent = '마감됨';
    }

    if (phase === 'closed') renderResults(r?.results || s.roundResults?.[s.stageId], s.villages);
  }

  area._update = update;
  area._cleanup = () => stopClock?.();
  update(state);
});
