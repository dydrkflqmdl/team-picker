// 사용: 시험용 DB 에 supabase.sql → seed.sql → simproc.sql 을 적용하고
//   call sim('A', 4000, null); 등으로 돌린 뒤 res 를 CSV(scn,run,name,dept,gender,room,ord)로 내보내
//   node tests/room-random/analyze_sql.mjs sim.csv
import fs from 'node:fs';
import { baseline, compare, PEOPLE, SCN, gof } from './stats.mjs';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => l.split(','));
const runs = {}; // scn → run → {room: {name: room}, ord: {name: ord}}
for (const [scn, run, name, , , room, ord] of rows) {
  const r = ((runs[scn] ??= {})[run] ??= { room: {}, ord: {} });
  r.room[name] = room; r.ord[name] = +ord;
}
const BASE_N = 100000;
for (const scn of Object.keys(runs)) {
  const list = Object.values(runs[scn]);
  const gen = baseline(scn);
  const base = Array.from({ length: BASE_N }, gen);
  console.log(JSON.stringify(compare(`SQL pick_room 한 명씩 ${scn}`, list.map((r) => r.room), base, scn)));
  // 뽑은 차례와 '큰 방'(여자: 최종 인원이 더 많은 방) — 먼저 뽑은 사람이 큰 방에 덜/더 들어가지 않는지
  const fem = PEOPLE.filter((p) => p.gender === '여' && !SCN[scn][p.name]);
  const nf = fem.length;
  const big = Array.from({ length: nf + 1 }, () => 0), tot = Array.from({ length: nf + 1 }, () => 0);
  for (const r of list) {
    const c = { f1: 0, f2: 0 };
    for (const p of PEOPLE) if (p.gender === '여') c[r.room[p.name]]++;
    const bigRoom = c.f1 > c.f2 ? 'f1' : c.f2 > c.f1 ? 'f2' : null;
    for (const p of fem) { const o = r.ord[p.name] - PEOPLE.filter((q) => q.gender === '남' && !SCN[scn][q.name] && r.ord[q.name] < r.ord[p.name]).length; tot[o]++; if (r.room[p.name] === bigRoom) big[o]++; }
  }
  // 기준: 방 없는 여자가 큰 방에 들 확률
  let bb = 0, bt = 0;
  for (const r of base) { const c = { f1: 0, f2: 0 }; for (const p of PEOPLE) if (p.gender === '여') c[r[p.name]]++; const br = c.f1 > c.f2 ? 'f1' : 'f2'; for (const p of fem) { bt++; if (r[p.name] === br) bb++; } }
  const q = bb / bt;
  let x2 = 0, df = 0;
  const byOrd = [];
  for (let o = 1; o <= nf; o++) { const g = gof([big[o], tot[o] - big[o]], [q, 1 - q]); x2 += g.x2; df += g.df; byOrd.push(+(big[o] / tot[o]).toFixed(3)); }
  console.log(JSON.stringify({ scn, '여자 중 n번째로 뽑은 사람이 큰 방에 든 비율': byOrd, 기준: +q.toFixed(3) }));
}
