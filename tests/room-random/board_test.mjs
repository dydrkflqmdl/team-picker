// 사용: node tests/room-random/board_test.mjs board.html [판 수=4000]
// board.html 의 roomPlan(자동으로 나누기·방 없는 사람만 넣기)을 그대로 떼어 와 같은 지표로 시험
import fs from 'node:fs';
import { PEOPLE, SCN, baseline, compare } from './stats.mjs';
const html = fs.readFileSync(process.argv[2], 'utf8');
const a = html.indexOf('  const shuffle = (list) =>'), b = html.indexOf('  async function assignRooms');
if (a < 0 || b < a) throw new Error('board.html 에서 계획 코드를 못 찾음');
const code = html.slice(a, b);
const ROOM_KEYS = ['m1', 'm2', 'm3', 'm4', 'm5', 'f1', 'f2'];
const roomGender = (key) => (key[0] === 'm' ? '남' : '여');
let people = [];
const roomPlan = new Function('ROOM_KEYS', 'roomGender', 'getPeople', code.replace(/\bpeople\b/g, 'getPeople()') + '\nreturn roomPlan;')(ROOM_KEYS, roomGender, () => people);
const RUNS = +process.argv[3] || 4000, BASE_N = 100000;
function run(scn, onlyNew, start) {
  const pre = SCN[start];
  const out = [];
  for (let t = 0; t < RUNS; t++) {
    people = PEOPLE.map((p) => ({ ...p, room: pre[p.name] || null }));
    const rows = roomPlan(onlyNew);
    const room = Object.fromEntries(people.map((p) => [p.name, p.room]));
    for (const r of rows) room[people.find((p) => p.id === r.id).name] = r.value || null;
    out.push(room);
  }
  const base = Array.from({ length: BASE_N }, baseline(scn));
  return compare(`board ${onlyNew ? '방 없는 사람만 넣기' : '자동으로 나누기'} (시작: ${start})`, out, base, scn);
}
console.log(JSON.stringify(run('A', false, 'A')));
console.log(JSON.stringify(run('A', false, 'C'))); // 이미 방이 있어도 전부 새로
console.log(JSON.stringify(run('A', true, 'A')));
console.log(JSON.stringify(run('B2', true, 'B2')));
console.log(JSON.stringify(run('C', true, 'C')));
// 다른 성별 방에 진행자가 넣은 사람이 있을 때(B: 남자 M20 이 f2): board 는 그 사람도 f2 인원으로 셈 → 여자 쪽 목표가 DB 와 다름
{
  people = PEOPLE.map((p) => ({ ...p, room: SCN.B[p.name] || null }));
  const tally = {};
  for (let t = 0; t < 2000; t++) {
    people = PEOPLE.map((p) => ({ ...p, room: SCN.B[p.name] || null }));
    const rows = roomPlan(true);
    const c = { f1: 0, f2: 0 };
    for (const p of people) if (p.room in c) c[p.room]++;
    for (const r of rows) if (r.value in c) c[r.value]++;
    const k = `f1=${c.f1},f2=${c.f2}(남자 1명 포함)`; tally[k] = (tally[k] || 0) + 1;
  }
  console.log(JSON.stringify({ 'B(남자 1명이 f2) 방 없는 사람만 넣기 결과 인원': tally }));
}
