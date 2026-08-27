// 수업 콘텐츠 — JSON 을 그대로 불러온다.
// Node 와 Workers 둘 다 표준 JSON import 를 지원하므로 파일시스템이 필요 없다.

import scenariosFile from '../content/scenarios.json' with { type: 'json' };
import institutionsFile from '../content/institutions.json' with { type: 'json' };
import warmupFile from '../content/warmup.json' with { type: 'json' };
import storyFile from '../content/story.json' with { type: 'json' };

export const SCENARIOS = scenariosFile;
export const STORY = storyFile;

/** 제도 목록. 배열 순서가 곧 동점일 때의 우선순위다. */
export const INSTITUTIONS = institutionsFile.institutions || [];
export const INSTITUTION_IDS = INSTITUTIONS.map((i) => i.id);
export const institutionName = (id) => INSTITUTIONS.find((i) => i.id === id)?.name || id || '';
export const isInstitution = (id) => INSTITUTION_IDS.includes(id);

export const WARMUP_QUESTIONS = warmupFile.questions || [];
export const warmupQuestion = (id) => WARMUP_QUESTIONS.find((q) => q.id === id) || null;

/** 시나리오 세트 하나를 꺼낸다 */
export function scenarioSet(setId = 'default') {
  return SCENARIOS.sets.find((s) => s.id === setId) || SCENARIOS.sets[0];
}
