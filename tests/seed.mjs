// 견본 명단(지어낸 29명: 남 20·여 9, 부서 6, 임원 4). 이름은 모두 '견본○'꼴이라 실명이 아님이 분명하다.
// 사용: node seed.mjs [--picked] [--no-gender] [--reset]   (DB 가 떠 있어야 함: node run.mjs db-up)
import { connect } from './db.mjs';

const SYL = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고'.split(''); // 29글자
const DEPTS = ['시험영업부', '시험개발부', '시험생산부', '시험품질부', '시험관리부', '시험기획부'];
const TITLES = ['대표이사', '상무', '이사', '전무', '부장', '부장', '차장', '차장', '과장', '과장', '대리', '대리', '사원'];
const EXEC_IDX = new Set([0, 1, 2, 3]); // 임원(대표이사·상무·이사·전무)

export function roster({ noGender = false } = {}) {
  return SYL.map((s, i) => ({
    name: `견본${s}`,
    dept: DEPTS[i % DEPTS.length],
    title: EXEC_IDX.has(i) ? TITLES[i] : TITLES[4 + ((i - 4) % 9)],
    gender: i % 3 === 2 && i < 27 ? '여' : '남', // 여 9명(i=2,5,…,26), 나머지 남 20명
  })).map((p, i, a) => (noGender && i === a.length - 1 ? { ...p, gender: null } : p));
}

/** 명단을 비우고(되돌리기 기록 포함, id 도 1부터) 견본 29명을 다시 넣는다 */
export async function resetRoster(c, opts = {}) {
  await c.query('truncate public.people, public.people_log restart identity');
  await c.query("delete from public.config where key = 'schedule'");
  const rows = roster(opts);
  for (const p of rows) {
    await c.query('insert into public.people (dept, name, title, gender) values ($1,$2,$3,$4)', [p.dept, p.name, p.title, p.gender]);
  }
  if (opts.picked) await applyPicked(c);
  return rows.length;
}

/** "일부는 이미 뽑은 상태": id 1~12 는 팀·조식, 1~10 중 성별 있는 사람은 방, 1~8 은 점심, 1~6 은 자유시간.
 *  (팀 균형을 맞춘 게 아니라 화면 시험용으로 직접 채운 값) */
export async function applyPicked(c) {
  await c.query(`
    update public.people set
      team = (array['red','blue','yellow','green'])[1 + (id - 1) % 4], picked_at = now() - (13 - id) * interval '1 minute'
    where id <= 12;
    update public.people set menu = (array['ugeoji','miyeok','hwangtae'])[1 + id % 3] where id <= 12;
    update public.people set lunch = (array['plain','spicy'])[1 + id % 2] where id <= 8;
    update public.people set activity = (array['ski','rest'])[1 + id % 2] where id <= 6;
    update public.people set room = case when gender = '남' then (array['m1','m2','m3','m4','m5'])[1 + id % 5]
                                         else (array['f1','f2'])[1 + id % 2] end
    where id <= 10 and gender is not null;`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = new Set(process.argv.slice(2));
  const c = await connect();
  try {
    const n = await resetRoster(c, { picked: a.has('--picked'), noGender: a.has('--no-gender') });
    console.log(`견본 명단 ${n}명을 넣었어요.${a.has('--picked') ? ' (일부 뽑은 상태)' : ''}${a.has('--no-gender') ? ' (성별 없는 1명 포함)' : ''}`);
  } finally { await c.end(); }
}
