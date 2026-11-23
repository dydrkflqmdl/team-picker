// 자동 섞기(admin_shuffle('room', …)) 결과가 '가장 고른 모든 나눔 가운데 똑같은 확률'(완전 무작위 기준)과 같은지 본다.
// tests/admin_shuffle_db_test.sh 가 부른다: node tests/admin_shuffle_room_stats.mjs 결과.csv
//   CSV 한 줄 = scn,run,name,room (scn 은 tests/room-random/stats.mjs 의 시작 상황 A·B2·C 이름 뒤에 ':all' 또는 ':fill')
// 기준·지표·카이제곱은 tests/room-random/stats.mjs 그대로(pick_room 시험과 같은 잣대). 하나라도 어긋나면 끝 코드 1.
import fs from 'node:fs';
import { baseline, compare } from './room-random/stats.mjs';

const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => l.split(','));
const runs = {}; // scn → run → {name: room}
for (const [scn, run, name, room] of rows) ((runs[scn] ??= {})[run] ??= {})[name] = room || null;
const BASE_N = 100000;
const P_MIN = 0.001; // 이보다 작으면 기준과 다르다고 봄(여러 지표를 보므로 넉넉히)
let bad = 0;
for (const key of Object.keys(runs)) {
  const scn = key.split(':')[0];
  const list = Object.values(runs[key]);
  const gen = baseline(scn);
  const base = Array.from({ length: BASE_N }, gen);
  const r = compare(`admin_shuffle ${key}`, list, base, scn);
  const ok = r.mixed === 0 && r.badSize === 0 && r.pairsHistP > P_MIN && r.personRoom.p > P_MIN && r.coRoom.p > P_MIN;
  if (!ok) bad++;
  console.log(`${ok ? 'OK' : 'NG'} ${JSON.stringify(r)}`);
}
process.exit(bad ? 1 : 0);
