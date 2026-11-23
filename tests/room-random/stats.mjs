// 방 배정 무작위 시험 공통(지어낸 명단 남 20·여 9·부서 6개, 시작 상황 A·B·B2·C, 완전 무작위 기준, 지표, 카이제곱). DB 없이 node 만 있으면 됨.
// 공통: 명단, 시나리오, 기준(완전 무작위) 분포, 지표, 카이제곱
export const ROOMS = { 남: ['m1', 'm2', 'm3', 'm4', 'm5'], 여: ['f1', 'f2'] };
const roster = [
  ['D1', 'M01', '남'], ['D1', 'M02', '남'], ['D1', 'M03', '남'], ['D1', 'M04', '남'], ['D1', 'M05', '남'], ['D1', 'F01', '여'], ['D1', 'F02', '여'], ['D1', 'F03', '여'],
  ['D2', 'M06', '남'], ['D2', 'M07', '남'], ['D2', 'M08', '남'], ['D2', 'M09', '남'], ['D2', 'F04', '여'], ['D2', 'F05', '여'],
  ['D3', 'M10', '남'], ['D3', 'M11', '남'], ['D3', 'M12', '남'], ['D3', 'F06', '여'], ['D3', 'F07', '여'],
  ['D4', 'M13', '남'], ['D4', 'M14', '남'], ['D4', 'M15', '남'], ['D4', 'F08', '여'],
  ['D5', 'M16', '남'], ['D5', 'M17', '남'], ['D5', 'F09', '여'],
  ['D6', 'M18', '남'], ['D6', 'M19', '남'], ['D6', 'M20', '남']];
export const PEOPLE = roster.map(([dept, name, gender], i) => ({ id: i + 1, dept, name, gender }));
export const SCN = {
  A: {},
  B: { M01: 'm1', M02: 'm1', M06: 'm2', M10: 'm3', F01: 'f1', F04: 'f1', F06: 'f1', M20: 'f2' },
  B2: { M01: 'm1', M02: 'm1', M06: 'm2', M10: 'm3', F01: 'f1', F04: 'f1', F06: 'f1' },
  C: { M01: 'm1', M02: 'm1', M03: 'm1', M04: 'm1', M05: 'm1', M06: 'm1', F01: 'f1', F02: 'f1', F03: 'f1', F04: 'f1', F05: 'f1' },
};
const sumsq = (a) => a.reduce((s, x) => s + x * x, 0);
// 가장 고른 인원(제곱합 최소): 한 명씩 가장 적은 방에 넣는 방식으로 최소 제곱합만 구함(합격 판정용)
function minSq(have, free) { const a = [...have]; for (let i = 0; i < free; i++) { const m = Math.min(...a); a[a.indexOf(m)]++; } return sumsq(a); }
// 기준: 성별마다, (같은 성별이 이미 들어 있는) 방 인원 have 에서 방 없는 사람을 '각자 아무 방에나 똑같은 확률'로 넣고
// 가장 고른 모양이 될 때만 받아들인다(거절 표집) → 가장 고른 모든 나눔이 똑같은 확률. 구현과 전혀 다른 방법.
export function baseline(scn) {
  const pre = SCN[scn];
  const out = {};
  for (const g of ['남', '여']) {
    const keys = ROOMS[g];
    const have = keys.map((k) => PEOPLE.filter((p) => p.gender === g && pre[p.name] === k).length);
    const free = PEOPLE.filter((p) => p.gender === g && !pre[p.name]);
    out[g] = { keys, have, free, target: minSq(have, free.length) };
  }
  return () => {
    const room = {};
    for (const p of PEOPLE) if (pre[p.name]) room[p.name] = pre[p.name];
    for (const g of ['남', '여']) {
      const { keys, have, free, target } = out[g];
      for (;;) {
        const c = [...have];
        const pick = free.map(() => Math.floor(Math.random() * keys.length));
        pick.forEach((i) => c[i]++);
        if (sumsq(c) === target) { free.forEach((p, j) => { room[p.name] = keys[pick[j]]; }); break; }
      }
    }
    return room;
  };
}
// 한 판(room: 이름 → 방)의 지표
export function measure(room, scn) {
  const pre = SCN[scn];
  let mixed = 0, pairs = 0;
  const size = {};
  for (const p of PEOPLE) {
    const r = room[p.name];
    if (!r) { mixed++; continue; }
    if (!pre[p.name] && !ROOMS[p.gender].includes(r)) mixed++;
    if (ROOMS[p.gender].includes(r)) size[r] = (size[r] || 0) + 1; // 같은 성별만 셈(DB 와 같음)
  }
  for (let i = 0; i < PEOPLE.length; i++) for (let j = i + 1; j < PEOPLE.length; j++) {
    const a = PEOPLE[i], b = PEOPLE[j];
    if (a.dept === b.dept && a.gender === b.gender && room[a.name] === room[b.name]) pairs++;
  }
  const sizes = { 남: ROOMS.남.map((k) => size[k] || 0), 여: ROOMS.여.map((k) => size[k] || 0) };
  return { mixed, pairs, sizes };
}
// 카이제곱 상측 확률 Q(df/2, x/2)
function lgamma(z) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let x = z, y = z, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const v of c) s += v / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function gammq(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) { let ap = a, sum = 1 / a, del = sum; for (let n = 0; n < 1000; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; } return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a)); }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
export const chiP = (x, df) => gammq(df / 2, x / 2);
// 관측 횟수 obs 와 기대 확률 prob(합 1)로 적합도 검정. 기대 5 미만 칸은 합침
export function gof(obs, prob) {
  const N = obs.reduce((s, x) => s + x, 0);
  let x2 = 0, df = -1, ro = 0, re = 0;
  obs.forEach((o, i) => { const e = prob[i] * N; if (e >= 5) { x2 += (o - e) ** 2 / e; df++; } else { ro += o; re += e; } });
  if (re > 0) { x2 += (ro - re) ** 2 / Math.max(re, 1e-9); df++; }
  return { x2, df, p: chiP(x2, df) };
}
// 결과 묶음(rooms: 판마다 이름→방)과 기준 묶음(base) 비교
export function compare(label, rooms, base, scn) {
  const pre = SCN[scn];
  const ms = rooms.map((r) => measure(r, scn)), mb = base.map((r) => measure(r, scn));
  const mixed = ms.reduce((s, m) => s + m.mixed, 0);
  // 방 인원: 가장 고른 모양(기준과 같은 정렬 인원)인지
  const key = (m) => JSON.stringify([[...m.sizes.남].sort(), [...m.sizes.여].sort()]);
  const okKeys = new Set(mb.map(key));
  const badSize = ms.filter((m) => !okKeys.has(key(m))).length;
  const spread = Math.max(...ms.map((m) => Math.max(Math.max(...m.sizes.남) - Math.min(...m.sizes.남), Math.max(...m.sizes.여) - Math.min(...m.sizes.여))));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  const ps = ms.map((m) => m.pairs), pb = mb.map((m) => m.pairs);
  // 같은 부서 쌍 수 분포 적합도
  const vals = [...new Set([...ps, ...pb])].sort((a, b) => a - b);
  const hp = gof(vals.map((v) => ps.filter((x) => x === v).length), vals.map((v) => pb.filter((x) => x === v).length / pb.length));
  // 사람×방 빈도(방 없는 사람만) 적합도
  let x2 = 0, df = 0;
  const free = PEOPLE.filter((p) => !pre[p.name]);
  for (const p of free) {
    const keys = ROOMS[p.gender];
    const g = gof(keys.map((k) => rooms.filter((r) => r[p.name] === k).length), keys.map((k) => base.filter((r) => r[p.name] === k).length / base.length));
    x2 += g.x2; df += g.df;
  }
  // 두 사람이 같은 방인 비율(같은 성별·둘 다 방 없는 사람 쌍) 적합도
  let y2 = 0, ydf = 0;
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
    const a = free[i], b = free[j];
    if (a.gender !== b.gender) continue;
    const o = rooms.filter((r) => r[a.name] === r[b.name]).length;
    const q = base.filter((r) => r[a.name] === r[b.name]).length / base.length;
    const g = gof([o, rooms.length - o], [q, 1 - q]); y2 += g.x2; ydf += g.df;
  }
  return { label, runs: rooms.length, mixed, badSize, spread,
    pairsMean: +mean(ps).toFixed(3), pairsSd: +sd(ps).toFixed(3), basePairsMean: +mean(pb).toFixed(3), basePairsSd: +sd(pb).toFixed(3),
    pairsHistP: +hp.p.toFixed(3), personRoom: { x2: +x2.toFixed(1), df, p: +chiP(x2, df).toFixed(3) }, coRoom: { x2: +y2.toFixed(1), df: ydf, p: +chiP(y2, ydf).toFixed(3) } };
}
