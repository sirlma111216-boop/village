// content/ 아래 JSON 을 서버가 읽어 두는 곳.
// 프런트도 같은 파일을 직접 받아 가지만, 서버는 "제도 순서"처럼
// 판정에 필요한 값 때문에 따로 들고 있어야 한다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const DIR = path.join(ROOT, 'content');

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  } catch (err) {
    console.warn(`[content] ${name}.json 을 읽지 못했습니다 — ${err.message}`);
    return fallback;
  }
}

const institutionsFile = read('institutions', { institutions: [] });

/** 제도 목록. 배열 순서가 곧 동점일 때의 우선순위다. */
export const INSTITUTIONS = institutionsFile.institutions || [];
export const INSTITUTION_IDS = INSTITUTIONS.map((i) => i.id);

export function institutionName(id) {
  return INSTITUTIONS.find((i) => i.id === id)?.name || id || '';
}

export function isInstitution(id) {
  return INSTITUTION_IDS.includes(id);
}

const warmupFile = read('warmup', { questions: [] });
export const WARMUP_QUESTIONS = warmupFile.questions || [];
export const warmupQuestion = (id) => WARMUP_QUESTIONS.find((q) => q.id === id) || null;

// ------------------------------------------------------------------ 삽화

const ILLUSTRATIONS = path.join(ROOT, 'public', 'illustrations');

/** 확장자를 가리지 않는다. 선생님이 넣은 사진이 우리가 만든 그림보다 우선. */
const EXT_ORDER = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg'];

/**
 * illustrations/ 에서 이름이 같은 파일을 찾는다.
 * 없으면 null — 화면은 이모지 색 블록으로 대신 그린다.
 */
export function resolveIllustration(name) {
  if (!name) return null;
  const base = String(name).replace(/\.[a-z0-9]+$/i, '').replace(/[^\w-]/g, '');
  if (!base) return null;

  let files = [];
  try {
    files = fs.readdirSync(ILLUSTRATIONS);
  } catch {
    return null;
  }
  const found = files
    .filter((f) => f.replace(/\.[a-z0-9]+$/i, '').toLowerCase() === base.toLowerCase())
    .sort((a, b) => EXT_ORDER.indexOf(path.extname(a).toLowerCase())
                  - EXT_ORDER.indexOf(path.extname(b).toLowerCase()));

  return found[0] ? `/illustrations/${found[0]}` : null;
}

/**
 * 시나리오를 읽어 삽화 경로까지 붙여 준다.
 * 폴더를 매번 읽으므로, 수업 중에 이미지를 넣어도 새로고침하면 바로 뜬다.
 */
export function scenariosWithArt() {
  const data = read('scenarios', { sets: [] });
  for (const set of data.sets || []) {
    for (const sc of Object.values(set.scenarios || {})) {
      sc.imageUrl = resolveIllustration(sc.image);
    }
  }
  return data;
}
