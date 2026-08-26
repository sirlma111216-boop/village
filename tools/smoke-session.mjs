// 개발용 점검 스크립트 (수업 실행과 무관): node tools/smoke-session.mjs
import { Session } from '../server/game/session.js';
const s = new Session('ABC234');
for (let i = 0; i < 10; i++) s.addPlayer();
console.log('sizes(4villages):', s.villageSizes());
console.log('sample roster:', s.hostState().roster.slice(0, 3));
s.setVillageCount(3);
console.log('after->3:', s.villageSizes());
const snap = s.toSnapshot();
console.log('secretChoices in snapshot?', Object.keys(snap).includes('secretChoices'));
const r = Session.fromSnapshot(snap);
console.log('restored:', r.playerCount, r.villageSizes(), r.stageId);
console.log('stage walk:', s.stageId, '->', s.goNext(), '->', s.goNext(), '-> back', s.goPrev());
