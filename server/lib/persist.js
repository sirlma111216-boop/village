import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_TTL_MS } from '../config.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const SESSION_DIR = path.join(ROOT, 'data', 'sessions');

fs.mkdirSync(SESSION_DIR, { recursive: true });

const fileFor = (code) => path.join(SESSION_DIR, `${code}.json`);

/**
 * 스냅샷 저장. 임시 파일에 쓰고 rename 하여 중간에 죽어도 파일이 깨지지 않게 한다.
 * 저장되는 내용에는 "누가 무엇을 골랐는지"가 절대 들어가지 않는다(세션 직렬화에서 보장).
 */
export async function saveSnapshot(code, data) {
  const target = fileFor(code);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, target);
}

export function saveSnapshotSync(code, data) {
  const target = fileFor(code);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

export async function deleteSnapshot(code) {
  await fsp.rm(fileFor(code), { force: true });
}

/** 서버 재시작 시 복구용 — 유효한 스냅샷을 모두 읽는다. 오래된 것은 지운다. */
export async function loadAllSnapshots() {
  const out = [];
  let names = [];
  try {
    names = await fsp.readdir(SESSION_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(SESSION_DIR, name);
    try {
      const raw = await fsp.readFile(full, 'utf8');
      const data = JSON.parse(raw);
      const age = Date.now() - (data.updatedAt || data.createdAt || 0);
      if (age > SESSION_TTL_MS) {
        await fsp.rm(full, { force: true });
        continue;
      }
      out.push(data);
    } catch (err) {
      console.warn(`[persist] 스냅샷을 읽지 못했습니다: ${name} — ${err.message}`);
    }
  }
  return out;
}
