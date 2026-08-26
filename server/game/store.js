import { Session } from './session.js';
import { makeSessionCode } from '../lib/code.js';
import { saveSnapshot, saveSnapshotSync, loadAllSnapshots, deleteSnapshot } from '../lib/persist.js';
import { SNAPSHOT_INTERVAL_MS } from '../config.js';

/**
 * 살아 있는 모든 세션의 보관소.
 * 외부 DB 없이 메모리 + 주기적 스냅샷으로만 버틴다.
 */
export class SessionStore {
  constructor() {
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.timer = null;
    /** 스냅샷이 필요한 세션 코드 (30초 주기에 한꺼번에 기록) */
    this.dirty = new Set();
  }

  /** 서버 시작 시 디스크에 남은 세션을 되살린다. */
  async restore() {
    const snaps = await loadAllSnapshots();
    for (const snap of snaps) {
      try {
        const s = Session.fromSnapshot(snap);
        this.sessions.set(s.code, s);
      } catch (err) {
        console.warn(`[store] 복구 실패 ${snap?.code}: ${err.message}`);
      }
    }
    if (snaps.length) console.log(`[store] 세션 ${snaps.length}개 복구: ${[...this.sessions.keys()].join(', ')}`);
    return this.sessions.size;
  }

  create(settings) {
    const code = makeSessionCode((c) => this.sessions.has(c));
    const session = new Session(code, settings);
    this.sessions.set(code, session);
    this.markDirty(code);
    return session;
  }

  get(code) {
    return code ? this.sessions.get(String(code).toUpperCase()) || null : null;
  }

  has(code) { return this.sessions.has(String(code || '').toUpperCase()); }

  async destroy(code) {
    this.sessions.delete(code);
    this.dirty.delete(code);
    await deleteSnapshot(code);
  }

  markDirty(code) { this.dirty.add(code); }

  /** 라운드 종료처럼 "지금 반드시" 남겨야 하는 순간에 호출 */
  async saveNow(code) {
    const s = this.get(code);
    if (!s) return;
    this.dirty.delete(code);
    try {
      await saveSnapshot(code, s.toSnapshot());
    } catch (err) {
      console.warn(`[store] 스냅샷 저장 실패 ${code}: ${err.message}`);
    }
  }

  async flushDirty() {
    const codes = [...this.dirty];
    this.dirty.clear();
    for (const code of codes) {
      const s = this.get(code);
      if (!s) continue;
      try {
        await saveSnapshot(code, s.toSnapshot());
      } catch (err) {
        console.warn(`[store] 스냅샷 저장 실패 ${code}: ${err.message}`);
      }
    }
  }

  startAutosave(intervalMs = SNAPSHOT_INTERVAL_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flushDirty(); }, intervalMs);
    this.timer.unref?.();
  }

  stopAutosave() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 종료 직전 — 비동기를 기다릴 수 없으므로 동기로 남긴다. */
  flushSync() {
    for (const [code, s] of this.sessions) {
      try {
        saveSnapshotSync(code, s.toSnapshot());
      } catch (err) {
        console.warn(`[store] 종료 저장 실패 ${code}: ${err.message}`);
      }
    }
  }
}

export const store = new SessionStore();
