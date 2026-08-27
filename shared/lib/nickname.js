// 익명 닉네임 생성기 — "형용사 + 동물". 개인정보를 대신하는 유일한 식별자.

const ADJECTIVES = [
  '용감한', '재빠른', '느긋한', '엉뚱한', '따뜻한', '씩씩한', '조용한', '반짝이는',
  '든든한', '똑똑한', '상냥한', '깜찍한', '단단한', '포근한', '날렵한', '유쾌한',
  '차분한', '호기심많은', '정직한', '다정한', '슬기로운', '기운찬', '부지런한', '천진한',
  '멋진', '귀여운', '당당한', '섬세한', '느티나무같은', '보름달같은', '초록빛', '푸른',
];

const ANIMALS = [
  '수달', '너구리', '고양이', '판다', '여우', '다람쥐', '올빼미', '해달',
  '펭귄', '알파카', '고슴도치', '두더지', '햄스터', '카피바라', '돌고래', '나무늘보',
  '북극곰', '사슴', '토끼', '거북이', '앵무새', '문어', '오리', '족제비',
  '표범', '두루미', '기린', '코알라', '미어캣', '바다거북', '청설모', '까치',
];

const EMOJIS = ['🦦','🦝','🐱','🐼','🦊','🐿️','🦉','🦭','🐧','🦙','🦔','🐹','🐬','🦥','🐻‍❄️','🦌','🐰','🐢','🦜','🐙','🦆','🐆','🦩','🦒','🐨','🐦','🌱','⭐'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 세션 안에서 겹치지 않는 닉네임을 만든다.
 * @param {Set<string>} taken 이미 쓰인 닉네임 집합
 */
export function makeNickname(taken = new Set()) {
  for (let i = 0; i < 200; i++) {
    const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
    if (!taken.has(name)) return name;
  }
  // 조합이 바닥나면 숫자를 붙인다 (34명 학급에서는 거의 오지 않는 경로)
  let n = 2;
  let base = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** 닉네임에서 결정적으로 이모지를 뽑는다 (같은 닉네임 = 같은 이모지) */
export function nicknameEmoji(nickname) {
  let h = 0;
  for (let i = 0; i < nickname.length; i++) h = (h * 31 + nickname.charCodeAt(i)) >>> 0;
  return EMOJIS[h % EMOJIS.length];
}
