// 마을 정체성 — 디자인 시스템의 color-block 팔레트를 그대로 쓴다.
// 흰 종이 위에 붙인 커다란 색종이(스티커) 한 장이 곧 한 마을.
// 글자는 언제나 검정(ink)이므로 색은 "면"으로만 쓴다.

export const VILLAGE_PRESETS = [
  { name: '라임마을',   emoji: '🍃', color: '#dceeb1', token: 'lime' },
  { name: '라벤더마을', emoji: '🪻', color: '#c5b0f4', token: 'lilac' },
  { name: '크림마을',   emoji: '🌾', color: '#f4ecd6', token: 'cream' },
  { name: '민트마을',   emoji: '🌱', color: '#c8e6cd', token: 'mint' },
  { name: '벚꽃마을',   emoji: '🌸', color: '#efd4d4', token: 'pink' },
  { name: '살구마을',   emoji: '🍑', color: '#f3c9b6', token: 'coral' },
];

export function villagePreset(i) {
  return VILLAGE_PRESETS[i % VILLAGE_PRESETS.length];
}
