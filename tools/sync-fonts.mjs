// 폰트를 node_modules 에서 public/fonts/ 로 복사한다.
// 교실에는 인터넷이 없으므로 CDN 대신 우리 서버가 직접 서빙한다.
// 둘 다 OFL(자유 사용) 라이선스이며, 라이선스 원문도 함께 복사한다.
//
//   node tools/sync-fonts.mjs
//
// 한글은 글자 수가 많아 통짜 파일이 2MB 나 된다. 34대가 동시에 받으면
// 약한 핫스팟에서 버거우므로, 유니코드 구간별로 쪼갠 "동적 서브셋"을 쓴다.
// 브라우저가 실제로 화면에 뜬 글자에 해당하는 조각만 받아 간다.

import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('public/fonts');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const PRETENDARD = 'node_modules/pretendard/dist/web/variable';
const MONO = 'node_modules/@fontsource-variable/jetbrains-mono';

function need(p) {
  const full = path.resolve(p);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ 없음: ${p}\n    먼저 npm install 을 실행해 주세요.`);
    process.exit(1);
  }
  return full;
}

// 1) Pretendard Variable — 한글 본문/제목 (동적 서브셋)
fs.copyFileSync(
  need(`${PRETENDARD}/pretendardvariable-dynamic-subset.css`),
  path.join(OUT, 'pretendard.css'),
);
fs.cpSync(
  need(`${PRETENDARD}/woff2-dynamic-subset`),
  path.join(OUT, 'woff2-dynamic-subset'),
  { recursive: true },
);

// 2) JetBrains Mono Variable — 라벨·캡션용 (라틴만 쓰므로 한 조각이면 충분)
fs.copyFileSync(
  need(`${MONO}/files/jetbrains-mono-latin-wght-normal.woff2`),
  path.join(OUT, 'JetBrainsMono-latin.woff2'),
);

fs.writeFileSync(path.join(OUT, 'mono.css'), `/* JetBrains Mono Variable — SIL Open Font License 1.1 */
@font-face {
  font-family: 'JetBrains Mono Variable';
  font-style: normal;
  font-display: swap;
  font-weight: 100 800;
  src: url(./JetBrainsMono-latin.woff2) format('woff2-variations');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,
    U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212,
    U+2215, U+FEFF, U+FFFD;
}
`, 'utf8');

// 3) 라이선스 원문 (OFL 은 사본을 함께 배포해야 한다)
for (const [from, to] of [
  ['node_modules/pretendard/LICENSE', 'LICENSE-Pretendard.txt'],
  [`${MONO}/LICENSE`, 'LICENSE-JetBrainsMono.txt'],
]) {
  const src = path.resolve(from);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, to));
}

const subsets = fs.readdirSync(path.join(OUT, 'woff2-dynamic-subset'));
const one = Math.round(fs.statSync(path.join(OUT, 'woff2-dynamic-subset', subsets[0])).size / 1024);
console.log(`  ✓ Pretendard Variable — 서브셋 ${subsets.length}조각 (조각당 약 ${one}KB)`);
console.log('  ✓ JetBrains Mono Variable — 라틴 1조각');
console.log('  ✓ OFL 라이선스 사본');
console.log('\npublic/fonts/ 준비 완료 — 외부 요청 없이 동작합니다.');
