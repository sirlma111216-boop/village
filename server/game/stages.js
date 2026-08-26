// 수업 진행 상태 머신. 전진은 오직 진행자의 "다음" 버튼으로만 일어난다.

/**
 * kind — 화면이 무엇을 그릴지 결정하는 분류
 *   lobby | warmup | story | rules | round | interim | council | reveal | reflect | pledge | end
 * scenario — content/scenarios.json 의 id
 * scoring  — 점수에 반영되는 라운드인가 (연습 라운드는 false)
 * round    — 집계·그래프에서 쓰는 라운드 번호 (연습은 0)
 */
export const STAGES = [
  { id: 'lobby',    kind: 'lobby',    label: '입장 대기',       hostHint: '학생들이 QR 또는 코드로 들어옵니다.' },
  { id: 'warmup',   kind: 'warmup',   label: '워밍업 투표',     hostHint: '두 문항을 차례로 물어봅니다.' },
  { id: 'story',    kind: 'story',    label: '기게스의 반지',   hostHint: '3컷 이야기를 함께 읽습니다.' },
  { id: 'rules',    kind: 'rules',    label: '게임 규칙',       hostHint: '선택지 3개와 신뢰지수를 설명합니다.' },
  { id: 'practice', kind: 'round',    label: '연습 라운드',     scenario: 'practice', scoring: false, round: 0, hostHint: '점수에 반영되지 않는 연습입니다.' },
  { id: 'round1',   kind: 'round',    label: '라운드 1',        scenario: 'r1', scoring: true, round: 1 },
  { id: 'round2',   kind: 'round',    label: '라운드 2',        scenario: 'r2', scoring: true, round: 2 },
  { id: 'interim',  kind: 'interim',  label: '중간 집계',       hostHint: '마을 신뢰지수를 공개합니다.' },
  { id: 'council',  kind: 'council',  label: '마을회의',        hostHint: '마을별로 토의 후 제도를 다수결로 정합니다.' },
  { id: 'round3',   kind: 'round',    label: '라운드 3',        scenario: 'r3', scoring: true, round: 3 },
  { id: 'round4',   kind: 'round',    label: '라운드 4',        scenario: 'r4', scoring: true, round: 4 },
  { id: 'reveal',   kind: 'reveal',   label: '최종 발표',       hostHint: '개인 코인 → 마을 코인 → 신뢰지수 순으로 공개합니다.' },
  { id: 'reflect',  kind: 'reflect',  label: '소감 나누기',     hostHint: '익명 소감이 실시간으로 벽에 붙습니다.' },
  { id: 'pledge',   kind: 'pledge',   label: '우리의 서약',     hostHint: '서약 버튼을 누른 인원이 채워집니다.' },
  { id: 'end',      kind: 'end',      label: '수업 마무리',     hostHint: '결과 CSV를 내려받을 수 있습니다.' },
];

export const STAGE_IDS = STAGES.map((s) => s.id);
export const FIRST_STAGE = STAGES[0].id;

const BY_ID = new Map(STAGES.map((s) => [s.id, s]));

export function getStage(id) {
  return BY_ID.get(id) || STAGES[0];
}

export function stageIndex(id) {
  const i = STAGE_IDS.indexOf(id);
  return i < 0 ? 0 : i;
}

export function nextStageId(id) {
  const i = stageIndex(id);
  return STAGE_IDS[Math.min(i + 1, STAGES.length - 1)];
}

export function prevStageId(id) {
  const i = stageIndex(id);
  return STAGE_IDS[Math.max(i - 1, 0)];
}

export function isRoundStage(id) {
  return getStage(id).kind === 'round';
}

/** 점수에 반영되는 라운드 단계들 (그래프 축 만들 때 사용) */
export const SCORING_ROUND_STAGES = STAGES.filter((s) => s.kind === 'round' && s.scoring);
