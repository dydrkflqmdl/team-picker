#!/bin/bash
# 진행자 자동 섞기(admin_shuffle: 팀·방·탑승 차량, 안 뽑은 사람만 / 전부 새로)와 아침 메뉴 한 번에 비우기(admin_clear('menu')) DB 시험.
# 로컬 임시 Postgres 에서만 돈다(운영 DB·인터넷에 닿지 않음). tests/.pgdata·tests/run.mjs 시험 환경과 따로다.
#
# 돌리기:  bash tests/admin_shuffle_db_test.sh
#   (Postgres 도구 위치가 다르면  PG_BIN=/경로/bin bash tests/admin_shuffle_db_test.sh)
#   통계 판 수를 줄이려면  QUICK=1 bash tests/admin_shuffle_db_test.sh
#
# 하는 일: 임시 폴더에 새 Postgres 클러스터를 만들어 127.0.0.1 의 빈 포트로 띄우고(tests/car_db_test.sh 와 같은 방식),
#   Supabase 흉내 → supabase.sql 을 두 번 Run → 시험 → 클러스터 삭제. 견본 이름은 모두 지어낸 이름, 관리자 비밀번호도 시험용 값이다.
# 마감(choices_closed): 시험 안에서만 마감 시각을 t.deadline 표 값으로 바꿔 쓰고(car_db_test.sh 와 같은 방식) 끝나면 supabase.sql 의 정의로 되돌린다.
set -u

PG_BIN=${PG_BIN:-/opt/homebrew/bin}
QUICK=${QUICK:-0}
OLD_REV=${OLD_REV:-72e66e3}   # pick_car 를 고치기 전 판(이 판의 pick_car 와 지금 pick_car 를 같은 난수로 비교)
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
SQL_FILE="$ROOT/supabase.sql"
CODE='shuffle-test-only-Pw-0123456789'   # 시험용 관리자 비밀번호(진짜 아님)

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  통과: $1"; }
ng() { FAIL=$((FAIL + 1)); echo "  실패: $1"; [ -n "${2:-}" ] && echo "        $2"; }
eq() { if [ "$3" = "$2" ]; then ok "$1"; else ng "$1" "기대: [$2] / 실제: [$3]"; fi; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) ng "$1" "기대 문구: [$2] / 실제: [$3]" ;; esac; }
title() { echo; echo "■ $1"; }

for b in initdb pg_ctl psql postgres; do
  if [ ! -x "$PG_BIN/$b" ]; then echo "찾을 수 없음: $PG_BIN/$b (PG_BIN 을 맞춰 주세요)"; exit 2; fi
done
command -v node >/dev/null || { echo "node 가 필요해요(방 통계 비교)"; exit 2; }

DATA=$(mktemp -d "${TMPDIR:-/tmp}/shuffle_db_test.XXXXXX") || exit 2
OUT="$DATA/out"
mkdir -p "$OUT"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$DATA/pg" -m immediate stop >/dev/null 2>&1
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "임시 클러스터: $DATA/pg"
"$PG_BIN/initdb" -D "$DATA/pg" -U postgres -A trust -E UTF8 --no-locale >"$DATA/initdb.log" 2>&1 || { cat "$DATA/initdb.log"; exit 2; }
PORT=
for try in 1 2 3 4 5 6 7 8; do
  p=$((20000 + RANDOM % 30000))
  if "$PG_BIN/pg_ctl" -D "$DATA/pg" -w -t 30 -l "$DATA/pg.log" \
       -o "-p $p -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=120 -c fsync=off -c synchronous_commit=off" \
       start >/dev/null 2>&1; then
    PORT=$p; break
  fi
done
[ -n "$PORT" ] || { echo "Postgres 를 띄우지 못했어요"; cat "$DATA/pg.log"; exit 2; }
echo "포트: $PORT"

PSQL="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres -d postgres"
sql()  { $PSQL -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }                          # postgres(소유자)로
anon() { $PSQL -At -v ON_ERROR_STOP=1 -c "set role anon" -c "$1" 2>&1; }       # 참가자 화면·진행자 화면(anon)으로
run_file() { $PSQL -v ON_ERROR_STOP=1 -f "$1" >"$2" 2>&1; }
# 한 세션에서 setseed 뒤 문장들을 돌리고 되돌린다(rollback). 빈 줄(setseed 결과)은 뺀다
seeded() {  # $1 = 난수 씨앗, $2... = 문장들(마지막 문장의 결과가 비교값)
  local s=$1; shift
  local args=(-c "begin" -c "select setseed($s)")
  for q in "$@"; do args+=(-c "$q"); done
  args+=(-c "rollback")
  $PSQL -At -v ON_ERROR_STOP=1 "${args[@]}" 2>&1 | grep -v '^$' | tail -1
}
# admin_shuffle 을 anon 으로 부르고 '비운 수/정한 수/건너뛴 사람(이름:이유,…)' 으로
SHUF() {  # $1 = what, $2 = mode, $3 = 비밀번호(없으면 시험용)
  anon "select format('%s/%s/%s', j->>'cleared', j->>'assigned', coalesce((select string_agg((e->>'name') || ':' || (e->>'reason'), ',' order by e->>'name') from json_array_elements(j->'skipped') e), '')) from (select admin_shuffle('${3:-$CODE}', '$1', '$2') j) s"
}

# ── 설치 ─────────────────────────────────────────────────
title "설치"
run_file "$HERE/car_db_supabase_stub.sql" "$OUT/stub.log" && ok "Supabase 흉내(anon·authenticated, 기본 권한)" || { ng "Supabase 흉내" "$(cat "$OUT/stub.log")"; exit 1; }
sed "s/values ('admin_code', '여기를-바꾸세요')/values ('admin_code', '$CODE')/" "$SQL_FILE" >"$OUT/run1.sql"
if run_file "$OUT/run1.sql" "$OUT/run1.log"; then ok "supabase.sql 첫 번째 Run 오류 없음"; else ng "supabase.sql 첫 번째 Run" "$(tail -5 "$OUT/run1.log")"; exit 1; fi
run_file "$HERE/car_db_helpers.sql" "$OUT/helpers.log" || { ng "시험 보조 함수(차량)" "$(cat "$OUT/helpers.log")"; exit 1; }
run_file "$HERE/admin_shuffle_db_helpers.sql" "$OUT/helpers2.log" || { ng "시험 보조 함수(자동 섞기)" "$(cat "$OUT/helpers2.log")"; exit 1; }
sql "select t.seed29(true)" >/dev/null
sql "select admin_shuffle('$CODE', 'team', 'all'), admin_shuffle('$CODE', 'room', 'all'), admin_shuffle('$CODE', 'car', 'all')" >/dev/null
before=$(sql "select t.state()")
if run_file "$SQL_FILE" "$OUT/run2.log"; then ok "supabase.sql 두 번째 Run(원본 그대로) 오류 없음"; else ng "supabase.sql 두 번째 Run" "$(tail -5 "$OUT/run2.log")"; exit 1; fi
eq "두 번째 Run 뒤 팀·방·차량 그대로" "$before" "$(sql "select t.state()")"
eq "두 번째 Run 뒤 관리자 비밀번호 유지" "" "$(sql "select check_admin('$CODE')")"
eq "admin_shuffle 은 security definer + search_path=public (다른 admin_* 와 같음)" "true|{search_path=public}" "$(sql "select prosecdef || '|' || proconfig::text from pg_proc where proname = 'admin_shuffle'")"
eq "admin_shuffle 이 하나뿐(인자 text,text,text)" "p_code text, p_what text, p_mode text" "$(sql "select string_agg(pg_get_function_arguments(oid), ' / ') from pg_proc where proname = 'admin_shuffle'")"
eq "admin_shuffle 돌려주는 형식 json" "json" "$(sql "select prorettype::regtype from pg_proc where proname = 'admin_shuffle'")"

# 마감 시각을 시험 안에서 바꿀 수 있게(처음엔 마감 전). 끝에 supabase.sql 의 정의로 되돌림
sql "create table if not exists t.deadline (d timestamptz); delete from t.deadline; insert into t.deadline values (now() + interval '1 day')" >/dev/null
sql "create or replace function public.choices_closed() returns boolean language sql stable as \$\$ select now() >= (select d from t.deadline limit 1) \$\$" >/dev/null
closed_on()  { sql "update t.deadline set d = now() - interval '1 hour'" >/dev/null; }   # 마감 지남
closed_off() { sql "update t.deadline set d = now() + interval '1 day'" >/dev/null; }    # 마감 전

# ── 권한·입력 검사 ───────────────────────────────────────
title "권한·입력 검사"
sql "select t.seed29(true)" >/dev/null
st0=$(sql "select t.state()"); lg0=$(sql "select count(*) from people_log")
has "틀린 비밀번호 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(SHUF team all wrong-password)"
has "비밀번호 null 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select admin_shuffle(null, 'room', 'fill')")"
has "빈 비밀번호('') 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select admin_shuffle('', 'room', 'fill')")"
has "없는 항목 거절" "ERROR:  바꿀 수 없는 항목이에요." "$(SHUF menu fill)"
has "없는 방식 거절" "ERROR:  보낸 내용이 올바르지 않아요. 새로고침한 뒤 다시 해 주세요." "$(SHUF team everything)"
has "방식 null 거절" "ERROR:  보낸 내용이 올바르지 않아요." "$(anon "select admin_shuffle('$CODE', 'team', null)")"
eq "거절된 뒤 아무것도 안 바뀜(팀·방·차량·기록)" "$st0|$lg0" "$(sql "select t.state()")|$(sql "select count(*) from people_log")"
has "PUBLIC 으로만 권한을 받는 역할은 못 부름" "permission denied for function admin_shuffle" "$($PSQL -At -c "set role nobody_test" -c "select admin_shuffle('$CODE', 'team', 'fill')" 2>&1)"
has "car_draw(안쪽 함수)는 참가자(anon)가 직접 못 부름" "permission denied for function car_draw" "$(anon "select car_draw()")"
has "car_draw 는 authenticated 도 못 부름" "permission denied for function car_draw" "$($PSQL -At -c "set role authenticated" -c "select car_draw()" 2>&1)"
eq "authenticated 도 admin_shuffle 을 부를 수 있음(다른 admin_* 와 같음)" "30" "$($PSQL -At -c "set role authenticated" -c "select (admin_shuffle('$CODE', 'team', 'fill')->>'assigned')" 2>&1 | grep -v '^$')"
sql "select t.seed29(true)" >/dev/null

title "중간에 실패하면 아무것도 안 바뀜(한 번의 호출 = 한 트랜잭션)"
# 15번째쯤 정해지는 사람에서 일부러 오류를 내는 시험용 트리거(이 절 끝에서 지움)
sql "create or replace function t.boom() returns trigger language plpgsql as \$\$ begin
       if new.name = 'M15' and (new.team is distinct from old.team or new.room is distinct from old.room or new.car is distinct from old.car)
          and (new.team is not null or new.room is not null or new.car is not null) then raise exception '시험용 오류'; end if;
       return new; end \$\$;
     create trigger t_boom before update on public.people for each row execute function t.boom()" >/dev/null
sql "select pick(dept, name) from people where name in ('M01', 'F02')" >/dev/null
sql "update people set room = 'm1' where name = 'M02'; update people set car = 'car1', car_at = now() where name = 'M03'" >/dev/null
sql "truncate people_log" >/dev/null
st0=$(sql "select t.state()"); sig0=$(sql "select t.rowsig(array[]::text[])")
for spec in "team fill" "team all" "room fill" "room all" "car fill" "car all"; do
  set -- $spec
  has "$1 $2: 중간 오류가 그대로 돌아옴" "ERROR:  시험용 오류" "$(SHUF $1 $2)"
done
eq "여섯 번 실패한 뒤 명단 전체(모든 칸)가 그대로, 기록도 0줄" "$sig0|0" "$(sql "select t.rowsig(array[]::text[])")|$(sql "select count(*) from people_log")"
sql "drop trigger t_boom on public.people" >/dev/null
sql "select t.raw_cars('[깨진 목록')" >/dev/null
has "차량 목록이 깨져 있으면 '전부 새로'도 비우기 전 상태로 거절" "차량 목록이 잘못 저장돼 있어요" "$(SHUF car all)"
eq "그 뒤 차량 그대로(M03 은 1호차)" "car1" "$(sql "select car from people where name = 'M03'")"
sql "select t.seed29(true)" >/dev/null

# ── pick_car 를 고친 것(car_draw 로 뽑아냄)이 예전과 똑같은지 ──
title "pick_car: 고치기 전 판($OLD_REV)과 같은 난수에서 결과가 한 글자도 같음"
if git -C "$ROOT" cat-file -e "$OLD_REV:supabase.sql" 2>/dev/null; then
  git -C "$ROOT" show "$OLD_REV:supabase.sql" | awk '/^create or replace function public.pick_car\(/,/^end \$\$;/' \
    | sed 's/^create or replace function public.pick_car(/create or replace function t.pick_car_old(/' >"$OUT/pick_car_old.sql"
  if grep -q 'frees' "$OUT/pick_car_old.sql" && run_file "$OUT/pick_car_old.sql" "$OUT/pick_car_old.log"; then
    ok "예전 pick_car 를 t.pick_car_old 로 설치"
    same=0; total=0; full_seen=
    for scen in auto_driver fixed_full three; do
      sql "select t.seed29(false)" >/dev/null
      case $scen in
        auto_driver) D=$(sql "select id from people where name = 'M20'"); sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$D},{\"id\":\"car2\",\"name\":\"2호차\"}]')" >/dev/null ;;
        fixed_full)  sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":9},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":7}]')" >/dev/null ;;
        three)       sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\"},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":5},{\"id\":\"van\",\"name\":\"승합차\"}]')" >/dev/null ;;
      esac
      for s in 0.11 0.27 -0.5 0.73 0.9; do
        a=$(seeded "$s" "select t.pick_all_with('public.pick_car')")
        b=$(seeded "$s" "select t.pick_all_with('t.pick_car_old')")
        total=$((total + 1))
        [ "$scen" = fixed_full ] && full_seen="$full_seen$a"
        if [ "$a" = "$b" ] && [ -n "$a" ] && [[ "$a" != *ERROR* ]]; then same=$((same + 1)); else echo "        다름($scen, $s): 지금 [$a] / 예전 [$b]"; fi
      done
    done
    eq "세 가지 차량 목록 × 씨앗 5개 = 15판 모두 같음(빈자리 없음 오류 포함)" "15/15" "$same/$total"
    has "비교가 실제로 빈자리 없음까지 닿음(정원 9·7 에 29명)" ":-" "$full_seen"
  else
    ng "예전 pick_car 설치" "$(cat "$OUT/pick_car_old.log" 2>/dev/null)"
  fi
else
  echo "  (건너뜀: git 에 $OLD_REV 판이 없음 — OLD_REV=판 으로 정해 주세요)"
fi

# ── 자동 섞기 = 참가자 함수를 무작위 순서로 부른 것과 같은 난수에서 결과가 같음 ──
# t.ref_shuffle: 자동 섞기 없이 기존 함수만으로(admin_reset·admin_clear·admin_clear_cars 로 비우고, 무작위 순서로 pick·pick_room·pick_car)
title "규칙 일치: admin_shuffle 결과 = 기존 함수(pick·pick_room·pick_car)를 같은 무작위 순서로 부른 결과 (같은 setseed)"
cmp_seeded() {  # $1 = 설명, $2 = what, $3 = mode, $4 = 시작 상태를 만드는 SQL
  local same=0 n=0 a b
  for s in 0.05 0.31 -0.42 0.66 0.97 0.5; do
    sql "$4" >/dev/null
    a=$(seeded "$s" "select admin_shuffle('$CODE', '$2', '$3')" "select t.state()")
    b=$(seeded "$s" "select t.ref_shuffle('$CODE', '$2', '$3')" "select t.state()")
    n=$((n + 1))
    if [ "$a" = "$b" ] && [ -n "$a" ] && [[ "$a" != *ERROR* ]]; then same=$((same + 1)); else echo "        다름(씨앗 $s): [$a] / [$b]"; fi
  done
  eq "$1: 씨앗 6개 모두 같음" "$n/$n" "$same/$n"
}
PRE_TEAM="select t.seed29(true); select pick(dept, name) from people where name in ('M01','M05','F02','M11','F07','M16','X01','M20')"
cmp_seeded "팀 · 안 뽑은 사람만(8명 먼저 뽑음)" team fill "$PRE_TEAM"
cmp_seeded "팀 · 전부 새로" team all "$PRE_TEAM"
PRE_ROOM_B2="select t.seed29(true); update people p set room = e.value from jsonb_each_text('{\"M01\":\"m1\",\"M02\":\"m1\",\"M06\":\"m2\",\"M10\":\"m3\",\"F01\":\"f1\",\"F04\":\"f1\",\"F06\":\"f1\"}') e where p.name = e.key"
PRE_ROOM_C="select t.seed29(true); update people p set room = e.value from jsonb_each_text('{\"M01\":\"m1\",\"M02\":\"m1\",\"M03\":\"m1\",\"M04\":\"m1\",\"M05\":\"m1\",\"M06\":\"m1\",\"F01\":\"f1\",\"F02\":\"f1\",\"F03\":\"f1\",\"F04\":\"f1\",\"F05\":\"f1\",\"X01\":\"m2\",\"M20\":\"f2\"}') e where p.name = e.key"
cmp_seeded "방 · 안 뽑은 사람만(B2: 7명 먼저 넣음, 성별 없는 1명)" room fill "$PRE_ROOM_B2"
cmp_seeded "방 · 안 뽑은 사람만(C: 한 방에 몰아 넣음, 남자 1명이 여자 방)" room fill "$PRE_ROOM_C"
cmp_seeded "방 · 전부 새로(C 에서)" room all "$PRE_ROOM_C"
PRE_CAR="select t.seed29(true); select admin_set_cars('$CODE', ('[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":' || (select id from people where name = 'M20') || '},{\"id\":\"car2\",\"name\":\"2호차\"}]')::jsonb); select admin_set_car('$CODE', id, 'car1') from people where name in ('M01','F01','M07')"
PRE_CAR_FULL="select t.seed29(false); select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":9},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":8}]'); select admin_set_car('$CODE', id, 'car2') from people where name in ('M01','F01')"
cmp_seeded "탑승 차량 · 안 뽑은 사람만(운전자 1명, 3명 먼저 탐)" car fill "$PRE_CAR"
cmp_seeded "탑승 차량 · 전부 새로(운전자 1명)" car all "$PRE_CAR"
cmp_seeded "탑승 차량 · 안 뽑은 사람만(정원 9·8 이라 자리가 모자람)" car fill "$PRE_CAR_FULL"

# ── 팀 규칙 ───────────────────────────────────────────────
title "팀: 규칙(인원·임원·부서·성별을 고르게) · 이미 뽑은 사람 그대로 · 다른 칸 그대로"
sql "select t.seed29(true)" >/dev/null
for n in M01 M05 F02 M11 F07 M16 X01 M20; do anon "select pick('$(sql "select dept from people where name = '$n'")', '$n')" >/dev/null; done
pre=$(sql "select string_agg(name || ':' || team, ',' order by name) from people where team is not null")
other=$(sql "select t.rowsig(array['team','picked_at'])")
eq "안 뽑은 사람만: 비운 0 / 정한 22 / 건너뜀 없음" "0/22/" "$(SHUF team fill)"
eq "먼저 뽑은 8명의 팀 그대로" "$pre" "$(sql "select string_agg(name || ':' || team, ',' order by name) from people where name in ('M01','M05','F02','M11','F07','M16','X01','M20')")"
eq "팀 인원 고르게, 팀 없는 사람 없음(성별 없는 사람도 팀은 뽑음)" "size:0/none:0" "$(sql "select t.team_check()" | cut -d, -f1)/$(sql "select t.team_check()" | cut -d, -f5)"
eq "다른 칸(부서·이름·방·메뉴·점심·자유시간·차량 등) 그대로" "$other" "$(sql "select t.rowsig(array['team','picked_at'])")"
lg=$(sql "select count(*) from people_log"); st=$(sql "select t.state()")
eq "한 번 더(안 뽑은 사람 없음): 0/0/" "0/0/" "$(SHUF team fill)"
eq "한 번 더 해도 팀·기록 그대로" "$st|$lg" "$(sql "select t.state()")|$(sql "select count(*) from people_log")"
eq "전부 새로: 비운 30 / 정한 30" "30/30/" "$(SHUF team all)"
eq "전부 새로 뒤 팀 인원·팀 없는 사람" "size:0/none:0" "$(sql "select t.team_check()" | cut -d, -f1)/$(sql "select t.team_check()" | cut -d, -f5)"
eq "전부 새로 뒤 다른 칸 그대로" "$other" "$(sql "select t.rowsig(array['team','picked_at'])")"
eq "전부 새로 두 번 연속도 됨" "30/30/" "$(SHUF team all)"
# 부서·이름이 정리되지 않은 줄(SQL Editor 로 넣은 경우): 다른 사람을 찾지 않게 건너뜀
sql "insert into people (dept, name, gender) values ('D9  가', 'Y01', '남')" >/dev/null
has "정리 안 된 부서(공백 두 칸)는 '팀'에서 건너뛰고 알려 줌" "/0/Y01:name" "$(SHUF team fill)"
eq "그 사람은 팀 없음" "" "$(sql "select team from people where name = 'Y01'")"
has "방에서도 같은 이유로 건너뜀" "Y01:name" "$(SHUF room fill)"
sql "delete from people where name = 'Y01'" >/dev/null

RUNS_TEAM=60; [ "$QUICK" = 1 ] && RUNS_TEAM=20
# 기준: 기존 팀 뽑기(pick)의 성질. 인원은 벌점 10000 이라 늘 맞고, 임원·성별·부서는 계획 다듬기(2000번)가 가끔 못 맞춘다.
#   이 견본 명단에서 기존 방식(참가자 pick 을 무작위 순서로)과 자동 섞기를 300번씩 돌려 본 값: 모두 완벽 280 대 278,
#   성별 1칸 어긋남 3 대 4 — 같은 분포(같은 난수면 결과가 한 글자도 같다는 것은 위 '규칙 일치'에서 확인).
title "팀: 전부 새로를 ${RUNS_TEAM}번(29명+성별 없는 1명) — 기존 팀 뽑기의 성질(인원 늘, 임원·성별 거의 늘, 부서 대부분)"
sql "select t.seed29(true)" >/dev/null
t0=$(python3 -c 'import time; print(time.time())')
$PSQL -c "call t.team_runs('$CODE', $RUNS_TEAM)" >"$OUT/team_runs.log" 2>&1 || ng "팀 반복" "$(cat "$OUT/team_runs.log")"
t1=$(python3 -c 'import time; print(time.time())')
sum=$(sql "select t.team_summary()")
echo "  (인원 완벽 / 인원·임원·성별 완벽 / 부서까지 완벽 / 판 수 = $sum, 한 번에 평균 $(python3 -c "print(round(($t1-$t0)*1000/$RUNS_TEAM))")ms)"
eq "팀 인원은 모든 판에서 고르게(팀 없는 사람 없음)" "$RUNS_TEAM" "$(echo "$sum" | cut -d/ -f1)"
ieg=$(echo "$sum" | cut -d/ -f2); all_ok=$(echo "$sum" | cut -d/ -f3)
if [ "$ieg" -ge $((RUNS_TEAM * 90 / 100)) ]; then ok "인원·임원·성별까지 고른 판이 90% 이상($ieg/$RUNS_TEAM)"; else ng "인원·임원·성별까지 고른 판이 90% 이상" "$ieg/$RUNS_TEAM"; fi
if [ "$all_ok" -ge $((RUNS_TEAM * 80 / 100)) ]; then ok "부서까지 모두 고른 판이 80% 이상($all_ok/$RUNS_TEAM — 기존 방식 300번에 93%)"; else ng "부서까지 모두 고른 판이 80% 이상" "$all_ok/$RUNS_TEAM"; fi
sql "select t.seed(64)" >/dev/null
t0=$(python3 -c 'import time; print(time.time())'); r=$(SHUF team all); t1=$(python3 -c 'import time; print(time.time())')
eq "64명 전부 새로도 됨" "0/64/" "$r"
echo "  (64명 팀 전부 새로 한 번: $(python3 -c "print(round(($t1-$t0)*1000))")ms — anon 제한 시간 8초)"

# ── 방 규칙 ───────────────────────────────────────────────
title "방: 남녀 따로 · 인원 고르게 · 성별 없는 사람 건너뜀 · 먼저 넣은 사람 그대로 · 다른 칸 그대로"
sql "$PRE_ROOM_C" >/dev/null
other=$(sql "select t.rowsig(array['room'])")
pre=$(sql "select string_agg(name || ':' || room, ',' order by name) from people where room is not null")
eq "안 뽑은 사람만(C): 비운 0 / 정한 17(성별 있고 방 없는 사람) / 성별 없는 사람 없음(X01 은 이미 방이 있음)" "0/17/" "$(SHUF room fill)"
eq "먼저 넣은 13명 그대로(남자 방에 넣은 성별 없는 X01·여자 방의 M20 포함)" "$pre" "$(sql "select string_agg(name || ':' || room, ',' order by name) from people where name in ('M01','M02','M03','M04','M05','M06','F01','F02','F03','F04','F05','X01','M20')")"
eq "가장 고른 모양: 남 m1 6명 + 나머지 4·3·3·3(M20 은 여자 방에 그대로라 남 19명), 여 5·4, 섞임은 원래 있던 M20 하나" "mixed:1,m:3,3,3,4,6,f:4,5,nogender_room:1,sexed_none:0" "$(sql "select t.room_check()")"
eq "다른 칸 그대로" "$other" "$(sql "select t.rowsig(array['room'])")"
st=$(sql "select t.state()"); lg=$(sql "select count(*) from people_log")
eq "한 번 더: 0/0/" "0/0/" "$(SHUF room fill)"
eq "한 번 더 해도 방·기록 그대로" "$st|$lg" "$(sql "select t.state()")|$(sql "select count(*) from people_log")"
eq "전부 새로: 비운 30 / 정한 29 / 성별 없는 X01 건너뜀" "30/29/X01:no_gender" "$(SHUF room all)"
eq "전부 새로 뒤: 섞임 0, 남 4·4·4·4·4, 여 4·5, 성별 없는데 방 있는 사람 0" "mixed:0,m:4,4,4,4,4,f:4,5,nogender_room:0,sexed_none:0" "$(sql "select t.room_check()")"
eq "전부 새로 뒤 다른 칸 그대로" "$other" "$(sql "select t.rowsig(array['room'])")"
eq "전부 새로 두 번 연속도 됨(성별 없는 사람은 계속 알려 줌)" "29/29/X01:no_gender" "$(SHUF room all)"
eq "안 뽑은 사람만을 이어서: 성별 없는 사람만 남아 0명, 건너뜀 X01" "0/0/X01:no_gender" "$(SHUF room fill)"
has "건너뛴 사람에 id·부서·이름·이유가 다 있음" "\"dept\": \"D3\", \"name\": \"X01\", \"reason\": \"no_gender\"" "$(anon "select admin_shuffle('$CODE', 'room', 'fill')->'skipped'->0")"
eq "건너뛴 사람 id 가 명단 id" "$(sql "select id from people where name = 'X01'")" "$(anon "select admin_shuffle('$CODE', 'room', 'fill')->'skipped'->0->>'id'")"

RUNS_ROOM=1500; [ "$QUICK" = 1 ] && RUNS_ROOM=300
title "방: 완전 무작위 기준과 비교(tests/room-random/stats.mjs 잣대, 시작 상황마다 ${RUNS_ROOM}번)"
sql "select t.seed29(false); truncate t.room_res" >/dev/null
B='{"M01":"m1","M02":"m1","M06":"m2","M10":"m3","F01":"f1","F04":"f1","F06":"f1","M20":"f2"}'
B2='{"M01":"m1","M02":"m1","M06":"m2","M10":"m3","F01":"f1","F04":"f1","F06":"f1"}'
C='{"M01":"m1","M02":"m1","M03":"m1","M04":"m1","M05":"m1","M06":"m1","F01":"f1","F02":"f1","F03":"f1","F04":"f1","F05":"f1"}'
t0=$(python3 -c 'import time; print(time.time())')
for spec in "A:all|all|$C" "A:fill|fill|" "B:fill|fill|$B" "B2:fill|fill|$B2" "C:fill|fill|$C"; do
  IFS='|' read -r scn mode pre <<<"$spec"
  if [ -n "$pre" ]; then prearg="'$pre'"; else prearg="null"; fi
  $PSQL -c "call t.room_runs('$CODE', '$scn', '$mode', $RUNS_ROOM, $prearg)" >"$OUT/room_runs.log" 2>&1 || ng "방 반복 $scn" "$(cat "$OUT/room_runs.log")"
done
t1=$(python3 -c 'import time; print(time.time())')
echo "  (방 섞기 한 번에 평균 $(python3 -c "print(round(($t1-$t0)*1000/($RUNS_ROOM*5), 1))")ms)"
sql "copy (select scn, run, name, coalesce(room, '') from t.room_res order by scn, run, name) to stdout with csv" >"$OUT/room.csv"
if node "$HERE/admin_shuffle_room_stats.mjs" "$OUT/room.csv" >"$OUT/room_stats.log" 2>&1; then
  ok "다섯 시작 상황(전부 새로·빈 상태·B·B2·C) 모두 섞임 0, 가장 고른 인원, 사람×방·같은 방 쌍·같은 부서 쌍 분포가 기준과 같음"
else
  ng "방 통계" "$(cat "$OUT/room_stats.log")"
fi
sed 's/^/        /' "$OUT/room_stats.log" | cut -c1-260

# ── 차량 규칙 ─────────────────────────────────────────────
title "탑승 차량: 운전자 빼고 · 반씩 · 정원 · 먼저 탄 사람 그대로 · 다른 칸 그대로"
sql "$PRE_CAR" >/dev/null
other=$(sql "select t.rowsig(array['car','car_at'])")
pre=$(sql "select string_agg(name || ':' || car || ':' || car_at, ',' order by name) from people where car is not null")
eq "안 뽑은 사람만: 비운 0 / 정한 26 / 운전자 M20 건너뜀" "0/26/M20:driver" "$(SHUF car fill)"
eq "먼저 탄 3명 차량·시각 그대로" "$pre" "$(sql "select string_agg(name || ':' || car || ':' || car_at, ',' order by name) from people where name in ('M01','F01','M07')")"
c=$(sql "select t.counts()")
case "$c" in "car1:15,car2:14,none:1"|"car1:14,car2:15,none:1") ok "운전자 빼고 29명 → 15·14(정원 자동 15·15): $c" ;; *) ng "운전자 빼고 29명 → 15·14" "$c" ;; esac
eq "정원 넘은 차량 0, 운전자는 차량 칸 비어 있음" "0/" "$(sql "select t.overfull()")/$(sql "select car from people where name = 'M20'")"
eq "다른 칸 그대로" "$other" "$(sql "select t.rowsig(array['car','car_at'])")"
st=$(sql "select t.state()"); lg=$(sql "select count(*) from people_log")
eq "한 번 더: 0/0/운전자만 알려 줌" "0/0/M20:driver" "$(SHUF car fill)"
eq "한 번 더 해도 차량·기록 그대로" "$st|$lg" "$(sql "select t.state()")|$(sql "select count(*) from people_log")"
eq "전부 새로: 비운 29 / 정한 29" "29/29/M20:driver" "$(SHUF car all)"
c=$(sql "select t.counts()")
case "$c" in "car1:15,car2:14,none:1"|"car1:14,car2:15,none:1") ok "전부 새로 뒤 반씩(15·14), 정원 넘은 차량 $(sql "select t.overfull()")대" ;; *) ng "전부 새로 뒤 반씩" "$c" ;; esac
eq "전부 새로 뒤 다른 칸 그대로" "$other" "$(sql "select t.rowsig(array['car','car_at'])")"
eq "차량 목록(운전자 지정)은 그대로" "$(sql "select id from people where name = 'M20'")" "$(sql "select value::jsonb->0->>'driver' from config where key = 'cars'")"
sql "$PRE_CAR_FULL" >/dev/null
r=$(SHUF car fill)
eq "정원 9·8(17자리)에 29명, 2명 먼저 탐: 정한 15, 나머지 12명은 'full'" "0/15/12" "$(echo "$r" | cut -d/ -f1-2)/$(echo "$r" | cut -d/ -f3 | tr ',' '\n' | grep -c ':full$')"
eq "자리가 모자라도 정원은 안 넘음" "car1:9,car2:8,none:12/0" "$(sql "select t.counts()")/$(sql "select t.overfull()")"

RUNS_CAR=400; [ "$QUICK" = 1 ] && RUNS_CAR=100
title "탑승 차량: 전부 새로를 ${RUNS_CAR}번 — 판마다 15·14, 사람마다 1호차 확률 1/2, 운전자는 늘 빠짐"
sql "$PRE_CAR" >/dev/null
$PSQL -c "call t.car_runs('$CODE', $RUNS_CAR)" >"$OUT/car_runs.log" 2>&1 || ng "차량 반복" "$(cat "$OUT/car_runs.log")"
eq "모든 판에서 두 차량 15·14 또는 14·15" "$RUNS_CAR" "$(sql "select count(*) from (select run from t.car_res group by run having count(*) filter (where car = 'car1') in (14, 15) and count(*) filter (where car = 'car2') in (14, 15)) s")"
eq "운전자가 차량에 들어간 판 0" "0" "$(sql "select count(*) from t.car_res r join people p on p.id = r.id where p.name = 'M20' and r.car is not null")"
# 사람마다 1호차 횟수 ~ 이항(runs, 1/2) 근처. 카이제곱(자유도 = 손님 수)으로 한꺼번에 봄
x2=$(sql "select round(sum(((k - n / 2.0) ^ 2) / (n / 4.0))::numeric, 1) || ' ' || count(*) from (select r.id, count(*) filter (where r.car = 'car1') as k, count(*) as n from t.car_res r join people p on p.id = r.id where p.name <> 'M20' group by r.id) s")
pv=$(python3 -c "
import math,sys
x,df=map(float,'$x2'.split())
# 윌슨-힐퍼티 근사로 상측 확률
z=((x/df)**(1/3)-(1-2/(9*df)))/math.sqrt(2/(9*df))
print(round(0.5*math.erfc(z/math.sqrt(2)),4))")
echo "  (사람마다 1호차 횟수 카이제곱 $x2(값 자유도) → p=$pv)"
if python3 -c "import sys; sys.exit(0 if $pv > 0.001 else 1)"; then ok "사람마다 1호차 확률이 1/2 과 다르지 않음(p > 0.001)"; else ng "사람마다 1호차 확률 1/2" "p=$pv"; fi

# ── 아침 메뉴 한 번에 비우기 ───────────────────────────────
title "아침 메뉴 한 번에 비우기: admin_clear('menu') 는 메뉴만 비움, 기존 종류는 그대로"
sql "select t.seed29(true)" >/dev/null
sql "select admin_shuffle('$CODE', 'team', 'all'), admin_shuffle('$CODE', 'room', 'all'), admin_shuffle('$CODE', 'car', 'all')" >/dev/null
other=$(sql "select t.rowsig(array['menu'])")
sql "truncate people_log" >/dev/null
eq "처음엔 30명 모두 메뉴 있음" "30" "$(sql "select count(*) from people where menu is not null")"
has "틀린 비밀번호 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select admin_clear('wrong', 'menu')")"
eq "거절 뒤 메뉴 그대로" "30" "$(sql "select count(*) from people where menu is not null")"
eq "admin_clear('menu') 오류 없음" "" "$(anon "select admin_clear('$CODE', 'menu')")"
eq "메뉴 모두 비워짐" "0" "$(sql "select count(*) from people where menu is not null")"
eq "팀·방·점심·자유시간·차량 등 다른 칸 그대로" "$other" "$(sql "select t.rowsig(array['menu'])")"
eq "기록(people_log)은 메뉴가 있던 30명만" "30" "$(sql "select count(*) from people_log where op = 'UPDATE'")"
lg=$(sql "select count(*) from people_log")
anon "select admin_clear('$CODE', 'menu')" >/dev/null
eq "이미 비었으면 다시 불러도 아무 줄도 안 고침" "$lg" "$(sql "select count(*) from people_log")"
has "없는 종류는 여전히 거절" "ERROR:  바꿀 수 없는 항목이에요." "$(anon "select admin_clear('$CODE', 'team')")"
has "null 종류도 거절" "ERROR:  바꿀 수 없는 항목이에요." "$(anon "select admin_clear('$CODE', null)")"
other=$(sql "select t.rowsig(array['lunch'])"); anon "select admin_clear('$CODE', 'lunch')" >/dev/null
eq "기존 'lunch' 는 점심만 비움" "0|$other" "$(sql "select count(*) from people where lunch is not null")|$(sql "select t.rowsig(array['lunch'])")"
other=$(sql "select t.rowsig(array['activity'])"); anon "select admin_clear('$CODE', 'activity')" >/dev/null
eq "기존 'activity' 는 자유시간만 비움" "0|$other" "$(sql "select count(*) from people where activity is not null")|$(sql "select t.rowsig(array['activity'])")"
other=$(sql "select t.rowsig(array['room'])"); anon "select admin_clear('$CODE', 'room')" >/dev/null
eq "기존 'room' 은 방만 비움" "0|$other" "$(sql "select count(*) from people where room is not null")|$(sql "select t.rowsig(array['room'])")"

# ── 마감 뒤 ───────────────────────────────────────────────
title "마감(11/25 15시) 뒤: 참가자 차량 뽑기는 거절, 진행자 자동 섞기·메뉴 비우기는 됨"
sql "$PRE_CAR" >/dev/null
closed_on
eq "마감 뒤: choices_closed() = t" "t" "$(sql "select choices_closed()")"
has "참가자 pick_car 는 마감 거절" "탑승 차량 뽑기는 11월 25일(수) 15시에 마감됐어요" "$(anon "select pick_car('D1', 'M02')")"
has "참가자 choose_menu 도 마감 거절" "까지만 고르고 바꿀 수 있어요" "$(anon "select choose_menu('D1', 'M02', 'miyeok')")"
eq "진행자 차량 안 뽑은 사람만: 정한 26" "0/26/M20:driver" "$(SHUF car fill)"
eq "진행자 차량 전부 새로" "29/29/M20:driver" "$(SHUF car all)"
eq "마감 뒤에도 정원 안 넘음" "0" "$(sql "select t.overfull()")"
eq "진행자 팀 전부 새로" "0/30/" "$(SHUF team all)"
eq "진행자 방 전부 새로" "0/29/X01:no_gender" "$(SHUF room all)"
eq "진행자 아침 메뉴 비우기(오류 없음)" "" "$(anon "select admin_clear('$CODE', 'menu')")"
eq "마감 뒤에도 메뉴가 비워짐" "0" "$(sql "select count(*) from people where menu is not null")"
closed_off
eq "마감 전으로 되돌림" "f" "$(sql "select choices_closed()")"

# ── 동시에 부를 때 ─────────────────────────────────────────
# 출발선: postgres 세션 하나가 t.gate 를 잠근 채, n 개 세션이 모두 그 표를 기다릴 때까지 기다렸다가 푼다 → 한꺼번에 출발(car_db_test.sh 와 같은 방식)
gate_hold() {  # $1 = 기다릴 세션 수
  $PSQL -At -c "begin" -c "lock table t.gate in access exclusive mode" \
    -c "do \$\$ declare s timestamptz := clock_timestamp(); begin
          loop
            exit when (select count(*) from pg_locks where relation = 't.gate'::regclass and not granted) >= $1;
            if clock_timestamp() - s > interval '30 seconds' then raise exception '출발선에 다 모이지 않음'; end if;
            perform pg_sleep(0.01);
          end loop; end \$\$" -c "commit" >"$OUT/gate.log" 2>&1 &
  local i=0
  while [ "$(sql "select count(*) from pg_locks where relation = 't.gate'::regclass and granted and mode = 'AccessExclusiveLock'")" != "1" ]; do
    i=$((i + 1)); [ $i -gt 500 ] && { echo "출발선 잠금 실패"; cat "$OUT/gate.log"; return 1; }
  done
  return 0
}
worker() {  # $1 = 출력 이름, $2 = anon 으로 돌릴 식(결과는 'R 값')
  $PSQL -At -c "select count(*) from t.gate" -c "set role anon" -c "select 'R ' || ($2)::text" >"$OUT/$1.out" 2>"$OUT/$1.err"
}
# 겹침을 확실하게 만드는 순서 제어: postgres 세션 하나가 그 항목의 차례 잠금(pg_advisory_xact_lock(261112, k) — 1 팀·2 방·3 차량)을 쥐고 있는 동안
# ① 참가자 일부(앞 무리) → ② 섞기 둘 → ③ 나머지 참가자·진행자(뒷 무리) 순으로 잠금 대기줄에 세우고(줄에 선 수를 세어 확인), 잠금을 풀면 줄 순서대로 처리된다.
# → 앞 무리는 섞기보다 먼저, 뒷 무리는 섞기 뒤에 처리되는 것이 시간 운에 기대지 않고 정해진다.
lock_hold() {  # $1 = k
  $PSQL -At -c "begin" -c "select pg_advisory_xact_lock(261112, $1)" -c "select pg_sleep(120)" >"$OUT/hold.log" 2>&1 &
  local i=0
  while [ "$(sql "select count(*) from pg_locks where locktype = 'advisory' and classid = 261112 and objid = $1 and granted")" != "1" ]; do
    i=$((i + 1)); [ $i -gt 1000 ] && { echo "차례 잠금 잡기 실패"; cat "$OUT/hold.log"; return 1; }
  done
  return 0
}
lock_wait() {  # $1 = k, $2 = 줄에 서야 할 수
  local i=0
  while [ "$(sql "select count(*) from pg_locks where locktype = 'advisory' and classid = 261112 and objid = $1 and not granted")" -lt "$2" ]; do
    i=$((i + 1)); [ $i -gt 3000 ] && { echo "대기줄 $2 명이 안 모임"; return 1; }
    sleep 0.01
  done
  return 0
}
lock_release() {  # $1 = k
  sql "select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = 261112 and objid = $1 and granted" >/dev/null
}
# 섞기가 정한 수의 합이 기대와 같음 = 앞 무리가 먼저 정했고 나머지는 섞기가 정했다(겹침). $1 = 이름, $2 = 파일 앞부분, $3 = 기대 합
shuffled_sum() {
  local sum; sum=$(grep -h '^R ' "$OUT"/$2s*.out 2>/dev/null | cut -c3- | awk '{n += $1} END {print n + 0}')
  eq "$1" "$3" "$sum"
}
dn() { sql "select quote_literal(dept) || ', ' || quote_literal(name) from people where id = $1"; }       # id → 'dept', 'name'
dnn() { sql "select quote_literal(dept) || ', ' || quote_literal(name) from people where name = '$1'"; }  # 이름 → 'dept', 'name'
errs() { cat "$OUT"/$1*.err 2>/dev/null | grep 'ERROR' | head -3; }
# 참가자 응답(R 값) = DB 에 들어간 값(사람마다). $1 = 파일 앞부분, $2 = 칸
ret_vs_db() {
  for f in "$OUT"/$1p*.out; do
    [ -e "$f" ] || continue
    local id; id=$(basename "$f" .out); id=${id#$1p}
    local r; r=$(grep '^R ' "$f" | cut -c3-)
    [ -n "$r" ] && [ "$(sql "select $2 from people where id = $id")" != "$r" ] && echo "bad"
  done | grep -c bad
}

title "동시에: 차량 자동 섞기 2번 + 참가자 20명 pick_car + 진행자 넣기 2번 (3번 되풀이, 앞 무리 10명 → 섞기 → 뒷 무리 순서를 고정해 반드시 겹침)"
for round in 1 2 3; do
  sql "$PRE_CAR" >/dev/null
  rm -f "$OUT"/cc$round-*
  todo=$(sql "select count(*) from people where car is null and name <> 'M20'")   # 이 라운드에 차량 없는 손님 수
  lock_hold 3 || exit 1
  for id in $(sql "select id from people where car is null and name <> 'M20' order by id limit 10"); do
    worker "cc$round-p$id" "pick_car($(dn $id))" &
  done
  lock_wait 3 10 || exit 1
  worker "cc$round-s1" "admin_shuffle('$CODE', 'car', 'fill')->>'assigned'" &
  lock_wait 3 11 || exit 1
  worker "cc$round-s2" "admin_shuffle('$CODE', 'car', 'fill')->>'assigned'" &
  lock_wait 3 12 || exit 1
  for id in $(sql "select id from people where car is null and name <> 'M20' order by id limit 10 offset 10"); do
    worker "cc$round-p$id" "pick_car($(dn $id))" &
  done
  for id in $(sql "select id from people where car is null and name <> 'M20' order by id desc limit 2"); do
    worker "cc$round-a$id" "admin_set_car('$CODE', $id, 'car2')" &
  done
  lock_wait 3 22 || exit 1
  lock_release 3
  wait
  eq "[${round}회] 정원 넘은 차량 없음, 손님 29명 모두 탐(15·14)" "0/29" "$(sql "select t.overfull()")/$(sql "select count(*) from people where car is not null")"
  e=$(cat "$OUT"/cc$round-*.err | grep 'ERROR' | grep -v '그 차량은 자리가 다 찼어요' | head -3)
  eq "[${round}회] 다른 오류 없음(진행자 넣기는 '자리가 다 찼어요'만 가능)" "" "$e"
  eq "[${round}회] 참가자가 받은 차량 = DB 의 차량" "0" "$(ret_vs_db "cc$round-" car)"
  shuffled_sum "[${round}회] 겹침: 앞 무리 10명이 먼저 정했고 섞기는 나머지 $((todo - 10))명을 정함(뒷 무리는 섞기 뒤)" "cc$round-" "$((todo - 10))"
  echo "  (섞기가 정한 수: $(grep -h '^R ' "$OUT"/cc$round-s*.out | cut -c3- | tr '\n' ' '), 운전자 차량 칸: [$(sql "select car from people where name = 'M20'")])"
done

title "동시에: 방 자동 섞기 2번 + 참가자 29명 pick_room (3번 되풀이, 앞 무리 10명 → 섞기 → 뒷 무리 19명)"
for round in 1 2 3; do
  sql "select t.seed29(true)" >/dev/null
  rm -f "$OUT"/rc$round-*
  lock_hold 2 || exit 1
  for id in $(sql "select id from people where gender is not null order by id limit 10"); do
    worker "rc$round-p$id" "pick_room($(dn $id))" &
  done
  lock_wait 2 10 || exit 1
  worker "rc$round-s1" "admin_shuffle('$CODE', 'room', 'fill')->>'assigned'" &
  lock_wait 2 11 || exit 1
  worker "rc$round-s2" "admin_shuffle('$CODE', 'room', 'fill')->>'assigned'" &
  lock_wait 2 12 || exit 1
  for id in $(sql "select id from people where gender is not null order by id limit 19 offset 10"); do
    worker "rc$round-p$id" "pick_room($(dn $id))" &
  done
  lock_wait 2 31 || exit 1
  lock_release 2
  wait
  eq "[${round}회] 섞임 0, 남 4·4·4·4·4, 여 4·5, 모두 방 있음" "mixed:0,m:4,4,4,4,4,f:4,5,nogender_room:0,sexed_none:0" "$(sql "select t.room_check()")"
  eq "[${round}회] 오류 없음" "" "$(errs "rc$round-")"
  eq "[${round}회] 참가자가 받은 방 = DB 의 방" "0" "$(ret_vs_db "rc$round-" room)"
  shuffled_sum "[${round}회] 겹침: 앞 무리 10명이 먼저 정했고 섞기는 나머지 19명을 정함(뒷 무리는 섞기 뒤)" "rc$round-" 19
done

title "동시에: 팀 자동 섞기 2번 + 참가자 30명 pick (3번 되풀이, 앞 무리 10명 → 섞기 → 뒷 무리 20명)"
for round in 1 2 3; do
  sql "select t.seed29(true)" >/dev/null
  rm -f "$OUT"/tc$round-*
  lock_hold 1 || exit 1
  for id in $(sql "select id from people order by id limit 10"); do
    worker "tc$round-p$id" "pick($(dn $id))" &
  done
  lock_wait 1 10 || exit 1
  worker "tc$round-s1" "admin_shuffle('$CODE', 'team', 'fill')->>'assigned'" &
  lock_wait 1 11 || exit 1
  worker "tc$round-s2" "admin_shuffle('$CODE', 'team', 'fill')->>'assigned'" &
  lock_wait 1 12 || exit 1
  for id in $(sql "select id from people order by id limit 20 offset 10"); do
    worker "tc$round-p$id" "pick($(dn $id))" &
  done
  lock_wait 1 32 || exit 1
  lock_release 1
  wait
  eq "[${round}회] 팀 인원 고르게, 팀 없는 사람 없음" "size:0/none:0" "$(sql "select t.team_check()" | cut -d, -f1)/$(sql "select t.team_check()" | cut -d, -f5)"
  eq "[${round}회] 오류 없음" "" "$(errs "tc$round-")"
  eq "[${round}회] 참가자가 받은 팀 = DB 의 팀" "0" "$(ret_vs_db "tc$round-" team)"
  shuffled_sum "[${round}회] 겹침: 앞 무리 10명이 먼저 정했고 섞기는 나머지 20명을 정함(뒷 무리는 섞기 뒤)" "tc$round-" 20
  echo "  ($(sql "select t.team_check()"))"
done

title "동시에: 서로 다른 진행자 일(섞기 셋·초기화 넷) + 참가자 고르기·뽑기 — 교착(deadlock) 없음 (5번 되풀이)"
for round in 1 2 3 4 5; do
  sql "$PRE_CAR" >/dev/null
  rm -f "$OUT"/xc$round-*
  gate_hold 21 || exit 1
  worker "xc$round-s1" "admin_shuffle('$CODE', 'team', 'all')->>'assigned'" &
  worker "xc$round-s2" "admin_shuffle('$CODE', 'room', 'all')->>'assigned'" &
  worker "xc$round-s3" "admin_shuffle('$CODE', 'car', 'all')->>'assigned'" &
  worker "xc$round-s4" "admin_shuffle('$CODE', 'room', 'fill')->>'assigned'" &
  worker "xc$round-r1" "admin_reset('$CODE', null)" &
  worker "xc$round-r2" "admin_clear('$CODE', 'room')" &
  worker "xc$round-r3" "admin_clear('$CODE', 'menu')" &
  worker "xc$round-r4" "admin_clear_cars('$CODE')" &
  for n in M02 M03 F02 M08 F05; do worker "xc$round-m$n" "choose_menu($(dnn $n), 'hwangtae')" & done
  for n in M09 F03 M12; do worker "xc$round-t$n" "pick($(dnn $n))" & done
  for n in M13 F08 M14; do worker "xc$round-o$n" "pick_room($(dnn $n))" & done
  for n in M15 F09; do worker "xc$round-c$n" "pick_car($(dnn $n))" & done
  wait
  eq "[${round}회] 오류 없음(교착 40P01 없음)" "" "$(errs "xc$round-")"
  eq "[${round}회] 섞임 0, 정원 넘은 차량 0, 운전자 차량 칸 빔" "0/0/" "$(sql "select count(*) from people where (gender = '남' and room like 'f%') or (gender = '여' and room like 'm%')")/$(sql "select t.overfull()")/$(sql "select car from people where name = 'M20'")"
done

title "동시에: 차량 전부 새로 중에 참가자 29명이 아침 메뉴를 고름 — 고른 메뉴가 사라지지 않음"
sql "$PRE_CAR" >/dev/null
sql "update people set menu = null" >/dev/null
rm -f "$OUT"/mc-*
gate_hold 31 || exit 1
worker "mc-s1" "admin_shuffle('$CODE', 'car', 'all')->>'assigned'" &
worker "mc-s2" "admin_shuffle('$CODE', 'team', 'all')->>'assigned'" &
for id in $(sql "select id from people where gender is not null order by id"); do
  worker "mc-p$id" "choose_menu($(dn $id), (array['ugeoji','miyeok','hwangtae'])[1 + $id % 3])" &
done
wait
eq "오류 없음" "" "$(errs "mc-")"
eq "고른 29명의 메뉴가 모두 DB 에 있음" "29" "$(sql "select count(*) from people where gender is not null and menu = (array['ugeoji','miyeok','hwangtae'])[1 + id % 3]")"
eq "차량 29명·팀 30명 정해짐" "29/30" "$(sql "select count(*) from people where car is not null")/$(sql "select count(*) from people where team is not null")"

# ── 시험용 choices_closed() 되돌리기 ───────────────────────
title "정리"
awk '/^create or replace function public.choices_closed\(\)/,/^\$\$;/' "$SQL_FILE" >"$OUT/choices_closed.sql"
run_file "$OUT/choices_closed.sql" "$OUT/choices_closed.log" && ok "choices_closed() 를 supabase.sql 의 정의로 되돌림" || ng "choices_closed() 되돌리기" "$(cat "$OUT/choices_closed.log")"
has "되돌린 choices_closed() 의 시각은 supabase.sql 그대로" "2026-11-25 15:00:00+09" "$(sql "select prosrc from pg_proc where proname = 'choices_closed'")"

echo
echo "════════════════════════════"
echo "통과 $PASS, 실패 $FAIL"
[ "$FAIL" = 0 ]
