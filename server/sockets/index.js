import { store } from '../game/store.js';
import { normalizeCode } from '../lib/code.js';
import { localAddresses, studentUrl, isHosted } from '../lib/netinfo.js';
import { qrDataUrl } from '../lib/qr.js';
import { cleanReflection } from '../lib/clean.js';
import { WARMUP_QUESTIONS } from '../lib/content.js';
import {
  DEMO_DEFAULT_COUNT, DEMO_MAX_COUNT, demoCount,
  addDemoStudents, removeDemoStudents, scheduleRoundSubmits,
  preparePledges, doWarmup, doCouncil, doReflections, doPledges,
} from '../game/demo.js';
import {
  VILLAGE_COUNT_MIN, VILLAGE_COUNT_MAX,
  ROUND_SECONDS_MIN, ROUND_SECONDS_MAX,
} from '../config.js';
import {
  RoundError, startRound, closeRound, abortRound, extendRound,
  submitChoice, submittedCount, remainingMs, pledgeForRound,
  villageLiveTally, roundPhase,
} from '../game/engine.js';

const hostRoom = (code) => `host:${code}`;
const studentRoom = (code) => `students:${code}`;
const villageRoom = (code, i) => `village:${code}:${i}`;

const reply = (cb, payload) => { if (typeof cb === 'function') cb(payload); };
const fail = (cb, message) => reply(cb, { ok: false, error: message });

/** 34명이 한꺼번에 눌러도 브로드캐스트가 폭주하지 않도록 묶어서 보낸다. */
const PROGRESS_THROTTLE_MS = 350;

/** 한 사람이 소감 벽을 도배하지 못하게 */
const REFLECTIONS_PER_STUDENT = 3;

export function attachSockets(io, { port }) {
  /** code → setTimeout 핸들 (라운드 자동 마감) */
  const roundTimers = new Map();
  /** code → { timer, villages:Set } 진행 상황 합쳐 보내기 */
  const pending = new Map();

  // ---------------------------------------------------------------- 밀어 주기

  function pushHost(code) {
    const s = store.get(code);
    if (!s) return;
    io.to(hostRoom(code)).emit('host:state', s.hostState());
  }

  function pushStudent(socket) {
    const { code, token } = socket.data || {};
    const s = store.get(code);
    if (!s || !token) return;
    const state = s.studentState(token);
    if (state) socket.emit('state', state);
  }

  /** 학생 전원에게 각자의 상태 — 단계 전환·라운드 시작/마감처럼 전원이 바뀔 때만. */
  function pushAllStudents(code) {
    for (const id of io.sockets.adapter.rooms.get(studentRoom(code)) || []) {
      const socket = io.sockets.sockets.get(id);
      if (socket) pushStudent(socket);
    }
  }

  function pushCounts(code) {
    const s = store.get(code);
    if (!s) return;
    io.to(studentRoom(code)).emit('counts', {
      playerCount: s.playerCount,
      villageSizes: s.villageSizes(),
    });
  }

  /**
   * 제출이 들어올 때마다 부르는 가벼운 갱신.
   * 진행자에게는 "제출 인원 수"만, 투명 장부제 마을에는 자기 마을 비율만 간다.
   */
  function queueProgress(code, villageIndex) {
    let entry = pending.get(code);
    if (!entry) {
      entry = { timer: null, villages: new Set() };
      pending.set(code, entry);
    }
    if (villageIndex != null) entry.villages.add(villageIndex);
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const villages = [...entry.villages];
      entry.villages.clear();
      const s = store.get(code);
      if (!s) { pending.delete(code); return; }

      const progress = {
        stageId: s.round?.stageId || null,
        submitted: submittedCount(s),
        total: s.connectedCount,
      };
      // 진행자에게도, 학생에게도 "몇 명 냈는지"만 간다. 작은 객체 하나뿐.
      io.to(hostRoom(code)).emit('round:progress', progress);
      io.to(studentRoom(code)).emit('round:progress', progress);

      for (const vi of villages) {
        const tally = villageLiveTally(s, vi);
        if (tally) io.to(villageRoom(code, vi)).emit('ledger', tally);
      }
    }, PROGRESS_THROTTLE_MS);
    entry.timer.unref?.();
  }

  /** 워밍업 표가 몰릴 때도 진행자 화면 갱신을 묶어서 보낸다. */
  const warmupTimers = new Map();
  function queueWarmup(code) {
    if (warmupTimers.has(code)) return;
    const t = setTimeout(() => {
      warmupTimers.delete(code);
      const s = store.get(code);
      if (s) io.to(hostRoom(code)).emit('warmup:tally', { warmup: s.warmup, playerCount: s.connectedCount });
    }, PROGRESS_THROTTLE_MS);
    t.unref?.();
    warmupTimers.set(code, t);
  }

  /** 하트가 몰려도 진행자 화면 갱신은 묶어서 한 번만 */
  const heartTimers = new Map();
  function queueHearts(code) {
    if (heartTimers.has(code)) return;
    const t = setTimeout(() => { heartTimers.delete(code); pushHost(code); }, PROGRESS_THROTTLE_MS);
    t.unref?.();
    heartTimers.set(code, t);
  }

  // ---------------------------------------------------------------- 데모 봇

  /** code → 예약해 둔 봇 타이머들 (단계가 바뀌면 전부 취소한다) */
  const demoTimers = new Map();

  function clearDemoTimers(code) {
    for (const t of demoTimers.get(code) || []) clearTimeout(t);
    demoTimers.delete(code);
  }

  function registerDemoTimer(code, timer) {
    if (!demoTimers.has(code)) demoTimers.set(code, []);
    demoTimers.get(code).push(timer);
  }

  /**
   * 지금 단계에서 봇들이 할 일을 시킨다.
   * 단계가 바뀔 때마다, 그리고 데모를 켜는 순간에 불린다.
   */
  function runDemoForStage(session) {
    if (!session.demoOn || !demoCount(session)) return;
    const code = session.code;
    clearDemoTimers(code);

    const kind = session.stage.kind;
    // 사람처럼 조금 뜸을 들인다
    const soon = (fn, ms) => {
      const t = setTimeout(() => { try { fn(); } catch { /* 무시 */ } }, ms);
      t.unref?.();
      registerDemoTimer(code, t);
    };

    if (kind === 'warmup') {
      soon(() => {
        doWarmup(session, WARMUP_QUESTIONS.map((q) => q.id));
        store.markDirty(code);
        io.to(hostRoom(code)).emit('warmup:tally', { warmup: session.warmup, playerCount: session.connectedCount });
        pushHost(code);
      }, 1200);
      return;
    }

    if (kind === 'council') {
      soon(() => {
        doCouncil(session);
        store.markDirty(code);
        for (const v of session.villages) {
          io.to(villageRoom(code, v.index)).emit('council:tally', session.councilTally(v.index));
        }
        pushHost(code);
        pushAllStudents(code);
      }, 1500);
      return;
    }

    if (kind === 'reflect') {
      // 소감은 한 장씩 천천히 붙어야 벽이 차오르는 느낌이 산다
      soon(() => {
        doReflections(session, {
          cleanText: cleanReflection,
          onCard: (card) => io.to(studentRoom(code)).emit('reflect:add', card),
        });
        store.markDirty(code);
        pushHost(code);
        pushAllStudents(code);
      }, 1800);
      return;
    }

    if (kind === 'pledge') {
      soon(() => {
        doPledges(session);
        store.markDirty(code);
        io.to(studentRoom(code)).emit('pledge:count', {
          pledgeCount: session.pledgeCount, total: session.connectedCount,
        });
        pushHost(code);
      }, 1400);
      return;
    }

    if (kind === 'round' && session.round?.phase === 'ready') {
      preparePledges(session);
      pushHost(code);
    }
  }

  /** 라운드가 열리면 봇들의 제출을 시간차로 예약한다 */
  function scheduleDemoRound(session) {
    if (!session.demoOn || !demoCount(session)) return;
    const code = session.code;
    scheduleRoundSubmits(session, {
      register: (t) => registerDemoTimer(code, t),
      onProgress: (villageIndex) => queueProgress(code, villageIndex),
    });
  }

  function clearPending(code) {
    const entry = pending.get(code);
    if (entry?.timer) clearTimeout(entry.timer);
    pending.delete(code);
  }

  // ---------------------------------------------------------------- 타이머

  function clearRoundTimer(code) {
    const t = roundTimers.get(code);
    if (t) clearTimeout(t);
    roundTimers.delete(code);
  }

  /** 서버가 시간의 주인이다. 학생 폰 시계는 믿지 않는다. */
  function armRoundTimer(code) {
    clearRoundTimer(code);
    const s = store.get(code);
    if (!s || s.round?.phase !== 'running') return;
    const t = setTimeout(() => {
      roundTimers.delete(code);
      finishRound(code, 'time');
    }, Math.max(0, remainingMs(s)) + 40);
    t.unref?.();
    roundTimers.set(code, t);
  }

  /** 라운드 마감 — 시간이 다 됐든 진행자가 눌렀든 여기 한 곳으로 모인다. */
  async function finishRound(code, reason = 'host') {
    const s = store.get(code);
    if (!s || s.round?.phase !== 'running') return null;
    clearRoundTimer(code);
    clearPending(code);

    const results = closeRound(s);

    // 라운드가 끝날 때마다 스냅샷을 남긴다 (개인 선택은 이미 지워진 뒤).
    // 기다리지 않는다 — 스냅샷은 사고 대비용 백업이고, 진행자 화면이
    // 디스크 속도에 묶이면 안 된다. (OneDrive 폴더에서는 몇 초씩 걸리기도 한다)
    store.saveNow(code);

    io.to(hostRoom(code)).emit('round:closed', { reason, results });
    pushHost(code);
    pushAllStudents(code);   // 각자 자기 결과만 받는다
    return results;
  }

  async function beginRound(code) {
    const s = store.get(code);
    if (!s) return null;
    const round = startRound(s, s.stageId);
    armRoundTimer(code);
    scheduleDemoRound(s);
    store.markDirty(code);
    io.to(hostRoom(code)).emit('round:started', { ...s.roundView() });
    pushHost(code);
    pushAllStudents(code);
    return round;
  }

  // ---------------------------------------------------------------- 공통

  async function joinInfo(code) {
    const url = studentUrl(port);
    // 인터넷에 올린 경우엔 로컬 IP 목록이 의미가 없다 (컨테이너 내부 주소일 뿐)
    const addresses = isHosted() ? [] : localAddresses().map((a) => a.address);
    return { code, url, qr: await qrDataUrl(`${url}?c=${code}`), addresses, port, hosted: isHosted() };
  }

  function asHost(payload, cb) {
    const code = normalizeCode(payload?.code);
    const s = store.get(code);
    if (!s) { fail(cb, '세션을 찾을 수 없습니다.'); return null; }
    if (payload?.hostKey !== s.hostKey) { fail(cb, '진행자 권한이 없습니다.'); return null; }
    return s;
  }

  /** 단계를 옮기기 전 정리 — 앞으로 가면 집계하고, 뒤로 가면 없던 일로 한다. */
  async function settleBeforeMove(session, forward) {
    if (session.round?.phase !== 'running') return;
    if (forward) await finishRound(session.code, 'stage');
    else {
      abortRound(session);
      clearRoundTimer(session.code);
      clearPending(session.code);
    }
  }

  async function moveStage(session, apply) {
    apply();
    clearRoundTimer(session.code);
    clearPending(session.code);
    clearDemoTimers(session.code);
    runDemoForStage(session);
    store.markDirty(session.code);
    pushHost(session.code);
    pushAllStudents(session.code);
  }

  // ================================================================ 연결

  io.on('connection', (socket) => {
    // ------------------------------------------------------------- 진행자

    socket.on('host:create', async (payload = {}, cb) => {
      const s = store.create({
        villageCount: payload.villageCount,
        roundSeconds: payload.roundSeconds,
        scenarioSet: payload.scenarioSet,
      });
      socket.data.role = 'host';
      socket.data.code = s.code;
      socket.join(hostRoom(s.code));
      store.saveNow(s.code);
      console.log(`[세션] 생성 ${s.code} (마을 ${s.settings.villageCount}개)`);
      reply(cb, {
        ok: true,
        code: s.code,
        hostKey: s.hostKey,
        state: s.hostState(),
        join: await joinInfo(s.code),
      });
    });

    socket.on('host:attach', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      socket.data.role = 'host';
      socket.data.code = s.code;
      socket.join(hostRoom(s.code));
      reply(cb, { ok: true, code: s.code, state: s.hostState(), join: await joinInfo(s.code) });
    });

    /**
     * "다음" 버튼. 라운드 단계에서는 뜻이 세 가지로 갈린다.
     *   설명 중(ready)  → 라운드 시작
     *   진행 중(running) → 지금 마감
     *   마감됨(closed)  → 다음 단계로
     */
    socket.on('host:next', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      try {
        if (s.stage.kind === 'round') {
          const phase = roundPhase(s, s.stageId);
          if (phase === 'ready') {
            await beginRound(s.code);
            return reply(cb, { ok: true, action: 'round-start', stageId: s.stageId });
          }
          if (phase === 'running') {
            await finishRound(s.code, 'host');
            return reply(cb, { ok: true, action: 'round-close', stageId: s.stageId });
          }
        }

        // 최종 발표는 한 장씩 열고, 다 열린 뒤에야 다음 단계로 넘어간다
        if (s.stage.kind === 'reveal') {
          const max = Number(payload.revealMax) || 4;
          if (s.revealStep < max) {
            s.revealNext(max);
            store.markDirty(s.code);
            pushHost(s.code);
            pushAllStudents(s.code);
            return reply(cb, { ok: true, action: 'reveal', revealStep: s.revealStep });
          }
        }

        await moveStage(s, () => s.goNext());
        reply(cb, { ok: true, action: 'stage', stageId: s.stageId });
      } catch (err) {
        fail(cb, err instanceof RoundError ? err.message : '진행할 수 없습니다.');
      }
    });

    socket.on('host:prev', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      await settleBeforeMove(s, false);
      await moveStage(s, () => s.goPrev());
      reply(cb, { ok: true, stageId: s.stageId });
    });

    socket.on('host:goto', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      const forward = false; // 건너뛰기는 집계하지 않는다 — 실수로 점수가 들어가지 않게
      await settleBeforeMove(s, forward);
      await moveStage(s, () => s.goto(payload.stageId));
      reply(cb, { ok: true, stageId: s.stageId });
    });

    // ------- 라운드 직접 제어

    socket.on('host:round:start', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      try {
        await beginRound(s.code);
        reply(cb, { ok: true, round: s.roundView() });
      } catch (err) {
        fail(cb, err instanceof RoundError ? err.message : '라운드를 시작할 수 없습니다.');
      }
    });

    socket.on('host:round:extend', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      try {
        extendRound(s, payload.seconds ?? 30);
        armRoundTimer(s.code);
        io.to(hostRoom(s.code)).emit('round:extended', s.roundView());
        pushHost(s.code);
        pushAllStudents(s.code);
        reply(cb, { ok: true, round: s.roundView() });
      } catch (err) {
        fail(cb, err instanceof RoundError ? err.message : '시간을 늘릴 수 없습니다.');
      }
    });

    socket.on('host:round:close', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      const results = await finishRound(s.code, 'host');
      reply(cb, { ok: true, results: results || s.roundResults[s.stageId] || null });
    });

    // ------- 최종 발표 (한 장씩 공개)

    socket.on('host:reveal:next', (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      const step = s.revealNext(Number(payload.max) || 4);
      store.markDirty(s.code);
      pushHost(s.code);
      pushAllStudents(s.code);
      reply(cb, { ok: true, revealStep: step });
    });

    socket.on('host:reveal:back', (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      const step = s.revealBack();
      store.markDirty(s.code);
      pushHost(s.code);
      pushAllStudents(s.code);
      reply(cb, { ok: true, revealStep: step });
    });

    // ------- 데모 봇 모드

    /**
     * 가상 학생 켜기/끄기. 혼자 리허설하거나 시연할 때 쓴다.
     * 켜는 순간 지금 단계에 맞춰 알아서 움직이기 시작한다.
     */
    socket.on('host:demo', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;

      if (payload.on === false) {
        clearDemoTimers(s.code);
        const removed = removeDemoStudents(s);
        s.demoOn = false;
        store.markDirty(s.code);
        pushHost(s.code);
        pushAllStudents(s.code);
        console.log(`[데모] ${s.code} 봇 ${removed}명 내보냄`);
        return reply(cb, { ok: true, demo: { on: false, count: 0 } });
      }

      const count = Math.max(1, Math.min(DEMO_MAX_COUNT, Number(payload.count) || DEMO_DEFAULT_COUNT));
      const added = addDemoStudents(s, count);
      s.demoOn = true;
      store.markDirty(s.code);
      console.log(`[데모] ${s.code} 봇 ${added.length}명 입장 (총 ${demoCount(s)}명)`);

      pushHost(s.code);
      pushCounts(s.code);
      runDemoForStage(s);   // 이미 진행 중인 단계가 있으면 바로 따라잡는다

      reply(cb, { ok: true, demo: { on: true, count: demoCount(s) } });
    });

    /** 라운드를 잘못 시작했을 때 — 모은 선택을 점수에 넣지 않고 되돌린다. */
    socket.on('host:round:abort', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      abortRound(s);
      clearRoundTimer(s.code);
      clearPending(s.code);
      pushHost(s.code);
      pushAllStudents(s.code);
      reply(cb, { ok: true });
    });

    socket.on('host:settings', async (payload = {}, cb) => {
      const s = asHost(payload, cb);
      if (!s) return;
      if (payload.villageCount != null) {
        if (s.stageId !== 'lobby') return fail(cb, '마을 수는 입장 대기 중에만 바꿀 수 있습니다.');
        const n = Number(payload.villageCount);
        if (!(n >= VILLAGE_COUNT_MIN && n <= VILLAGE_COUNT_MAX)) {
          return fail(cb, `마을 수는 ${VILLAGE_COUNT_MIN}~${VILLAGE_COUNT_MAX} 사이여야 합니다.`);
        }
        s.setVillageCount(n);
      }
      if (payload.roundSeconds != null) {
        const t = Number(payload.roundSeconds);
        if (!(t >= ROUND_SECONDS_MIN && t <= ROUND_SECONDS_MAX)) {
          return fail(cb, `라운드 시간은 ${ROUND_SECONDS_MIN}~${ROUND_SECONDS_MAX}초 사이여야 합니다.`);
        }
        s.setRoundSeconds(t);
        if (s.round?.phase === 'ready') s.round.seconds = t;
      }
      store.markDirty(s.code);
      pushHost(s.code);
      pushAllStudents(s.code);
      reply(cb, { ok: true, settings: s.settings });
    });

    // ------------------------------------------------------------- 학생

    socket.on('student:join', (payload = {}, cb) => {
      const code = normalizeCode(payload.code);
      const s = store.get(code);
      if (!s) return fail(cb, '그런 코드의 수업이 없어요. 코드를 다시 확인해 주세요.');

      let player = s.getPlayer(payload.token);
      const returning = Boolean(player);

      if (!player) {
        if (s.stageId === 'end') return fail(cb, '이미 끝난 수업이에요.');
        player = s.addPlayer();
      }

      if (player.socketId && player.socketId !== socket.id) {
        const old = io.sockets.sockets.get(player.socketId);
        if (old) { old.leave(studentRoom(code)); old.emit('replaced'); }
      }

      player.socketId = socket.id;
      player.connected = true;
      player.lastSeen = Date.now();

      socket.data.role = 'student';
      socket.data.code = code;
      socket.data.token = player.token;
      socket.join(studentRoom(code));
      socket.join(villageRoom(code, player.villageIndex));

      store.markDirty(code);
      reply(cb, { ok: true, token: player.token, returning, state: s.studentState(player.token) });

      pushHost(code);
      pushCounts(code);
      if (!returning) console.log(`[입장] ${code} ${player.nickname} → ${s.villages[player.villageIndex]?.name}`);
    });

    socket.on('student:sync', (payload = {}, cb) => {
      const s = store.get(socket.data.code);
      const state = s?.studentState(socket.data.token) || null;
      reply(cb, state ? { ok: true, state } : { ok: false, error: '세션이 만료되었습니다.' });
    });

    /**
     * 비밀 선택 제출.
     * 응답으로 돌려주는 것은 "몇 명이 냈는가"뿐. 누가 무엇을 냈는지는 나가지 않는다.
     */
    socket.on('student:choose', (payload = {}, cb) => {
      const { code, token } = socket.data || {};
      const s = store.get(code);
      if (!s) return fail(cb, '세션이 만료되었습니다.');
      try {
        const { submitted } = submitChoice(s, token, payload.choice);
        const player = s.getPlayer(token);
        const total = s.connectedCount;   // '지금 접속 중' 기준
        reply(cb, { ok: true, submitted, total, myChoice: payload.choice });
        pushStudent(socket);   // 본인 화면을 "제출 완료" 잠금으로 바꾼다
        queueProgress(code, player.villageIndex);

        // 전원이 다 냈으면 굳이 시간을 끌지 않는다
        if (submitted >= total && total > 0) {
          setTimeout(() => finishRound(code, 'all-submitted'), 600);
        }
      } catch (err) {
        fail(cb, err instanceof RoundError ? err.message : '제출하지 못했어요.');
      }
    });

    /** 워밍업 투표 — 마음을 바꿀 수 있다. 집계는 카운트만 남는다. */
    socket.on('student:warmup', (payload = {}, cb) => {
      const { code, token } = socket.data || {};
      const s = store.get(code);
      if (!s) return fail(cb, '세션이 만료되었습니다.');
      if (s.stageId !== 'warmup') return fail(cb, '지금은 투표 시간이 아니에요.');
      const tally = s.warmupVote(token, payload.questionId, payload.optionIndex);
      if (!tally) return fail(cb, '투표하지 못했어요.');
      store.markDirty(code);
      reply(cb, { ok: true });
      pushStudent(socket);
      queueWarmup(code);
    });

    // ------- 마을회의

    /** 제도 투표 — 우리 마을 안에서만. 마음은 바꿀 수 있다. */
    socket.on('student:council', (payload = {}, cb) => {
      const { code, token } = socket.data || {};
      const s = store.get(code);
      if (!s) return fail(cb, '세션이 만료되었습니다.');
      if (s.stageId !== 'council') return fail(cb, '지금은 마을회의 시간이 아니에요.');

      const tally = s.councilVote(token, payload.institutionId);
      if (!tally) return fail(cb, '투표하지 못했어요.');

      store.markDirty(code);
      reply(cb, { ok: true, council: tally });

      // 같은 마을 학생들에게만 득표수를 알린다 (다른 마을에는 나가지 않는다)
      const vi = s.getPlayer(token)?.villageIndex;
      io.to(villageRoom(code, vi)).emit('council:tally', tally);
      pushHost(code);
    });

    // ------- 소감 벽

    socket.on('student:reflect', (payload = {}, cb) => {
      const { code, token } = socket.data || {};
      const s = store.get(code);
      if (!s) return fail(cb, '세션이 만료되었습니다.');
      if (s.stageId !== 'reflect') return fail(cb, '지금은 소감 시간이 아니에요.');

      const player = s.getPlayer(token);
      if (!player) return fail(cb, '참가자를 찾을 수 없습니다.');
      if (player.reflectionCount >= REFLECTIONS_PER_STUDENT) {
        return fail(cb, `한 사람이 ${REFLECTIONS_PER_STUDENT}개까지 쓸 수 있어.`);
      }

      const cleaned = cleanReflection(payload.text);
      if (!cleaned.ok) return fail(cb, cleaned.reason);

      // 카드에는 글만 담긴다. 누가 썼는지는 세지도, 남기지도 않는다.
      const card = s.addReflection(cleaned.text);
      player.reflectionCount += 1;

      store.markDirty(code);
      reply(cb, { ok: true, id: card.id });
      io.to(studentRoom(code)).emit('reflect:add', card);
      pushHost(code);
    });

    socket.on('student:heart', (payload = {}, cb) => {
      const { code, token } = socket.data || {};
      const s = store.get(code);
      if (!s) return fail(cb, '세션이 만료되었습니다.');
      const card = s.toggleHeart(token, payload.id);
      if (!card) return fail(cb, '그 소감을 찾을 수 없어요.');

      store.markDirty(code);
      const mine = s.getPlayer(token)?.hearted || [];
      reply(cb, { ok: true, hearts: card.hearts, mine: mine.includes(card.id) });
      io.to(studentRoom(code)).emit('reflect:heart', { id: card.id, hearts: card.hearts });
      queueHearts(code);
    });

    // ------- 서약

    socket.on('student:pledge', (payload = {}, cb) => {
      const { code, token } = socket.data || {};
      const s = store.get(code);
      if (!s) return fail(cb, '세션이 만료되었습니다.');
      const count = s.setPledged(token, payload.on !== false);
      store.markDirty(code);
      reply(cb, { ok: true, pledgeCount: count });
      io.to(studentRoom(code)).emit('pledge:count', { pledgeCount: count, total: s.connectedCount });
      pushHost(code);
    });

    /** 청렴 서약제 — 라운드 시작 전에만 */
    socket.on('student:pledge:round', (payload = {}, cb) => {
      const { code, token } = socket.data || {};
      const s = store.get(code);
      if (!s) return fail(cb, '세션이 만료되었습니다.');
      try {
        pledgeForRound(s, token);
        store.markDirty(code);
        reply(cb, { ok: true });
        pushStudent(socket);
        const vi = s.getPlayer(token)?.villageIndex;
        if (vi != null) {
          for (const id of io.sockets.adapter.rooms.get(villageRoom(code, vi)) || []) {
            const sock = io.sockets.sockets.get(id);
            if (sock && sock !== socket) pushStudent(sock);
          }
        }
      } catch (err) {
        fail(cb, err instanceof RoundError ? err.message : '서약하지 못했어요.');
      }
    });

    // ------------------------------------------------------------- 종료

    socket.on('disconnect', () => {
      const { role, code, token } = socket.data || {};
      if (role !== 'student' || !code || !token) return;
      const s = store.get(code);
      const player = s?.getPlayer(token);
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      player.lastSeen = Date.now();
      pushHost(code);
    });
  });

  return { pushHost, pushAllStudents, pushCounts, finishRound };
}
