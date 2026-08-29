// 세션 하나 = Durable Object 하나.
//
// Socket.IO 서버와 파일 스냅샷이 하던 일을 여기서 모두 한다.
//   · 한 수업의 상태를 메모리에 들고 있고 (예전 game/store.js)
//   · 그 수업에 붙은 WebSocket 들에게 밀어 주고 (예전 sockets/index.js)
//   · 상태를 Durable Object 저장소에 남긴다 (예전 lib/persist.js)
//
// Durable Object 는 코드마다 하나씩만 살아 있으므로, 예전에 방(room)으로
// 나누던 것을 그냥 소켓 집합으로 관리하면 된다.

import { DurableObject } from 'cloudflare:workers';
import { Session } from '../shared/game/session.js';
import {
  startRound, closeRound, abortRound, extendRound,
  submitChoice, submittedCount, remainingMs, pledgeForRound,
  villageLiveTally, roundPhase,
} from '../shared/game/engine.js';
import {
  DEMO_DEFAULT_COUNT, DEMO_MAX_COUNT, demoCount,
  addDemoStudents, removeDemoStudents, scheduleRoundSubmits,
  preparePledges, doWarmup, doCouncil, doReflections, doPledges,
} from '../shared/game/demo.js';
import { cleanReflection } from '../shared/lib/clean.js';
import { WARMUP_QUESTIONS } from '../shared/content.js';
import {
  VILLAGE_COUNT_MIN, VILLAGE_COUNT_MAX,
  ROUND_SECONDS_MIN, ROUND_SECONDS_MAX,
} from '../shared/config.js';
import { qrDataUrl } from './qr.js';
import { decode, ack, nack, push } from './protocol.js';

/** 한 사람이 소감 벽을 도배하지 못하게 */
const REFLECTIONS_PER_STUDENT = 3;
/** 34명이 한꺼번에 눌러도 브로드캐스트가 폭주하지 않도록 묶어 보낸다 */
const THROTTLE_MS = 350;
/** 수업이 끝나고 이만큼 지나면 저장소를 비운다 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class VillageSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {Session|null} */
    this.session = null;
    this.loaded = null;

    /**
     * 소켓마다 역할을 붙여 둔다 (호스트인지, 어느 학생인지).
     * Durable Object 는 조용하면 잠들었다가 새로 만들어지므로,
     * 이 값은 소켓 자체에도 붙여 두고(serializeAttachment) 깨어날 때 되읽는다.
     */
    this.roles = new Map();   // WebSocket → { role, token, villageIndex }
    this.timers = new Map();  // 이름 → setTimeout 핸들
    this.demoTimers = [];
    /** 봇 제출을 예약해 둔 라운드 (중복 예약 방지 · 깨어난 뒤 재예약 판단) */
    this.demoScheduledFor = null;
  }

  // ================================================================ 상태 보관

  /** 저장소에서 세션을 되살린다. 한 번만 한다. */
  async load() {
    if (this.session) return this.session;
    this.loaded ||= (async () => {
      const snap = await this.ctx.storage.get('session');
      if (snap) {
        const age = Date.now() - (snap.updatedAt || 0);
        if (age < SESSION_TTL_MS) this.session = Session.fromSnapshot(snap);
      }
      // 잠들기 전에 돌고 있던 라운드가 있으면 그대로 이어 받는다
      const live = await this.ctx.storage.get('live');
      if (this.session && live?.round) {
        this.session.round = live.round;
        if (live.choices) {
          this.session.secretChoices.set(live.round.stageId, new Map(Object.entries(live.choices)));
        }
        if (live.outcomes) this.session.personalOutcomes = new Map(Object.entries(live.outcomes));
      }
      this.syncConnected();
      // 라운드가 도는 중에 깨어났다면, 아직 내지 않은 봇들을 다시 예약한다.
      // 예약 타이머는 메모리에만 있어서 잠들 때 함께 사라진다.
      this.scheduleDemoRound();
      return this.session;
    })();
    return this.loaded;
  }

  /**
   * 상태를 저장소에 남긴다.
   * 개인의 선택은 toSnapshot 에서 이미 빠져 있으므로 여기서 걱정할 것이 없다.
   */
  async save() {
    if (!this.session) return;
    await this.ctx.storage.put('session', this.session.toSnapshot());
  }

  /** 기다리지 않는 저장 — 진행자 화면이 저장 속도에 묶이지 않게 */
  saveSoon() {
    this.ctx.waitUntil(this.save().catch(() => {}));
  }

  /**
   * 진행 중인 라운드 보관.
   *
   * Durable Object 는 조용하면 잠들고, 알람으로 깨어날 때 새로 만들어진다.
   * 그때 메모리에만 있던 라운드와 제출이 사라지면 수업이 끊기므로 따로 둔다.
   * 여기에만 개인의 선택이 잠깐 담기고, 라운드를 마감하는 순간 통째로 지운다 —
   * 수업 기록(스냅샷·CSV)에는 어떤 경로로도 들어가지 않는다.
   */
  async saveLive() {
    const s = this.session;
    if (!s?.round) return this.ctx.storage.delete('live');
    const choices = s.secretChoices.get(s.round.stageId);
    return this.ctx.storage.put('live', {
      round: s.round,
      choices: choices ? Object.fromEntries(choices) : null,
      outcomes: s.personalOutcomes.size ? Object.fromEntries(s.personalOutcomes) : null,
    });
  }

  liveSoon() {
    this.ctx.waitUntil(this.saveLive().catch(() => {}));
  }

  /** 라운드가 끝났으니 개인 선택을 담아 두던 자리를 비운다 */
  clearLive() {
    this.ctx.waitUntil(this.ctx.storage.delete('live').catch(() => {}));
  }

  /** Worker 가 CSV 를 만들 때 쓰는 읽기 전용 통로 (RPC) */
  async snapshot() {
    await this.load();
    return this.session ? this.session.toSnapshot() : null;
  }

  // ================================================================ 보내기

  send(ws, text) {
    if (!text) return;
    try { ws.send(text); } catch { /* 이미 닫힌 소켓 */ }
  }

  /**
   * 소켓에 붙은 역할 정보. 잠들었다 깨어나면 메모리가 비어 있으므로
   * 소켓에 직접 붙여 둔 값에서 되읽는다.
   */
  metaOf(ws) {
    let meta = this.roles.get(ws);
    if (!meta) {
      try { meta = ws.deserializeAttachment() || {}; } catch { meta = {}; }
      this.roles.set(ws, meta);
    }
    return meta;
  }

  setMeta(ws, meta) {
    this.roles.set(ws, meta);
    try { ws.serializeAttachment(meta); } catch { /* 무시 */ }
  }

  /** 조건에 맞는 소켓들에게 */
  broadcast(text, filter = () => true) {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.metaOf(ws);
      if (meta && filter(meta)) this.send(ws, text);
    }
  }

  pushHost() {
    if (!this.session) return;
    this.broadcast(push('host:state', this.session.hostState()), (m) => m.role === 'host');
  }

  pushStudent(ws) {
    const meta = this.metaOf(ws);
    if (!meta?.token || !this.session) return;
    const state = this.session.studentState(meta.token);
    if (state) this.send(ws, push('state', state));
  }

  pushAllStudents() {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.metaOf(ws).role === 'student') this.pushStudent(ws);
    }
  }

  pushCounts() {
    if (!this.session) return;
    this.broadcast(push('counts', {
      playerCount: this.session.playerCount,
      villageSizes: this.session.villageSizes(),
    }), (m) => m.role === 'student');
  }

  /** 같은 마을 학생에게만 */
  pushVillage(villageIndex, text) {
    this.broadcast(text, (m) => m.role === 'student' && m.villageIndex === villageIndex);
  }

  // ---- 묶어 보내기

  later(name, ms, fn) {
    if (this.timers.has(name)) return;
    const t = setTimeout(() => { this.timers.delete(name); try { fn(); } catch { /* 무시 */ } }, ms);
    this.timers.set(name, t);
  }

  clearTimer(name) {
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    this.timers.delete(name);
  }

  queueProgress(villageIndex) {
    if (villageIndex != null) (this.pendingVillages ||= new Set()).add(villageIndex);
    this.later('progress', THROTTLE_MS, () => {
      const s = this.session;
      if (!s) return;
      const progress = {
        stageId: s.round?.stageId || null,
        submitted: submittedCount(s),
        total: s.connectedCount,
      };
      // 진행자에게도 학생에게도 "몇 명 냈는지"만 간다
      this.broadcast(push('round:progress', progress));

      for (const vi of this.pendingVillages || []) {
        const tally = villageLiveTally(s, vi);
        if (tally) this.pushVillage(vi, push('ledger', tally));
      }
      this.pendingVillages?.clear();
    });
  }

  // ================================================================ 라운드 시계

  /**
   * 라운드 마감 시각을 Durable Object 알람으로 예약한다.
   * setTimeout 과 달리 알람은 객체가 잠들었다 깨어나도 살아 있다.
   */
  async armRoundAlarm() {
    const left = remainingMs(this.session);
    if (this.session?.round?.phase === 'running' && left > 0) {
      await this.ctx.storage.setAlarm(Date.now() + left + 50);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** 시간이 다 됐을 때 Cloudflare 가 불러 준다 */
  /** 시간이 다 됐을 때 Cloudflare 가 깨워 준다 (잠들어 있었어도) */
  async alarm() {
    await this.load();
    if (this.session?.round?.phase !== 'running') return;
    if (remainingMs(this.session) > 0) return this.armRoundAlarm();   // 연장됐다면 다시 예약
    await this.finishRound('time');
  }

  async finishRound(reason = 'host') {
    const s = this.session;
    if (!s || s.round?.phase !== 'running') return null;
    this.clearTimer('progress');
    this.clearDemoTimers();

    const results = closeRound(s);
    await this.ctx.storage.deleteAlarm();
    this.saveSoon();
    await this.saveLive();   // 선택 원본은 사라지고, 본인 결과만 남는다

    this.broadcast(push('round:closed', { reason, results }), (m) => m.role === 'host');
    this.pushHost();
    this.pushAllStudents();   // 각자 자기 결과만 받는다
    return results;
  }

  async beginRound() {
    const s = this.session;
    const round = startRound(s, s.stageId);
    await this.saveLive();
    await this.armRoundAlarm();
    this.scheduleDemoRound();
    this.saveSoon();
    this.broadcast(push('round:started', s.roundView()), (m) => m.role === 'host');
    this.pushHost();
    this.pushAllStudents();
    return round;
  }

  // ================================================================ 데모 봇

  clearDemoTimers() {
    for (const t of this.demoTimers) clearTimeout(t);
    this.demoTimers = [];
    this.demoScheduledFor = null;
  }

  demoSoon(fn, ms) {
    const t = setTimeout(() => { try { fn(); } catch { /* 무시 */ } }, ms);
    this.demoTimers.push(t);
  }

  runDemoForStage() {
    const s = this.session;
    if (!s?.demoOn || !demoCount(s)) return;
    this.clearDemoTimers();
    const kind = s.stage.kind;

    if (kind === 'warmup') {
      this.demoSoon(() => {
        doWarmup(s, WARMUP_QUESTIONS.map((q) => q.id));
        this.saveSoon();
        this.broadcast(push('warmup:tally', { warmup: s.warmup, playerCount: s.connectedCount }),
          (m) => m.role === 'host');
        this.pushHost();
      }, 1200);
    } else if (kind === 'council') {
      this.demoSoon(() => {
        doCouncil(s);
        this.saveSoon();
        for (const v of s.villages) this.pushVillage(v.index, push('council:tally', s.councilTally(v.index)));
        this.pushHost();
        this.pushAllStudents();
      }, 1500);
    } else if (kind === 'reflect') {
      this.demoSoon(() => {
        doReflections(s, {
          cleanText: cleanReflection,
          onCard: (card) => this.broadcast(push('reflect:add', card), (m) => m.role === 'student'),
        });
        this.saveSoon();
        this.pushHost();
        this.pushAllStudents();
      }, 1800);
    } else if (kind === 'pledge') {
      this.demoSoon(() => {
        doPledges(s);
        this.saveSoon();
        this.broadcast(push('pledge:count', { pledgeCount: s.pledgeCount, total: s.connectedCount }),
          (m) => m.role === 'student');
        this.pushHost();
      }, 1400);
    } else if (kind === 'round' && s.round?.phase === 'ready') {
      preparePledges(s);
      this.pushHost();
    }
  }

  /**
   * 봇들의 제출을 예약한다.
   *
   * 봇의 제출도 사람 학생의 제출과 똑같이 저장해 두어야 한다.
   * 예약된 타이머는 이 객체의 메모리에만 있어서, 객체가 잠들거나 다시 만들어지면
   * 사라진다. 그때 남은 봇들을 다시 예약할 수 있도록 어느 라운드를 예약해 두었는지
   * 기억해 둔다 (같은 라운드를 두 번 예약하지 않기 위해서이기도 하다).
   */
  scheduleDemoRound() {
    const s = this.session;
    if (!s?.demoOn || !demoCount(s)) return;
    if (s.round?.phase !== 'running') return;
    if (this.demoScheduledFor === s.round.stageId) return;
    this.demoScheduledFor = s.round.stageId;
    scheduleRoundSubmits(s, {
      register: (t) => this.demoTimers.push(t),
      onProgress: (vi) => {
        // 사람 학생의 student:choose 와 같은 자리 — 이걸 빼면 잠들었다 깨어날 때
        // 봇이 낸 것만 통째로 사라져 집계가 0 이 된다
        this.saveLive().catch(() => {});
        this.queueProgress(vi);
      },
    });
  }

  // ================================================================ 들어오는 요청

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket 전용', { status: 426 });
    }

    await this.load();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.setMeta(server, { role: null, token: null, origin: url.searchParams.get('origin') || '' });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const msg = decode(raw);
    if (!msg) return;
    await this.load();
    try {
      await this.handle(ws, msg);
    } catch (err) {
      if (msg.i != null) this.send(ws, nack(msg.i, err?.message || '처리하지 못했습니다.'));
    }
  }

  webSocketClose(ws) { this.onGone(ws); }
  webSocketError(ws) { this.onGone(ws); }

  /**
   * 지금 누가 접속 중인지는 저장소가 아니라 열려 있는 소켓이 답이다.
   * 스냅샷은 사람 학생을 전부 끊긴 것으로 되살리므로(그때는 정말 그러니까),
   * 잠에서 깬 직후 한 번 맞춰 준다. 이걸 빼먹으면 폰을 들고 있는 학생이
   * 진행자 화면에서 사라지고, 제출 인원이 "3 / 0" 처럼 보인다.
   */
  syncConnected() {
    const s = this.session;
    if (!s) return;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.metaOf(ws);
      if (meta?.role !== 'student' || !meta.token) continue;
      const player = s.getPlayer(meta.token);
      if (player) player.connected = true;
    }
  }

  onGone(ws) {
    const meta = this.metaOf(ws);
    this.roles.delete(ws);
    if (meta?.role !== 'student' || !this.session) return;
    const player = this.session.getPlayer(meta.token);
    if (!player) return;
    player.connected = false;
    player.lastSeen = Date.now();
    this.pushHost();
  }

  // ================================================================ 명령 처리

  /** 진행자 권한 확인 */
  asHost(msg) {
    if (!this.session) throw new Error('세션을 찾을 수 없습니다.');
    if (msg.d?.hostKey !== this.session.hostKey) throw new Error('진행자 권한이 없습니다.');
    return this.session;
  }

  reply(ws, msg, data) {
    if (msg.i != null) this.send(ws, ack(msg.i, data));
  }

  joinInfo(ws) {
    const s = this.session;
    const origin = this.metaOf(ws).origin || '';
    const url = origin ? `${origin}/` : '/';
    const hosted = !/^https?:\/\/(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(origin);
    return { code: s.code, url, qr: qrDataUrl(`${url}?c=${s.code}`), hosted };
  }

  async handle(ws, msg) {
    const meta = this.metaOf(ws);
    const d = msg.d || {};

    switch (msg.t) {
      // ---------------------------------------------------------- 진행자
      case 'host:create': {
        if (!this.session) {
          this.session = new Session(d.code, {
            villageCount: d.villageCount,
            roundSeconds: d.roundSeconds,
            scenarioSet: d.scenarioSet,
          });
        }
        meta.role = 'host';
        this.setMeta(ws, meta);
        await this.save();
        return this.reply(ws, msg, {
          code: this.session.code,
          hostKey: this.session.hostKey,
          state: this.session.hostState(),
          join: this.joinInfo(ws),
        });
      }

      case 'host:attach': {
        const s = this.asHost(msg);
        meta.role = 'host';
        this.setMeta(ws, meta);
        return this.reply(ws, msg, { code: s.code, state: s.hostState(), join: this.joinInfo(ws) });
      }

      case 'host:next': {
        const s = this.asHost(msg);
        // 라운드에서는 "다음"이 국면마다 뜻이 다르다
        if (s.stage.kind === 'round') {
          const phase = roundPhase(s, s.stageId);
          if (phase === 'ready') { await this.beginRound(); return this.reply(ws, msg, { action: 'round-start', stageId: s.stageId }); }
          if (phase === 'running') { await this.finishRound('host'); return this.reply(ws, msg, { action: 'round-close', stageId: s.stageId }); }
        }
        // 최종 발표는 한 장씩 열고, 다 열린 뒤에야 다음 단계로
        if (s.stage.kind === 'reveal') {
          const max = Number(d.revealMax) || 4;
          if (s.revealStep < max) {
            s.revealNext(max);
            this.saveSoon();
            this.pushHost();
            this.pushAllStudents();
            return this.reply(ws, msg, { action: 'reveal', revealStep: s.revealStep });
          }
        }
        await this.moveStage(() => s.goNext());
        return this.reply(ws, msg, { action: 'stage', stageId: s.stageId });
      }

      case 'host:prev': {
        const s = this.asHost(msg);
        if (s.round?.phase === 'running') { abortRound(s); await this.ctx.storage.deleteAlarm(); }
        await this.moveStage(() => s.goPrev());
        return this.reply(ws, msg, { stageId: s.stageId });
      }

      case 'host:goto': {
        const s = this.asHost(msg);
        // 건너뛰기는 집계하지 않는다 — 실수로 점수가 들어가지 않게
        if (s.round?.phase === 'running') { abortRound(s); await this.ctx.storage.deleteAlarm(); }
        await this.moveStage(() => s.goto(d.stageId));
        return this.reply(ws, msg, { stageId: s.stageId });
      }

      case 'host:round:start': {
        this.asHost(msg);
        await this.beginRound();
        return this.reply(ws, msg, { round: this.session.roundView() });
      }

      case 'host:round:close': {
        const s = this.asHost(msg);
        const results = await this.finishRound('host');
        return this.reply(ws, msg, { results: results || s.roundResults[s.stageId] || null });
      }

      case 'host:round:extend': {
        const s = this.asHost(msg);
        extendRound(s, d.seconds ?? 30);
        await this.armRoundAlarm();
        this.broadcast(push('round:extended', s.roundView()), (m) => m.role === 'host');
        this.pushHost();
        this.pushAllStudents();
        return this.reply(ws, msg, { round: s.roundView() });
      }

      case 'host:round:abort': {
        const s = this.asHost(msg);
        abortRound(s);
        await this.ctx.storage.deleteAlarm();
        this.clearDemoTimers();
        this.pushHost();
        this.pushAllStudents();
        return this.reply(ws, msg, {});
      }

      case 'host:reveal:next': {
        const s = this.asHost(msg);
        const step = s.revealNext(Number(d.max) || 4);
        this.saveSoon();
        this.pushHost();
        this.pushAllStudents();
        return this.reply(ws, msg, { revealStep: step });
      }

      case 'host:reveal:back': {
        const s = this.asHost(msg);
        const step = s.revealBack();
        this.saveSoon();
        this.pushHost();
        this.pushAllStudents();
        return this.reply(ws, msg, { revealStep: step });
      }

      case 'host:settings': {
        const s = this.asHost(msg);
        if (d.villageCount != null) {
          if (s.stageId !== 'lobby') throw new Error('마을 수는 입장 대기 중에만 바꿀 수 있습니다.');
          const n = Number(d.villageCount);
          if (!(n >= VILLAGE_COUNT_MIN && n <= VILLAGE_COUNT_MAX)) {
            throw new Error(`마을 수는 ${VILLAGE_COUNT_MIN}~${VILLAGE_COUNT_MAX} 사이여야 합니다.`);
          }
          s.setVillageCount(n);
        }
        if (d.roundSeconds != null) {
          const t = Number(d.roundSeconds);
          if (!(t >= ROUND_SECONDS_MIN && t <= ROUND_SECONDS_MAX)) {
            throw new Error(`라운드 시간은 ${ROUND_SECONDS_MIN}~${ROUND_SECONDS_MAX}초 사이여야 합니다.`);
          }
          s.setRoundSeconds(t);
          if (s.round?.phase === 'ready') s.round.seconds = t;
        }
        this.saveSoon();
        this.pushHost();
        this.pushAllStudents();
        return this.reply(ws, msg, { settings: s.settings });
      }

      case 'host:demo': {
        const s = this.asHost(msg);
        if (d.on === false) {
          this.clearDemoTimers();
          removeDemoStudents(s);
          s.demoOn = false;
          this.saveSoon();
          this.pushHost();
          this.pushAllStudents();
          return this.reply(ws, msg, { demo: { on: false, count: 0 } });
        }
        addDemoStudents(s, Math.max(1, Math.min(DEMO_MAX_COUNT, Number(d.count) || DEMO_DEFAULT_COUNT)));
        s.demoOn = true;
        this.saveSoon();
        this.pushHost();
        this.pushCounts();
        this.runDemoForStage();
        return this.reply(ws, msg, { demo: { on: true, count: demoCount(s) } });
      }

      // ---------------------------------------------------------- 학생
      case 'student:join': {
        const s = this.session;
        if (!s) throw new Error('그런 코드의 수업이 없어요. 코드를 다시 확인해 주세요.');

        let player = s.getPlayer(d.token);
        const returning = Boolean(player);
        if (!player) {
          if (s.stageId === 'end') throw new Error('이미 끝난 수업이에요.');
          player = s.addPlayer();
        }

        // 같은 학생이 다른 기기로 들어오면 이전 화면은 물러난다
        for (const other of this.ctx.getWebSockets()) {
          const om = this.metaOf(other);
          if (other !== ws && om?.token === player.token) {
            this.send(other, push('replaced', {}));
            this.setMeta(other, { ...om, token: null, role: null });
          }
        }

        // 이 소켓이 다른 학생으로 붙어 있었다면, 그 학생은 이제 여기 없다
        if (meta.token && meta.token !== player.token) {
          const previous = s.getPlayer(meta.token);
          if (previous) {
            previous.connected = false;
            previous.lastSeen = Date.now();
          }
        }

        player.connected = true;
        player.lastSeen = Date.now();
        meta.role = 'student';
        meta.token = player.token;
        meta.villageIndex = player.villageIndex;
        this.setMeta(ws, meta);

        this.saveSoon();
        this.reply(ws, msg, { token: player.token, returning, state: s.studentState(player.token) });
        this.pushHost();
        this.pushCounts();
        return;
      }

      case 'student:sync': {
        const state = this.session?.studentState(meta.token);
        if (!state) throw new Error('세션이 만료되었습니다.');
        return this.reply(ws, msg, { state });
      }

      case 'student:choose': {
        const s = this.session;
        if (!s) throw new Error('세션이 만료되었습니다.');
        const { submitted } = submitChoice(s, meta.token, d.choice);
        const total = s.connectedCount;
        this.reply(ws, msg, { submitted, total, myChoice: d.choice });
        this.liveSoon();        // 잠들었다 깨어나도 이 제출이 살아 있도록
        this.pushStudent(ws);   // 본인 화면을 "제출 완료" 잠금으로
        this.queueProgress(s.getPlayer(meta.token)?.villageIndex);
        if (submitted >= total && total > 0) {
          this.demoSoon(() => this.finishRound('all-submitted'), 600);
        }
        return;
      }

      case 'student:warmup': {
        const s = this.session;
        if (!s) throw new Error('세션이 만료되었습니다.');
        if (s.stageId !== 'warmup') throw new Error('지금은 투표 시간이 아니에요.');
        if (!s.warmupVote(meta.token, d.questionId, d.optionIndex)) throw new Error('투표하지 못했어요.');
        this.saveSoon();
        this.reply(ws, msg, {});
        this.pushStudent(ws);
        this.later('warmup', THROTTLE_MS, () => {
          this.broadcast(push('warmup:tally', { warmup: s.warmup, playerCount: s.connectedCount }),
            (m) => m.role === 'host');
        });
        return;
      }

      case 'student:council': {
        const s = this.session;
        if (!s) throw new Error('세션이 만료되었습니다.');
        if (s.stageId !== 'council') throw new Error('지금은 마을회의 시간이 아니에요.');
        const tally = s.councilVote(meta.token, d.institutionId);
        if (!tally) throw new Error('투표하지 못했어요.');
        this.saveSoon();
        this.reply(ws, msg, { council: tally });
        this.pushVillage(s.getPlayer(meta.token).villageIndex, push('council:tally', tally));
        this.pushHost();
        return;
      }

      case 'student:reflect': {
        const s = this.session;
        if (!s) throw new Error('세션이 만료되었습니다.');
        if (s.stageId !== 'reflect') throw new Error('지금은 소감 시간이 아니에요.');
        const player = s.getPlayer(meta.token);
        if (!player) throw new Error('참가자를 찾을 수 없습니다.');
        if (player.reflectionCount >= REFLECTIONS_PER_STUDENT) {
          throw new Error(`한 사람이 ${REFLECTIONS_PER_STUDENT}개까지 쓸 수 있어.`);
        }
        const cleaned = cleanReflection(d.text);
        if (!cleaned.ok) throw new Error(cleaned.reason);

        const card = s.addReflection(cleaned.text);
        player.reflectionCount += 1;
        this.saveSoon();
        this.reply(ws, msg, { id: card.id });
        this.broadcast(push('reflect:add', card), (m) => m.role === 'student');
        this.pushHost();
        return;
      }

      case 'student:heart': {
        const s = this.session;
        if (!s) throw new Error('세션이 만료되었습니다.');
        const card = s.toggleHeart(meta.token, d.id);
        if (!card) throw new Error('그 소감을 찾을 수 없어요.');
        this.saveSoon();
        const mine = s.getPlayer(meta.token)?.hearted || [];
        this.reply(ws, msg, { hearts: card.hearts, mine: mine.includes(card.id) });
        this.broadcast(push('reflect:heart', { id: card.id, hearts: card.hearts }), (m) => m.role === 'student');
        this.later('hearts', THROTTLE_MS, () => this.pushHost());
        return;
      }

      case 'student:pledge': {
        const s = this.session;
        if (!s) throw new Error('세션이 만료되었습니다.');
        const count = s.setPledged(meta.token, d.on !== false);
        this.saveSoon();
        this.reply(ws, msg, { pledgeCount: count });
        this.broadcast(push('pledge:count', { pledgeCount: count, total: s.connectedCount }),
          (m) => m.role === 'student');
        this.pushHost();
        return;
      }

      case 'student:pledge:round': {
        const s = this.session;
        if (!s) throw new Error('세션이 만료되었습니다.');
        pledgeForRound(s, meta.token);
        this.saveSoon();
        this.reply(ws, msg, {});
        this.pushAllStudents();   // 같은 마을 서약 인원이 바뀌었다
        return;
      }

      default:
        throw new Error(`알 수 없는 요청: ${msg.t}`);
    }
  }

  async moveStage(apply) {
    apply();
    await this.ctx.storage.deleteAlarm();
    await this.saveLive();
    this.clearTimer('progress');
    this.clearDemoTimers();
    this.runDemoForStage();
    this.saveSoon();
    this.pushHost();
    this.pushAllStudents();
  }
}
