// content/ 아래 JSON 을 한 번만 읽어 캐시한다. 전부 우리 서버에서 오므로 외부 요청이 없다.

const cache = new Map();

/** 콘텐츠는 서버가 내보낸다 (시나리오는 삽화 경로까지 붙여서) */
const URL_FOR = {
  scenarios: '/api/scenarios',
  warmup: '/api/warmup',
  story: '/api/story',
  institutions: '/api/institutions',
};

async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const p = fetch(URL_FOR[name] || `/content/${name}.json`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${name}.json 을 읽지 못했습니다`))))
    .catch((err) => { cache.delete(name); throw err; });
  cache.set(name, p);
  return p;
}

/** 시나리오 세트에서 id 로 하나 꺼내기 */
export async function getScenario(scenarioId, setId = 'default') {
  if (!scenarioId) return null;
  const data = await load('scenarios');
  const set = data.sets.find((s) => s.id === setId) || data.sets[0];
  return set?.scenarios?.[scenarioId] || null;
}

export async function getScenarioSets() {
  const data = await load('scenarios');
  return data.sets.map((s) => ({ id: s.id, name: s.name }));
}

export async function getWarmup() {
  return (await load('warmup')).questions;
}

export async function getStory() {
  return load('story');
}

export async function getInstitutions() {
  const data = await load('institutions');
  return data.institutions;
}

export async function getInstitution(id) {
  if (!id) return null;
  return (await getInstitutions()).find((x) => x.id === id) || null;
}

/** 선택지 공통 표기 — a 의 마을 영향은 학생에게 감춘다 */
export const CHOICE_META = {
  a: { key: 'a', emoji: '🤫', name: '몰래 이득', coin: '+3', trust: '???', trustReal: '-2', tone: 'sly' },
  b: { key: 'b', emoji: '📏', name: '규칙대로', coin: '+1', trust: '+1', trustReal: '+1', tone: 'rule' },
  c: { key: 'c', emoji: '📣', name: '용기 내어 알리기', coin: '0', trust: '+3', trustReal: '+3', tone: 'brave' },
};
export const CHOICE_ORDER = ['a', 'b', 'c'];

/**
 * 시나리오 그림.
 * 선생님이 illustrations/ 에 넣은 파일이 있으면 그 이미지를,
 * 없으면 이모지와 색으로 그린 카드를 돌려준다.
 * 이미지가 있는데 깨져 있어도 (파일이 지워졌다든가) 조용히 이모지로 넘어간다.
 */
export function scenarioArt(scenario, { className = 'scene-art' } = {}) {
  const tone = scenario?.tone || 'cream';
  const emoji = scenario?.emoji || '🖼️';

  const fallback = () => {
    const box = document.createElement('div');
    box.className = `${className} art-fallback block-${tone}`;
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', scenario?.title || '');
    const face = document.createElement('span');
    face.className = 'art-emoji';
    face.textContent = emoji;
    box.append(face);
    return box;
  };

  if (!scenario?.imageUrl) return fallback();

  const img = document.createElement('img');
  img.className = className;
  img.alt = scenario.title || '';
  img.decoding = 'async';
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  img.src = scenario.imageUrl;
  return img;
}
