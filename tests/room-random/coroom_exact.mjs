// 사용: node tests/room-random/coroom_exact.mjs board.html 200000  (B2 에서 두 사람이 같은 방일 확률을 계산값과 비교)
// B2 '방 없는 사람만 넣기': 두 사람이 같은 방일 확률을 계산값(남 38/240, 여 110/210)과 비교. 사람×방도 함께.
import fs from 'node:fs';
import { PEOPLE, SCN } from './stats.mjs';
const html = fs.readFileSync(process.argv[2], 'utf8');
const code = html.slice(html.indexOf('  const shuffle = (list) =>'), html.indexOf('  async function assignRooms'));
let people = [];
const roomPlan = new Function('ROOM_KEYS', 'roomGender', 'getPeople', code.replace(/\bpeople\b/g, 'getPeople()') + '\nreturn roomPlan;')(['m1','m2','m3','m4','m5','f1','f2'], (k) => (k[0] === 'm' ? '남' : '여'), () => people);
const pre = SCN.B2, N = +process.argv[3];
const free = PEOPLE.filter((p) => !pre[p.name]);
const pairs = [];
for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) if (free[i].gender === free[j].gender) pairs.push([free[i].id, free[j].id, free[i].gender]);
const same = new Array(pairs.length).fill(0);
for (let t = 0; t < N; t++) {
  people = PEOPLE.map((p) => ({ ...p, room: pre[p.name] || null }));
  const room = {};
  for (const r of roomPlan(true)) room[r.id] = r.value;
  pairs.forEach(([a, b], k) => { if (room[a] === room[b]) same[k]++; });
}
const exact = { 남: 38 / 240, 여: 110 / 210 };
let z2 = 0, maxz = 0;
const pooled = { 남: [0, 0], 여: [0, 0] };
pairs.forEach(([, , g], k) => { const q = exact[g], z = (same[k] - N * q) / Math.sqrt(N * q * (1 - q)); z2 += z * z; maxz = Math.max(maxz, Math.abs(z)); pooled[g][0] += same[k]; pooled[g][1] += N; });
console.log(JSON.stringify({ runs: N, 쌍: pairs.length, 'z² 평균(1이 정상)': +(z2 / pairs.length).toFixed(3), '가장 큰 |z|': +maxz.toFixed(2),
  '남 같은 방 비율': +(pooled.남[0] / pooled.남[1]).toFixed(5), '남 계산값': +exact.남.toFixed(5), '여 같은 방 비율': +(pooled.여[0] / pooled.여[1]).toFixed(5), '여 계산값': +exact.여.toFixed(5) }));
