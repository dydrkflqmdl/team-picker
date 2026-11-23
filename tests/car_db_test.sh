#!/bin/bash
# 탑승 차량 뽑기 DB 시험 — 로컬 임시 Postgres 에서만 돈다(운영 DB·인터넷에 닿지 않음).
#
# 돌리기:  bash tests/car_db_test.sh
#   (Postgres 도구 위치가 다르면  PG_BIN=/경로/bin bash tests/car_db_test.sh)
#
# 하는 일: 임시 폴더에 새 Postgres 클러스터를 만들어 127.0.0.1 의 빈 포트로 띄우고,
#   Supabase 흉내(anon·authenticated 역할, 기본 권한) → supabase.sql 을 두 번 Run(두 번째는 비밀번호 자리 그대로) → 시험 → 클러스터 삭제.
# 견본 이름은 모두 지어낸 이름, 관리자 비밀번호도 시험용 값이다.
set -u

PG_BIN=${PG_BIN:-/opt/homebrew/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
SQL_FILE="$ROOT/supabase.sql"
CODE='car-test-only-Pw-0123456789'   # 시험용 관리자 비밀번호(진짜 아님)

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  통과: $1"; }
ng() { FAIL=$((FAIL + 1)); echo "  실패: $1"; [ -n "${2:-}" ] && echo "        $2"; }
eq() { if [ "$3" = "$2" ]; then ok "$1"; else ng "$1" "기대: [$2] / 실제: [$3]"; fi; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) ng "$1" "기대 문구: [$2] / 실제: [$3]" ;; esac; }
hasnt() { case "$3" in *"$2"*) ng "$1" "없어야 할 문구: [$2] / 실제: [$3]" ;; *) ok "$1" ;; esac; }
oneof() { local v=$1; shift; for x in "$@"; do [ "$v" = "$x" ] && { echo ok; return; }; done; echo "$v"; }
title() { echo; echo "■ $1"; }
now() { python3 -c 'import time; print("%.6f" % time.time())'; }

for b in initdb pg_ctl psql postgres; do
  if [ ! -x "$PG_BIN/$b" ]; then echo "찾을 수 없음: $PG_BIN/$b (PG_BIN 을 맞춰 주세요)"; exit 2; fi
done

DATA=$(mktemp -d "${TMPDIR:-/tmp}/car_db_test.XXXXXX") || exit 2
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

# 빈 포트를 골라 띄운다(겹치면 다른 포트로 다시). 유닉스 소켓은 끄고 127.0.0.1 로만 듣는다.
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
anon() { $PSQL -At -v ON_ERROR_STOP=1 -c "set role anon" -c "$1" 2>&1; }       # 참가자(anon)로
authd() { $PSQL -At -v ON_ERROR_STOP=1 -c "set role authenticated" -c "$1" 2>&1; }
run_file() { $PSQL -v ON_ERROR_STOP=1 -f "$1" >"$2" 2>&1; }

# ── 설치: Supabase 흉내 → supabase.sql 첫 Run(비밀번호 자리를 시험용 값으로) ──
title "설치"
run_file "$HERE/car_db_supabase_stub.sql" "$OUT/stub.log" && ok "Supabase 흉내(anon·authenticated, 기본 권한)" || { ng "Supabase 흉내" "$(cat "$OUT/stub.log")"; exit 1; }
sed "s/values ('admin_code', '여기를-바꾸세요')/values ('admin_code', '$CODE')/" "$SQL_FILE" >"$OUT/run1.sql"
if grep -q "values ('admin_code', '$CODE')" "$OUT/run1.sql"; then ok "첫 Run 용 파일에 시험 비밀번호 넣음"; else ng "첫 Run 용 파일에 시험 비밀번호 넣음"; exit 1; fi
if run_file "$OUT/run1.sql" "$OUT/run1.log"; then ok "supabase.sql 첫 번째 Run 오류 없음"; else ng "supabase.sql 첫 번째 Run" "$(tail -5 "$OUT/run1.log")"; exit 1; fi
hasnt "첫 Run 에 anon 제한 시간 경고 없음" "제한 시간을 바꾸지 못했어요" "$(cat "$OUT/run1.log")"
run_file "$HERE/car_db_helpers.sql" "$OUT/helpers.log" || { ng "시험 보조 함수" "$(cat "$OUT/helpers.log")"; exit 1; }

eq "처음 차량 목록 = 1호차·2호차, 정원 자동, 운전자·문구 없음" \
  '[{"id": "car1", "name": "1호차", "label": ""}, {"id": "car2", "name": "2호차", "label": ""}]' \
  "$(sql "select value from config where key = 'cars'")"

# ── 두 번째 Run 전에 데이터를 만들어 둔다: 차량 뽑기 결과 + 진행자가 고친 차량 목록 ──
title "두 번째 Run(여러 번 Run 해도 안전한지)"
sql "select t.seed(6)" >/dev/null
sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":5},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":3},{\"id\":\"van\",\"name\":\"승합차\",\"seats\":9}]')" >/dev/null
sql "select pick_car('시험1팀', '김가람')" >/dev/null
sql "select pick('시험1팀', '김가람')" >/dev/null
before_cars=$(sql "select value from config where key = 'cars'")
before_people=$(sql "select string_agg(id || '/' || coalesce(car, '-') || '/' || coalesce(car_at::text, '-') || '/' || coalesce(team, '-'), ',' order by id) from people")
if run_file "$SQL_FILE" "$OUT/run2.log"; then ok "supabase.sql 두 번째 Run(원본 그대로) 오류 없음"; else ng "supabase.sql 두 번째 Run" "$(tail -5 "$OUT/run2.log")"; exit 1; fi
eq "두 번째 Run 뒤 진행자가 고친 차량 목록 유지" "$before_cars" "$(sql "select value from config where key = 'cars'")"
eq "두 번째 Run 뒤 명단·뽑은 차량·시각·팀 유지" "$before_people" "$(sql "select string_agg(id || '/' || coalesce(car, '-') || '/' || coalesce(car_at::text, '-') || '/' || coalesce(team, '-'), ',' order by id) from people")"
eq "두 번째 Run 뒤 관리자 비밀번호 유지" "" "$(sql "select check_admin('$CODE')")"
eq "people.car 칸이 하나뿐(두 번 더해지지 않음)" "1" "$(sql "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name = 'car'")"
run_file "$HERE/car_db_helpers.sql" "$OUT/helpers2.log" || { ng "시험 보조 함수(다시)" "$(cat "$OUT/helpers2.log")"; exit 1; }

# 이후 시험 대부분은 정원 4·4 를 적은 목록으로(자동 정원 시험은 따로 아래에)
set_cars_44() { sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":4}]')" >/dev/null; }

# ── 동시 뽑기 ─────────────────────────────────────────────
# 출발선: postgres 세션 하나가 t.gate 를 잠근 채, 뽑을 사람 n명이 모두 그 표를 기다릴 때까지 기다렸다가 푼다 → n명이 한꺼번에 출발.
# 각 사람: 출발선 통과 → anon 으로 바꾸고 → 출발 시각 → pick_car → 끝 시각
gate_hold() {  # $1 = 기다릴 사람 수
  $PSQL -At -c "begin" -c "lock table t.gate in access exclusive mode" \
    -c "do \$\$ declare s timestamptz := clock_timestamp(); begin
          loop
            exit when (select count(*) from pg_locks where relation = 't.gate'::regclass and not granted) >= $1;
            if clock_timestamp() - s > interval '30 seconds' then raise exception '출발선에 다 모이지 않음'; end if;
            perform pg_sleep(0.01);
          end loop; end \$\$" -c "commit" >"$OUT/gate.log" 2>&1 &
  GATE_PID=$!
  # 잠금이 잡힐 때까지 기다림
  local i=0
  while [ "$(sql "select count(*) from pg_locks where relation = 't.gate'::regclass and granted and mode = 'AccessExclusiveLock'")" != "1" ]; do
    i=$((i + 1)); [ $i -gt 500 ] && { echo "출발선 잠금 실패"; cat "$OUT/gate.log"; return 1; }
  done
  return 0
}
worker_pick() {  # $1 = 출력 이름, $2 = 부서, $3 = 이름
  $PSQL -At -c "select count(*) from t.gate" -c "set role anon" \
    -c "select 'S ' || extract(epoch from clock_timestamp())" \
    -c "select 'R ' || pick_car('$2', '$3')" \
    -c "select 'E ' || extract(epoch from clock_timestamp())" >"$OUT/$1.out" 2>"$OUT/$1.err"
}
worker_admin() {  # $1 = 출력 이름, $2 = 사람 id, $3 = 차량
  $PSQL -At -c "select count(*) from t.gate" -c "set role anon" \
    -c "select 'S ' || extract(epoch from clock_timestamp())" \
    -c "select 'A ' || admin_set_car('$CODE', $2, '$3')::text" \
    -c "select 'E ' || extract(epoch from clock_timestamp())" >"$OUT/$1.out" 2>"$OUT/$1.err"
}
# 결과 모으기: R 줄 수, 빈자리 없음 오류 수, 그 밖의 오류 수, 경쟁 구간(첫 출발 ~ 마지막 끝, ms)
collect() {  # $1 = 파일 이름 앞부분
  R_N=$(cat "$OUT"/$1*.out | grep -c '^R ')
  A_N=$(cat "$OUT"/$1*.out | grep -c '^A ')
  FULL_N=$(cat "$OUT"/$1*.err | grep -c '빈자리가 있는 차량이 없어요. 진행자에게 말해 주세요.')
  CARFULL_N=$(cat "$OUT"/$1*.err | grep -c '그 차량은 자리가 다 찼어요')
  OTHER_ERR=$(cat "$OUT"/$1*.err | grep 'ERROR' | grep -v '빈자리가 있는 차량이 없어요' | grep -v '그 차량은 자리가 다 찼어요' | head -3)
  SPAN_MS=$(cat "$OUT"/$1*.out | awk '$1=="S"{if(s==""||$2<s)s=$2} $1=="E"{if($2>e)e=$2} END{printf "%.0f", (e-s)*1000}')
}

title "동시 뽑기: 40명이 한꺼번에, 차량 4대 정원 합 25 (3번 되풀이)"
for round in 1 2 3; do
  sql "select t.seed(40)" >/dev/null
  sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":4},{\"id\":\"van\",\"name\":\"승합차\",\"seats\":10},{\"id\":\"suv\",\"name\":\"큰 차\",\"seats\":7}]')" >/dev/null
  rm -f "$OUT"/c$round-*
  gate_hold 40 || exit 1
  t0=$(now)
  sql "select id || ' ' || dept || ' ' || name from people order by id" >"$OUT/list.txt"
  while read -r id d n; do worker_pick "c$round-$id" "$d" "$n" & done <"$OUT/list.txt"
  wait
  t1=$(now)
  collect "c$round-"
  echo "  [${round}회] 배정 ${R_N}명, 빈자리 없음 오류 ${FULL_N}명, 경쟁 구간 ${SPAN_MS}ms, 띄우기부터 전체 $(python3 -c "print(round(($t1-$t0)*1000))")ms, 차량별 $(sql "select t.counts()")"
  eq "[${round}회] 정원 넘은 차량 없음" "0" "$(sql "select t.overfull()")"
  eq "[${round}회] 정원 합(25)만큼만 배정(DB)" "25" "$(sql "select count(*) from people where car is not null")"
  eq "[${round}회] 배정 25명 / 오류 15명(응답)" "25/15" "$R_N/$FULL_N"
  eq "[${round}회] 다른 오류 없음" "" "$OTHER_ERR"
  eq "[${round}회] 응답한 차량 = DB 에 들어간 차량(사람마다)" "0" "$(for f in "$OUT"/c$round-*.out; do id=$(basename "$f" .out); id=${id#c$round-}; r=$(grep '^R ' "$f" | cut -c3-); [ -n "$r" ] && echo "$id $r"; done | while read -r id r; do [ "$(sql "select car from people where id = $id")" = "$r" ] || echo bad; done | grep -c bad)"
done

title "마지막 한 자리: 남은 1자리에 13명이 한꺼번에"
sql "select t.seed(20)" >/dev/null
set_cars_44
sql "select admin_set_car('$CODE', id, case when id <= (select min(id) + 3 from people) then 'car1' else 'car2' end) from people where id <= (select min(id) + 6 from people)" >/dev/null
eq "미리 7명 넣음(car1 4, car2 3)" "car1:4,car2:3,none:13" "$(sql "select t.counts()")"
rm -f "$OUT"/last-*
gate_hold 13 || exit 1
sql "select id || ' ' || dept || ' ' || name from people where car is null order by id" >"$OUT/list.txt"
while read -r id d n; do worker_pick "last-$id" "$d" "$n" & done <"$OUT/list.txt"
wait
collect "last-"
eq "정확히 한 명만 배정, 12명은 빈자리 없음 오류" "1/12" "$R_N/$FULL_N"
eq "그 한 명은 남은 자리(car2)" "R car2" "$(cat "$OUT"/last-*.out | grep '^R ')"
eq "결과 car1 4, car2 4" "car1:4,car2:4,none:12" "$(sql "select t.counts()")"
eq "다른 오류 없음" "" "$OTHER_ERR"

title "참가자 뽑기와 진행자 넣기가 한꺼번에(30명 뽑기 + 진행자 10번 넣기, 정원 4·4)"
sql "select t.seed(40)" >/dev/null
set_cars_44
rm -f "$OUT"/mix-*
gate_hold 40 || exit 1
sql "select id || ' ' || dept || ' ' || name from people order by id limit 30" >"$OUT/list.txt"
while read -r id d n; do worker_pick "mix-p$id" "$d" "$n" & done <"$OUT/list.txt"
for id in $(sql "select id from people order by id offset 30"); do worker_admin "mix-a$id" "$id" "car1" & done
wait
collect "mix-"
eq "정원 넘은 차량 없음" "0" "$(sql "select t.overfull()")"
eq "모두 8명(정원 합)" "8" "$(sql "select count(*) from people where car is not null")"
eq "참가자 배정 + 진행자 넣기 성공 = 8" "8" "$((R_N + A_N))"
eq "실패는 '빈자리 없음' 또는 '자리가 다 찼어요'뿐" "" "$OTHER_ERR"
echo "  (참가자 배정 $R_N, 진행자 넣기 성공 $A_N, 빈자리 없음 $FULL_N, 자리가 다 찼어요 $CARFULL_N, 경쟁 구간 ${SPAN_MS}ms)"

# ── 차례대로 하는 시험 ─────────────────────────────────────
title "자리가 다 찬 경우, 다시 누르기, 명단에 없음"
sql "select t.seed(10)" >/dev/null
set_cars_44
for n in 김가람 김나래 김도윤 김서연 김하늘 김별 김지호 김다솜; do anon "select pick_car('$(sql "select dept from people where name = '$n'")', '$n')" >/dev/null; done
eq "8명 뽑은 뒤 4·4" "car1:4,car2:4,none:2" "$(sql "select t.counts()")"
has "9번째 사람: 빈자리 없음 문구" "ERROR:  빈자리가 있는 차량이 없어요. 진행자에게 말해 주세요." "$(anon "select pick_car('시험3팀', '이가람')")"
eq "오류 뒤 9번째 사람은 차량 없음" "" "$(sql "select car from people where name = '이가람'")"
first=$(sql "select car from people where name = '김가람'")
cnt_before=$(sql "select t.counts()")
log_before=$(sql "select count(*) from people_log")
eq "이미 뽑은 사람이 다시 누르면 같은 차량" "$first" "$(anon "select pick_car('시험1팀', '김가람')")"
eq "다시 눌러도 인원 그대로" "$cnt_before" "$(sql "select t.counts()")"
eq "다시 눌러도 기록(people_log) 안 늘어남" "$log_before" "$(sql "select count(*) from people_log")"
eq "띄어쓰기·앞뒤 공백 달라도 같은 사람(정리 규칙 그대로)" "$first" "$(anon "select pick_car(' 시험1팀 ', '김 가람')")"
has "명단에 없는 사람" "ERROR:  명단에 없는 부서·이름이에요." "$(anon "select pick_car('시험1팀', '없는사람')")"
has "너무 긴 입력(101자)은 바로 거절" "ERROR:  명단에 없는 부서·이름이에요." "$(anon "select pick_car(repeat('가', 101), '김가람')")"
eq "꽉 찬 차량은 절대 고르지 않음(car1 꽉 참, 300번 → 모두 car2)" "car2:300" \
  "$(sql "select admin_set_car('$CODE', id, null) from people where car = 'car2' and name <> '김나래'; select t.first_pick(300)" | tail -1)"

# ── 쏠림 ──────────────────────────────────────────────────
# 카이제곱(자유도 1) 13.0 → 유의확률 약 0.0003. 이보다 크면 쏠림으로 본다(맞는 코드가 우연히 떨어질 확률은 0.03% 정도).
chi_check() {  # $1 이름, $2 결과 'a:n,b:m', $3 a 의 기대 비율, $4 a id
  echo "$2" | tr ',' '\n' | awk -F: -v want="$3" -v a="$4" -v name="$1" '
    { n[$1] = $2; tot += $2 }
    END {
      oa = n[a] + 0; ob = tot - oa; ea = tot * want; eb = tot - ea;
      chi = (oa - ea)^2 / ea + (ob - eb)^2 / eb;
      printf "%s|%d|%d|%.2f|%.2f|%.3f\n", (chi < 13.0 ? "ok" : "ng"), oa, tot, 100 * oa / tot, 100 * want, chi
    }' >"$OUT/chi.txt"
  IFS='|' read -r res oa tot pct wpct chi <"$OUT/chi.txt"
  local msg="$1: ${4} ${oa}/${tot} = ${pct}% (기대 ${wpct}%), 카이제곱 ${chi}"
  if [ "$res" = "ok" ]; then ok "$msg"; else ng "$msg"; fi
}
title "쏠림: 첫 사람 배정을 2000번 되풀이"
sql "select t.seed(10)" >/dev/null
set_cars_44
r=$(sql "select t.first_pick(2000)")
chi_check "정원 같음(4·4)" "$r" 0.5 car1
sql "select admin_set_cars('$CODE', '[{\"id\":\"small\",\"name\":\"작은 차\",\"seats\":2},{\"id\":\"big\",\"name\":\"큰 차\",\"seats\":6}]')" >/dev/null
r=$(sql "select t.first_pick(2000)")
chi_check "정원 다름(2·6) → 남은 자리 비율 25%" "$r" 0.25 small
set_cars_44
sql "select admin_set_car('$CODE', id, 'car1') from people where id in (select id from people order by id desc limit 3)" >/dev/null
eq "car1 에 미리 3명(남은 자리 1·4)" "car1:3,car2:0,none:7" "$(sql "select t.counts()")"
r=$(sql "select t.first_pick(2000)")
chi_check "남은 자리 1·4 → 20%" "$r" 0.2 car1

title "쏠림: 성별·직급과 무관한지(15명, 정원 4·4, 무작위 순서로 전원 뽑기 400번)"
# (성별 × 결과[car1·car2·none]) 와 (임원 여부 × 결과) 의 독립성 카이제곱(자유도 2). 16.5 → 유의확률 약 0.0003.
sql "select t.seed(15)" >/dev/null
set_cars_44
sql "select gender || ' ' || is_exec || ' ' || car || ' ' || n from t.full_rounds(400)" >"$OUT/rounds.txt"
indep() {  # $1 이름, $2 칸 번호(1 = 성별, 2 = 임원 여부)
  awk -v col="$2" -v name="$1" '
    { g = $col; c = $3; n = $4; o[g, c] += n; rs[g] += n; cs[c] += n; tot += n }
    END {
      chi = 0; desc = "";
      for (g in rs) { line = g ":"; for (c in cs) { e = rs[g] * cs[c] / tot; chi += (o[g, c] - e)^2 / e; line = line " " c "=" sprintf("%.1f%%", 100 * o[g, c] / rs[g]) } desc = desc " [" line "]" }
      printf "%s|%.3f|%s\n", (chi < 16.5 ? "ok" : "ng"), chi, desc
    }' "$OUT/rounds.txt" >"$OUT/indep.txt"
  IFS='|' read -r res chi desc <"$OUT/indep.txt"
  if [ "$res" = "ok" ]; then ok "$1 무관: 카이제곱 $chi $desc"; else ng "$1 무관: 카이제곱 $chi $desc"; fi
}
indep "성별과" 1
indep "임원 여부(직급)와" 2

# ── 반환 모양 ────────────────────────────────────────────
title "car_state 반환 모양"
sql "select t.seed(10)" >/dev/null
set_cars_44
eq "명단에 없으면 null" "t" "$(anon "select car_state('시험1팀', '없는사람') is null")"
S="car_state('시험1팀', '김가람')"
eq "맨 위 열쇠 = car, cars, members" "car,cars,members" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($S) k")"
eq "뽑기 전: car·members 는 null" "null/null" "$(anon "select json_typeof($S->'car') || '/' || json_typeof($S->'members')")"
eq "cars 는 config 순서(car1, car2)" "car1,car2" "$(anon "select string_agg(e->>'id', ',') from json_array_elements($S->'cars') e")"
eq "cars 하나의 열쇠 = auto, count, driver, id, label, name, seats" "auto,count,driver,id,label,name,seats" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($S->'cars'->0) k")"
eq "cars 의 값 모양(이름·문구·정원·자동 아님·인원 0·운전자 없음)" '1호차//4/false/0/number/number/null' "$(anon "select (c->>'name') || '/' || (c->>'label') || '/' || (c->>'seats') || '/' || (c->>'auto') || '/' || (c->>'count') || '/' || json_typeof(c->'seats') || '/' || json_typeof(c->'count') || '/' || json_typeof(c->'driver') from (select $S->'cars'->0 as c) x")"
# 같은 차량에 셋을 차례로 넣는다(진행자 넣기) → members 는 넣은 순서
for n in 김나래 김가람 김도윤; do sql "select admin_set_car('$CODE', (select id from people where name = '$n'), 'car2')" >/dev/null; done
eq "차량이 있으면 car = 그 차량 id" "car2" "$(anon "select $S->>'car'")"
eq "members = 같은 차량 사람(나 포함), 배정된 순서" "김나래,김가람,김도윤" "$(anon "select string_agg(e->>'name', ',') from json_array_elements($S->'members') e")"
eq "members 하나의 열쇠 = dept, name, title" "dept,name,title" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($S->'members'->0) k")"
eq "count 가 탄 인원(car2 3)" "0,3" "$(anon "select string_agg(e->>'count', ',') from json_array_elements($S->'cars') e")"

title "board_cars 반환 모양"
B="board_cars('$CODE')"
eq "맨 위 열쇠 = cars, people" "cars,people" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($B) k")"
eq "cars 하나의 열쇠 = auto, driver, id, label, name, seats" "auto,driver,id,label,name,seats" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($B->'cars'->0) k")"
eq "people 하나의 열쇠 = car, car_at, dept, gender, id, name, title" "car,car_at,dept,gender,id,name,title" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($B->'people'->0) k")"
eq "people 은 명단 전원(안 뽑은 사람 포함 10명)" "10" "$(anon "select json_array_length($B->'people')")"
eq "안 뽑은 사람의 car 는 null" "7" "$(anon "select count(*) from json_array_elements($B->'people') e where json_typeof(e->'car') = 'null'")"
has "비밀번호 틀리면 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select board_cars('wrong')")"

# ── 진행자 함수 ──────────────────────────────────────────
title "admin_set_car"
sql "select t.seed(10)" >/dev/null
set_cars_44
ID1=$(sql "select id from people where name = '김가람'")
eq "넣기" "car1" "$(anon "select admin_set_car('$CODE', $ID1, 'car1')" >/dev/null; sql "select car from people where id = $ID1")"
eq "넣으면 car_at 도 채움" "t" "$(sql "select car_at is not null from people where id = $ID1")"
eq "옮기기" "car2" "$(anon "select admin_set_car('$CODE', $ID1, 'car2')" >/dev/null; sql "select car from people where id = $ID1")"
eq "옮긴 것도 people_log 에 남음(예전 값 car1)" "car1" "$(sql "select old->>'car' from people_log where op = 'UPDATE' and (old->>'id')::bigint = $ID1 order by at desc, ctid desc limit 1")"
eq "null 이면 비움(car·car_at)" "t" "$(anon "select admin_set_car('$CODE', $ID1, null)" >/dev/null; sql "select car is null and car_at is null from people where id = $ID1")"
anon "select admin_set_car('$CODE', $ID1, 'car1')" >/dev/null
eq "'' 이어도 비움" "t" "$(anon "select admin_set_car('$CODE', $ID1, '')" >/dev/null; sql "select car is null from people where id = $ID1")"
sql "select admin_set_car('$CODE', id, 'car1') from people where id in (select id from people order by id limit 4)" >/dev/null
eq "car1 4명 채움" "car1:4,car2:0,none:6" "$(sql "select t.counts()")"
ID5=$(sql "select id from people order by id offset 4 limit 1")
has "꽉 찬 차량에 넣으면 오류 문구" "ERROR:  그 차량은 자리가 다 찼어요(정원 4명)." "$(anon "select admin_set_car('$CODE', $ID5, 'car1')")"
eq "꽉 찬 차량 오류 뒤 그대로" "car1:4,car2:0,none:6" "$(sql "select t.counts()")"
eq "이미 그 차량에 탄 사람을 다시 넣으면 오류 없이 그대로" "car1:4,car2:0,none:6" "$(anon "select admin_set_car('$CODE', $ID1, 'car1')" >/dev/null; sql "select t.counts()")"
has "없는 차량 id 면 오류" "ERROR:  없는 차량이에요. 새로고침해 주세요." "$(anon "select admin_set_car('$CODE', $ID5, 'bus')")"
has "없는 사람이면 오류" "ERROR:  명단에서 그 사람을 찾을 수 없어요. 새로고침해 주세요." "$(anon "select admin_set_car('$CODE', 999999, 'car1')")"
has "비밀번호 틀리면 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select admin_set_car('wrong', $ID5, 'car2')")"
has "비밀번호 없으면(null) 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select admin_set_car(null, $ID5, 'car2')")"
eq "거절된 뒤 그대로" "car1:4,car2:0,none:6" "$(sql "select t.counts()")"
eq "진행자가 먼저 넣은 자리는 빼고 남은 자리만 뽑힘(car1 꽉 참 → car2)" "car2" "$(anon "select pick_car('시험3팀', '김별')")"

title "admin_clear_cars"
has "비밀번호 틀리면 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select admin_clear_cars('wrong')")"
eq "거절된 뒤 그대로" "car1:4,car2:1,none:5" "$(sql "select t.counts()")"
anon "select admin_clear_cars('$CODE')" >/dev/null
eq "모든 사람 차량 비움(car·car_at)" "0" "$(sql "select count(*) from people where car is not null or car_at is not null")"
eq "다른 칸(팀·조식 등)은 건드리지 않음" "0" "$(sql "select count(*) from people_log l join people p on p.id = (l.old->>'id')::bigint where l.op = 'UPDATE' and (l.old->>'team' is distinct from p.team or l.old->>'menu' is distinct from p.menu or l.old->>'room' is distinct from p.room)")"

title "admin_set_cars 검사 규칙"
set_cars_44
OK_CARS=$(sql "select value from config where key = 'cars'")
bad() {  # $1 이름, $2 json, $3 기대 문구
  has "$1" "$3" "$(anon "select admin_set_cars('$CODE', '$2')")"
}
bad "목록이 아니면(객체)" '{"id":"car1"}' "ERROR:  차량 목록은 [ … ] 모양의 목록이어야 해요."
bad "목록이 아니면(null)" 'null' "ERROR:  차량 목록은 [ … ] 모양의 목록이어야 해요."
bad "빈 목록" '[]' "ERROR:  차량은 1대에서 20대까지 둘 수 있어요."
bad "21대" "$(sql "select jsonb_agg(jsonb_build_object('id', 'c' || i, 'name', '차' || i, 'seats', 4)) from generate_series(1, 21) i")" "ERROR:  차량은 1대에서 20대까지 둘 수 있어요."
eq "20대는 저장됨" "20" "$(anon "select admin_set_cars('$CODE', '$(sql "select jsonb_agg(jsonb_build_object('id', 'c' || i, 'name', '차' || i, 'seats', 4)) from generate_series(1, 20) i")')" >/dev/null; sql "select jsonb_array_length(value::jsonb) from config where key = 'cars'")"
set_cars_44
bad "차량이 객체가 아님" '["car1"]' '모양이어야 해요.'
bad "id 대문자" '[{"id":"Son","name":"가","seats":4}]' 'ERROR:  차량 id "Son" 가 올바르지 않아요.'
bad "id 띄어쓰기" '[{"id":"a b","name":"가","seats":4}]' 'ERROR:  차량 id "a b" 가 올바르지 않아요.'
bad "id 21자" '[{"id":"abcdefghijabcdefghijk","name":"가","seats":4}]' '가 올바르지 않아요.'
bad "id 한글" '[{"id":"손","name":"가","seats":4}]' '가 올바르지 않아요.'
bad "id 가 숫자" '[{"id":1,"name":"가","seats":4}]' '가 올바르지 않아요.'
bad "id 없음" '[{"name":"가","seats":4}]' '가 올바르지 않아요.'
bad "id 겹침" '[{"id":"a","name":"가","seats":4},{"id":"a","name":"나","seats":4}]' 'ERROR:  차량 id "a" 가 두 번 있어요.'
bad "이름 빈칸(공백만)" '[{"id":"a","name":"   ","seats":4}]' 'ERROR:  차량 "a" 의 이름은 1~30자여야 해요.'
bad "이름 31자" "[{\"id\":\"a\",\"name\":\"$(printf '가%.0s' $(seq 1 31))\",\"seats\":4}]" '의 이름은 1~30자여야 해요.'
bad "이름 숫자" '[{"id":"a","name":7,"seats":4}]' '의 이름은 1~30자여야 해요.'
bad "이름 겹침(앞뒤 공백만 다름)" '[{"id":"a","name":"가","seats":4},{"id":"b","name":" 가 ","seats":4}]' 'ERROR:  차량 이름 "가" 가 두 번 있어요.'
bad "자리 0" '[{"id":"a","name":"가","seats":0}]' 'ERROR:  "가" 의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.'
bad "자리 100" '[{"id":"a","name":"가","seats":100}]' '의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.'
bad "자리 2.5" '[{"id":"a","name":"가","seats":2.5}]' '의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.'
bad "자리 음수" '[{"id":"a","name":"가","seats":-1}]' '의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.'
bad "자리 글자 \"4\"" '[{"id":"a","name":"가","seats":"4"}]' '의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.'
bad "자리 아주 큰 수" '[{"id":"a","name":"가","seats":1e30}]' '의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.'
bad "자리 true" '[{"id":"a","name":"가","seats":true}]' '의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.'
bad "문구가 글자가 아님(숫자)" '[{"id":"a","name":"가","label":7}]' 'ERROR:  "가" 의 문구는 글자로 적어 주세요.'
bad "문구가 글자가 아님(목록)" '[{"id":"a","name":"가","label":["x"]}]' 'ERROR:  "가" 의 문구는 글자로 적어 주세요.'
bad "문구 31자" "[{\"id\":\"a\",\"name\":\"가\",\"label\":\"$(printf '가%.0s' $(seq 1 31))\"}]" '의 문구는 30자까지 적을 수 있어요.'
eq "거절된 뒤 목록 그대로" "$OK_CARS" "$(sql "select value from config where key = 'cars'")"
has "비밀번호 틀리면 거절" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select admin_set_cars('wrong', '[{\"id\":\"a\",\"name\":\"가\",\"seats\":4}]')")"
eq "비밀번호 틀린 뒤 목록 그대로" "$OK_CARS" "$(sql "select value from config where key = 'cars'")"

title "admin_set_cars: 탄 사람이 있을 때"
sql "select t.seed(10)" >/dev/null
set_cars_44
sql "select admin_set_car('$CODE', id, 'car2') from people where id in (select id from people order by id limit 2)" >/dev/null
sql "select admin_set_car('$CODE', id, 'car1') from people where id in (select id from people order by id offset 2 limit 1)" >/dev/null
eq "준비: car2 2명, car1 1명" "car1:1,car2:2,none:7" "$(sql "select t.counts()")"
has "탄 사람이 있는 차량 빼기 거절" 'ERROR:  "2호차" 에 탄 사람이 2명 있어 목록에서 뺄 수 없어요.' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4}]')")"
has "정원을 탄 인원보다 작게 하면 거절" 'ERROR:  "2호차" 의 정원(1명)이 지금 탄 인원(2명)보다 적어요.' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":1}]')")"
eq "거절된 뒤 목록 그대로" "$OK_CARS" "$(sql "select value from config where key = 'cars'")"
log_before=$(sql "select count(*) from people_log where op = 'CARS'")
NEW='[{"id":"car2","name":"  2호차 SUV ","seats":2,"color":"red"},{"id":"car1","name":"1호차","seats":5},{"id":"van","name":"승합차","seats":11}]'
eq "정원 = 탄 인원, 이름 바꾸기, 순서 바꾸기, 차량 더하기는 저장" "" "$(anon "select admin_set_cars('$CODE', '$NEW')")"
eq "저장 모양: 이름 앞뒤 공백 지움, id·name·label·seats 만(문구가 없으면 빈 문구)" \
  '[{"id": "car2", "name": "2호차 SUV", "label": "", "seats": 2}, {"id": "car1", "name": "1호차", "label": "", "seats": 5}, {"id": "van", "name": "승합차", "label": "", "seats": 11}]' \
  "$(sql "select value from config where key = 'cars'")"
eq "고치기 전 목록을 people_log 에 op = 'CARS' 로 남김" "$((log_before + 1))/$OK_CARS" "$(sql "select count(*) from people_log where op = 'CARS'")/$(sql "select old->>'value' from people_log where op = 'CARS' order by at desc limit 1")"
eq "같은 목록을 또 저장하면 기록 안 늘어남" "$((log_before + 1))" "$(anon "select admin_set_cars('$CODE', '$NEW')" >/dev/null; sql "select count(*) from people_log where op = 'CARS'")"
eq "car_state 도 새 순서·이름" "car2:2호차 SUV:2:2,car1:1호차:5:1,van:승합차:11:0" \
  "$(anon "select string_agg((e->>'id') || ':' || (e->>'name') || ':' || (e->>'seats') || ':' || (e->>'count'), ',') from json_array_elements(car_state('시험1팀', '김가람')->'cars') e")"
eq "꽉 찬 car2(2/2)은 뽑기에서 빠짐: 뽑은 사람은 car1 이나 van" "ok" "$(oneof "$(anon "select pick_car('시험3팀', '김별')")" car1 van)"

title "깨진 차량 목록(SQL Editor 에서 잘못 고친 경우)"
sql "select t.seed(4)" >/dev/null
sql "select t.raw_cars('이건 JSON 아님')" >/dev/null
has "pick_car: JSON 아님" "ERROR:  차량 목록이 잘못 저장돼 있어요(config 의 cars 가 JSON 이 아니에요). 진행자에게 말해 주세요." "$(anon "select pick_car('시험1팀', '김가람')")"
has "car_state: JSON 아님" "차량 목록이 잘못 저장돼 있어요(config 의 cars 가 JSON 이 아니에요)" "$(anon "select car_state('시험1팀', '김가람')")"
has "board_cars: JSON 아님" "차량 목록이 잘못 저장돼 있어요(config 의 cars 가 JSON 이 아니에요)" "$(anon "select board_cars('$CODE')")"
has "admin_set_car: JSON 아님" "차량 목록이 잘못 저장돼 있어요" "$(anon "select admin_set_car('$CODE', $(sql "select min(id) from people"), 'car1')")"
sql "select t.raw_cars('{\"car1\": 4}')" >/dev/null
has "목록 모양 아님" "ERROR:  차량 목록이 잘못 저장돼 있어요(config 의 cars: 차량 목록은 [ … ] 모양의 목록이어야 해요.). 진행자에게 말해 주세요." "$(anon "select pick_car('시험1팀', '김가람')")"
sql "select t.raw_cars('[{\"id\":\"car1\",\"name\":\"손\",\"seats\":0}]')" >/dev/null
has "자리 수 틀림" '차량 목록이 잘못 저장돼 있어요(config 의 cars: "손" 의 정원은 비워 두거나(자동) 1~99 사이의 정수여야 해요.)' "$(anon "select pick_car('시험1팀', '김가람')")"
sql "delete from config where key = 'cars'" >/dev/null
has "목록 줄이 아예 없음" "ERROR:  차량 목록이 아직 없어요(config 의 cars). 진행자에게 말해 주세요." "$(anon "select pick_car('시험1팀', '김가람')")"
sql "select t.raw_cars('이건 JSON 아님')" >/dev/null
sql "insert into config values ('cars', '이건 JSON 아님') on conflict do nothing" >/dev/null
eq "깨진 목록도 admin_set_cars 로 고칠 수 있음" "" "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4}]')")"
eq "고친 뒤 뽑기 됨" "car1" "$(anon "select pick_car('시험1팀', '김가람')")"
eq "깨진 글도 people_log 에 남김" "이건 JSON 아님" "$(sql "select old->>'value' from people_log where op = 'CARS' order by at desc limit 1")"

# ── 운전자 ────────────────────────────────────────────────
# 차량 두 대 목록 저장: $1 = 1호차에 더할 칸, $2 = 2호차에 더할 칸 (예: '"seats":4,"driver":12'). 비우면 정원 자동·운전자 없음
# 문구는 지어낸 것(실제 호칭 아님)
cars2() {
  sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"label\":\"가온님 차량\"${1:+,$1}},{\"id\":\"car2\",\"name\":\"2호차\",\"label\":\"다온님 차량\"${2:+,$2}}]')"
}
idof() { sql "select id from people where name = '$1'"; }
deptof() { sql "select dept from people where name = '$1'"; }
nth_id() { sql "select id from people order by id desc offset $1 limit 1"; }  # 0 = id 가 가장 큰 사람
pick_rest() { sql "select count(*) from (select pick_car(dept, name) from people where car is null and id <> all (t.drivers()) order by random()) s"; }

title "운전자: 뽑지 않고 그 차량, 정원(손님 자리)에 들지 않음"
sql "select t.seed(10)" >/dev/null
D1=$(nth_id 0); D2=$(nth_id 1)
D1N=$(sql "select name from people where id = $D1"); D1D=$(sql "select dept from people where id = $D1")
D2N=$(sql "select name from people where id = $D2"); D2D=$(sql "select dept from people where id = $D2")
eq "운전자 지정 저장" "" "$(cars2 "\"seats\":4,\"driver\":$D1" "\"seats\":4,\"driver\":$D2")"
eq "저장 모양: id·name·label·seats·driver" \
  "[{\"id\": \"car1\", \"name\": \"1호차\", \"label\": \"가온님 차량\", \"seats\": 4, \"driver\": $D1}, {\"id\": \"car2\", \"name\": \"2호차\", \"label\": \"다온님 차량\", \"seats\": 4, \"driver\": $D2}]" \
  "$(sql "select value from config where key = 'cars'")"
eq "운전자가 pick_car → 운전하는 차량(1호차)" "car1" "$(anon "select pick_car('$D1D', '$D1N')")"
eq "운전자가 pick_car → 운전하는 차량(2호차)" "car2" "$(anon "select pick_car('$D2D', '$D2N')")"
eq "운전자가 뽑아도 people.car 는 비어 있고 인원 그대로" "car1:0,car2:0,none:10/0" "$(sql "select t.counts()")/$(sql "select count(*) from people where id in ($D1, $D2) and car is not null")"
eq "운전자가 200번 불러도 늘 1호차, 다른 차량에 배정되지 않음" "0/0" \
  "$(sql "select count(*) from generate_series(1, 200) g where pick_car('$D1D', '$D1N') <> 'car1'")/$(sql "select count(*) from people where car is not null")"
eq "손님 8명이 뽑으면 손님만으로 4·4 다 참(운전자는 자리를 안 씀)" "8" "$(pick_rest)"
eq "결과 car1 4, car2 4, 차량 칸이 빈 2명 = 운전자" "car1:4,car2:4,none:2/2" "$(sql "select t.counts()")/$(sql "select count(*) from people where car is null and id in ($D1, $D2)")"
eq "꽉 찬 뒤에도 운전자는 그 차량" "car1" "$(anon "select pick_car('$D1D', '$D1N')")"
sql "select t.add_people(1)" >/dev/null
has "손님 한 명 더: 빈자리 없음(운전자 자리는 없음)" "ERROR:  빈자리가 있는 차량이 없어요. 진행자에게 말해 주세요." "$(anon "select pick_car('시험9팀', '추가1')")"

title "car_state·board_cars: 운전자 모양"
SD="car_state('$D1D', '$D1N')"
P1=$(sql "select name from people where car = 'car1' order by car_at, id limit 1"); P1D=$(deptof "$P1")
SP="car_state('$P1D', '$P1')"
SX="car_state('시험9팀', '추가1')"
eq "운전자 본인: car = 운전하는 차량" "car1" "$(anon "select $SD->>'car'")"
eq "운전자 본인: members = 그 차량 손님 4명(운전자 없음)" "4/0" "$(anon "select json_array_length($SD->'members') || '/' || (select count(*) from json_array_elements($SD->'members') e where e->>'name' = '$D1N')")"
eq "운전자 본인: 맨 위 열쇠 그대로(car, cars, members)" "car,cars,members" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($SD) k")"
eq "cars[].driver = 각 차량 운전자 이름" "$D1N,$D2N" "$(anon "select string_agg(e->'driver'->>'name', ',') from json_array_elements($SD->'cars') e")"
eq "cars[].driver 열쇠 = dept, name, title" "dept,name,title" "$(anon "select string_agg(k, ',' order by k) from json_object_keys($SD->'cars'->0->'driver') k")"
eq "cars[].label = 문구" "가온님 차량" "$(anon "select $SD->'cars'->0->>'label'")"
eq "cars[].count 는 손님만(4·4)" "4,4" "$(anon "select string_agg(e->>'count', ',') from json_array_elements($SD->'cars') e")"
eq "손님: car = 1호차, members 에 운전자 없음(나 포함 4명)" "car1/4/0" "$(anon "select ($SP->>'car') || '/' || json_array_length($SP->'members') || '/' || (select count(*) from json_array_elements($SP->'members') e where e->>'name' = '$D1N')")"
eq "손님도 운전자 이름을 받음" "$D1N" "$(anon "select $SP->'cars'->0->'driver'->>'name'")"
eq "아직 차량 없는 사람도 운전자 이름을 받음(car·members 는 null)" "$D1N,$D2N/null/null" "$(anon "select (select string_agg(e->'driver'->>'name', ',') from json_array_elements($SX->'cars') e) || '/' || json_typeof($SX->'car') || '/' || json_typeof($SX->'members')")"
eq "board_cars: cars[].driver = 사람 id" "$D1,$D2" "$(anon "select string_agg(e->>'driver', ',') from json_array_elements(board_cars('$CODE')->'cars') e")"
eq "board_cars: 운전자도 people 에 있고 car 는 null" "2" "$(anon "select count(*) from json_array_elements(board_cars('$CODE')->'people') e where (e->>'id')::bigint in ($D1, $D2) and json_typeof(e->'car') = 'null'")"
anon "select admin_clear_cars('$CODE')" >/dev/null
eq "손님이 없는 차량의 운전자: car 는 그 차량, members 는 빈 목록" "car1/array/0" "$(anon "select ($SD->>'car') || '/' || json_typeof($SD->'members') || '/' || json_array_length($SD->'members')")"
eq "차량 모두 비우기는 운전자 지정을 지우지 않음" "car1" "$(anon "select pick_car('$D1D', '$D1N')")"

title "동시 뽑기에 운전자가 섞임: 40명(운전자 2)이 한꺼번에, 정원 합 25"
sql "select t.seed(40)" >/dev/null
DA=$(sql "select id from people order by id offset 4 limit 1"); DB=$(sql "select id from people order by id offset 19 limit 1")
sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4,\"driver\":$DA},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":4},{\"id\":\"van\",\"name\":\"승합차\",\"seats\":10,\"driver\":$DB},{\"id\":\"suv\",\"name\":\"큰 차\",\"seats\":7}]')" >/dev/null
rm -f "$OUT"/dc-*
gate_hold 40 || exit 1
sql "select id || ' ' || dept || ' ' || name from people order by id" >"$OUT/list.txt"
while read -r id d n; do worker_pick "dc-$id" "$d" "$n" & done <"$OUT/list.txt"
wait
collect "dc-"
echo "  (응답 ${R_N}개, 빈자리 없음 ${FULL_N}명, 경쟁 구간 ${SPAN_MS}ms, 차량별 $(sql "select t.counts()"))"
eq "정원 넘은 차량 없음" "0" "$(sql "select t.overfull()")"
eq "손님 25명만 배정(DB), 운전자 2명은 차량 칸이 빔" "25/0" "$(sql "select count(*) from people where car is not null")/$(sql "select count(*) from people where id in ($DA, $DB) and car is not null")"
eq "응답: 손님 25 + 운전자 2 = 27, 빈자리 없음 13" "27/13" "$R_N/$FULL_N"
eq "운전자 응답은 운전하는 차량" "R car1/R van" "$(grep '^R ' "$OUT/dc-$DA.out")/$(grep '^R ' "$OUT/dc-$DB.out")"
eq "다른 오류 없음" "" "$OTHER_ERR"

title "admin_set_cars: 운전자 검사"
sql "select t.seed(10)" >/dev/null
set_cars_44
GA=$(idof 김가람); NR=$(idof 김나래)
anon "select admin_set_car('$CODE', $GA, 'car2')" >/dev/null
OK_CARS=$(sql "select value from config where key = 'cars'")
bad "운전자가 글자" '[{"id":"a","name":"가","driver":"5"}]' 'ERROR:  "가" 의 운전자 값이 올바르지 않아요(명단의 사람 번호여야 해요).'
bad "운전자가 소수" '[{"id":"a","name":"가","driver":1.5}]' '의 운전자 값이 올바르지 않아요'
bad "운전자 0" '[{"id":"a","name":"가","driver":0}]' '의 운전자 값이 올바르지 않아요'
bad "운전자 음수" '[{"id":"a","name":"가","driver":-3}]' '의 운전자 값이 올바르지 않아요'
bad "운전자 true" '[{"id":"a","name":"가","driver":true}]' '의 운전자 값이 올바르지 않아요'
bad "두 차량에 같은 운전자" "[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$NR},{\"id\":\"car2\",\"name\":\"2호차\",\"driver\":$NR}]" 'ERROR:  한 사람이 "1호차"·"2호차" 두 차량의 운전자예요. 한 차량에만 골라 주세요.'
bad "명단에 없는 운전자" '[{"id":"car1","name":"1호차","driver":999999},{"id":"car2","name":"2호차"}]' 'ERROR:  "1호차" 의 운전자가 명단에 없어요(명단에서 지워진 사람이에요). 운전자를 다시 골라 주세요.'
bad "다른 차량 손님을 운전자로" "[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$GA},{\"id\":\"car2\",\"name\":\"2호차\"}]" 'ERROR:  김가람 님이 이미 2호차에 손님으로 타 있어요. 먼저 비워 주세요.'
bad "같은 차량 손님을 운전자로" "[{\"id\":\"car1\",\"name\":\"1호차\"},{\"id\":\"car2\",\"name\":\"2호차\",\"driver\":$GA}]" 'ERROR:  김가람 님이 이미 2호차에 손님으로 타 있어요. 먼저 비워 주세요.'
eq "거절된 뒤 목록 그대로" "$OK_CARS" "$(sql "select value from config where key = 'cars'")"
eq "driver: null 은 운전자 없음으로 저장(칸 없음)" '[{"id": "car1", "name": "1호차", "label": "", "seats": 4}, {"id": "car2", "name": "2호차", "label": "", "seats": 4}]' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4,\"driver\":null},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":4,\"label\":null}]')" >/dev/null; sql "select value from config where key = 'cars'")"
anon "select admin_set_car('$CODE', $GA, null)" >/dev/null
eq "손님 자리를 비운 뒤에는 운전자로 저장됨" "" "$(cars2 "\"seats\":4,\"driver\":$GA" '"seats":4')"

title "admin_set_car: 운전자를 손님으로 넣기 거절"
has "운전자를 다른 차량 손님으로" "ERROR:  운전자는 차량 목록 고치기에서 바꿔요." "$(anon "select admin_set_car('$CODE', $GA, 'car2')")"
has "운전자를 자기 차량 손님으로" "ERROR:  운전자는 차량 목록 고치기에서 바꿔요." "$(anon "select admin_set_car('$CODE', $GA, 'car1')")"
eq "운전자 비우기(null)는 오류 없이 그대로" "" "$(anon "select admin_set_car('$CODE', $GA, null)")"
eq "거절 뒤 운전자의 차량 칸은 빔" "t" "$(sql "select car is null from people where id = $GA")"

title "운전자가 명단에서 지워짐"
anon "select admin_set_car('$CODE', $NR, 'car1')" >/dev/null
anon "select admin_remove('$CODE', $GA)" >/dev/null
eq "car_state 오류 없음: 1호차 운전자는 null, 2호차도 null" "null,null" "$(anon "select string_agg(json_typeof(e->'driver'), ',') from json_array_elements(car_state('시험2팀', '김나래')->'cars') e")"
eq "board_cars: 지워진 운전자 번호는 그대로(화면이 '명단에 없음'으로 보여 줌)" "$GA" "$(anon "select board_cars('$CODE')->'cars'->0->>'driver'")"
eq "다른 사람 뽑기는 그대로 됨" "ok" "$(oneof "$(anon "select pick_car('시험3팀', '김도윤')")" car1 car2)"
has "그대로 저장하면 거절(운전자를 다시 고르게)" '"1호차" 의 운전자가 명단에 없어요' "$(anon "select admin_set_cars('$CODE', '$(sql "select value from config where key = 'cars'")')")"
eq "운전자를 빼고 저장하면 됨" "" "$(cars2 '"seats":4' '"seats":4')"

title "자동 정원(반씩): 정원을 비운 차량"
sql "select t.seed(10)" >/dev/null
eq "처음 값과 같은 목록(정원 없음) 저장" "" "$(cars2 '' '')"
SA="car_state('시험1팀', '김가람')"
eq "명단 10명 → 5·5, auto true" "5:true,5:true" "$(anon "select string_agg((e->>'seats') || ':' || (e->>'auto'), ',') from json_array_elements($SA->'cars') e")"
eq "board_cars 도 5·5, auto true" "5:true,5:true" "$(anon "select string_agg((e->>'seats') || ':' || (e->>'auto'), ',') from json_array_elements(board_cars('$CODE')->'cars') e")"
sql "select admin_set_car('$CODE', id, 'car1') from people where id in (select id from people order by id limit 5)" >/dev/null
has "자동 정원이 찬 차량에 넣으면 정원 숫자와 함께 거절" "ERROR:  그 차량은 자리가 다 찼어요(정원 5명)." "$(anon "select admin_set_car('$CODE', $(nth_id 0), 'car1')")"
sql "select t.add_people(1)" >/dev/null
eq "명단이 11명이 되면 6·6(다음 계산에 바로 반영)" "6,6" "$(anon "select string_agg(e->>'seats', ',') from json_array_elements($SA->'cars') e")"
eq "그래서 이제 넣을 수 있음" "" "$(anon "select admin_set_car('$CODE', $(nth_id 0), 'car1')")"
D1=$(nth_id 1)
has "운전자 1명 지정 → 손님 10명 → 정원 5·5 인데 1호차는 이미 6명이라 저장 거절" '"1호차" 은(는) 정원 5명인데 6명이 타 있어요(1명 넘어요)' "$(cars2 "\"driver\":$D1" '')"
eq "거절됐으니 정원 6·6 그대로" "6,6" "$(anon "select string_agg(e->>'seats', ',') from json_array_elements($SA->'cars') e")"
# 정원보다 많이 탄 차량은 명단에서 사람을 지울 때 생길 수 있음(차량 목록 저장으로는 못 만듦)
anon "select admin_remove('$CODE', $(sql "select id from people where car is null and id <> $D1 order by id desc limit 1"))" >/dev/null
eq "명단에서 1명 지움 → 10명 → 5·5 (1호차는 이미 6명: 정원보다 많아도 오류 없음)" "5,5/6" "$(anon "select string_agg(e->>'seats', ',') from json_array_elements($SA->'cars') e")/$(sql "select count(*) from people where car = 'car1'")"
eq "1호차는 더 뽑히지 않음(남은 손님은 모두 2호차)" "4" "$(pick_rest)"
eq "결과 6·4(정원보다 많이 탄 1호차는 그대로)" "car1:6,car2:4,none:0" "$(sql "select t.counts()")"
has "이때 2호차에 숫자 정원 99 → 1호차 자동 정원 0 이 되므로 거절" '"1호차" 은(는) 정원 0명인데 6명이 타 있어요(6명 넘어요)' "$(cars2 '' '"seats":99')"
sql "select admin_clear_cars('$CODE')" >/dev/null
eq "정원 1~99: 99 저장됨(비운 뒤)" "" "$(cars2 '"seats":99' '')"
eq "정원 적은 99 + 자동 → 자동 차량 정원 0(오류 없음)" "99:false,0:true" "$(anon "select string_agg((e->>'seats') || ':' || (e->>'auto'), ',') from json_array_elements($SA->'cars') e")"
eq "정원 0 인 자동 차량은 뽑히지 않음(10명 모두 1호차)" "car1:10,car2:0,none:0" "$(pick_rest >/dev/null; sql "select t.counts()")"
has "정원 적은 차량이 '탄 인원보다 작게' 거절(숫자 정원은 기존 문구)" '"1호차" 의 정원(5명)이 지금 탄 인원(10명)보다 적어요' "$(cars2 '"seats":5' '')"
has "자동으로 바꿔도 정원(5)이 탄 인원(10)보다 작아지면 거절" '"1호차" 은(는) 정원 5명인데 10명이 타 있어요(5명 넘어요)' "$(cars2 '' '')"

title "자동 정원: 운전자 2 + 손님 28(짝수), 전원 뽑기 300번"
sql "select t.seed(30)" >/dev/null
D1=$(nth_id 0); D2=$(nth_id 1)
cars2 "\"driver\":$D1" "\"driver\":$D2" >/dev/null
eq "정원 14·14(운전자 2명은 빼고 셈)" "14,14" "$(anon "select string_agg(e->>'seats', ',') from json_array_elements(car_state('시험1팀', '김가람')->'cars') e")"
sql "call t.all_rounds(300)" >/dev/null; r=$(sql "select t.rounds_summary()")
eq "300번 모두 14·14, 못 탄 손님·정원 초과·오류·운전자 배정 0" "maxdiff:0,unassigned:0,overfull:0,errors:0,drvcar:0,more1:0,more2:0,equal:300" "$r"

title "자동 정원: 운전자 2 + 손님 29(홀수), 전원 뽑기 1000번"
sql "select t.seed(31)" >/dev/null
D1=$(nth_id 0); D2=$(nth_id 1)
cars2 "\"driver\":$D1" "\"driver\":$D2" >/dev/null
eq "정원 15·15" "15,15" "$(anon "select string_agg(e->>'seats', ',') from json_array_elements(car_state('시험1팀', '김가람')->'cars') e")"
sql "call t.all_rounds(1000)" >/dev/null; r=$(sql "select t.rounds_summary()")
echo "  ($r)"
eq "1000번 모두 차이 1명, 못 탄 손님·정원 초과·오류·운전자 배정 0, 같은 경우 없음" "maxdiff:1,unassigned:0,overfull:0,errors:0,drvcar:0,equal:0" \
  "$(echo "$r" | tr ',' '\n' | grep -v '^more' | paste -sd, -)"
m1=$(echo "$r" | tr ',' '\n' | grep '^more1:' | cut -d: -f2); m2=$(echo "$r" | tr ',' '\n' | grep '^more2:' | cut -d: -f2)
chi_check "1명 많은 차량이 1호차인 비율" "car1:$m1,car2:$m2" 0.5 car1

title "자동 정원: 한 사람이 첫 번째·마지막 차례로 뽑을 때 각 2000번(운전자 2 + 손님 29)"
r=$(sql "select t.first_pick(2000)")
chi_check "첫 번째 차례" "$r" 0.5 car1
sql "call t.last_pick(2000)" >/dev/null; r=$(sql "select t.picks_summary()")
chi_check "마지막 차례(나머지 30명이 먼저 뽑은 뒤)" "$r" 0.5 car1

title "자동 정원: 운전자 2 + 손님 29 가 한꺼번에 뽑기(3번 되풀이)"
for round in 1 2 3; do
  sql "select admin_clear_cars('$CODE')" >/dev/null
  rm -f "$OUT"/ac$round-*
  gate_hold 31 || exit 1
  sql "select id || ' ' || dept || ' ' || name from people order by id" >"$OUT/list.txt"
  while read -r id d n; do worker_pick "ac$round-$id" "$d" "$n" & done <"$OUT/list.txt"
  wait
  collect "ac$round-"
  echo "  [${round}회] 응답 ${R_N}개, 빈자리 없음 ${FULL_N}명, 경쟁 구간 ${SPAN_MS}ms, 차량별 $(sql "select t.counts()")"
  eq "[${round}회] 31명 모두 응답(손님 29 + 운전자 2), 오류 0" "31/0/" "$R_N/$FULL_N/$OTHER_ERR"
  eq "[${round}회] 손님 29명 모두 배정, 차이 1명 이내, 정원 초과 0" "29/t/0" \
    "$(sql "select count(*) from people where car is not null")/$(sql "select abs(count(*) filter (where car = 'car1') - count(*) filter (where car = 'car2')) <= 1 from people")/$(sql "select t.overfull()")"
done

title "뽑는 도중 명단이 바뀜"
# 사람 더하기: 운전자 2 + 손님 20, 12명이 뽑은 뒤 5명을 더하고 나머지 전원 → 손님 25명 → 13·12 (20번)
bad_add=0
for i in $(seq 1 20); do
  sql "select t.seed(22)" >/dev/null
  cars2 "\"driver\":$(nth_id 0)" "\"driver\":$(nth_id 1)" >/dev/null
  sql "select count(*) from (select pick_car(dept, name) from people where id <> all (t.drivers()) order by random() limit 12) s" >/dev/null
  sql "select t.add_people(5)" >/dev/null
  pick_rest >/dev/null
  res=$(sql "select count(*) filter (where car is not null) || '/' || (abs(count(*) filter (where car = 'car1') - count(*) filter (where car = 'car2')) <= 1) from people")/$(sql "select t.overfull()")
  [ "$res" = "25/true/0" ] || { bad_add=$((bad_add + 1)); echo "    더하기 $i회: $res $(sql "select t.counts()")"; }
done
eq "도중에 5명 더해도 20번 모두 25명 배정·차이 1명 이내·정원 초과 0" "0" "$bad_add"
# 안 뽑은 사람 지우기(어느 차량도 새 정원보다 많이 타 있지 않을 때): 운전자 2 + 손님 28, 10명이 뽑은 뒤 안 뽑은 4명을 지움 → 정원 12·12 → 끝나면 12·12 (20번)
bad_del=0
for i in $(seq 1 20); do
  sql "select t.seed(30)" >/dev/null
  cars2 "\"driver\":$(nth_id 0)" "\"driver\":$(nth_id 1)" >/dev/null
  sql "select count(*) from (select pick_car(dept, name) from people where id <> all (t.drivers()) order by random() limit 10) s" >/dev/null
  sql "select admin_remove('$CODE', id) from people where id in (select id from people where car is null and id <> all (t.drivers()) order by random() limit 4)" >/dev/null
  pick_rest >/dev/null
  res=$(sql "select t.counts()")
  [ "$res" = "car1:12,car2:12,none:2" ] || { bad_del=$((bad_del + 1)); echo "    지우기 $i회: $res"; }
done
eq "10명 뽑은 뒤 안 뽑은 4명을 지워도 20번 모두 12·12" "0" "$bad_del"
# 지우기 때문에 어긋나는 경우(정확히 확인): 운전자 2 + 손님 28(정원 14·14), 1호차 14명·2호차 2명이 탄 뒤 안 뽑은 4명을 지움
sql "select t.seed(30)" >/dev/null
cars2 "\"driver\":$(nth_id 0)" "\"driver\":$(nth_id 1)" >/dev/null
sql "select admin_set_car('$CODE', id, case when rn <= 14 then 'car1' else 'car2' end) from (select id, row_number() over (order by id) rn from people where id <> all (t.drivers()) order by id limit 16) s" >/dev/null
sql "select admin_remove('$CODE', id) from people where id in (select id from people where car is null and id <> all (t.drivers()) order by id limit 4)" >/dev/null
eq "지운 뒤 정원 12·12, 1호차는 이미 14명(정원 초과 1대지만 오류 없음)" "12,12/car1:14,car2:2,none:10/1" \
  "$(anon "select string_agg(e->>'seats', ',') from json_array_elements(car_state('시험1팀', '김가람')->'cars') e")/$(sql "select t.counts()")/$(sql "select t.overfull()")"
eq "나머지 8명은 모두 2호차 → 끝나면 14·10(차이 4: 지우기 전에 1호차에 탄 사람 때문)" "8/car1:14,car2:10,none:2" "$(pick_rest)/$(sql "select t.counts()")"
# 탄 사람을 지운 경우: 14·14 다 탄 뒤 2호차 손님 2명을 지움 → 14·12(뽑을 사람이 없어 그대로). 2명을 더하면 그 둘은 2호차로 → 14·14
sql "select t.seed(30)" >/dev/null
cars2 "\"driver\":$(nth_id 0)" "\"driver\":$(nth_id 1)" >/dev/null
pick_rest >/dev/null
sql "select admin_remove('$CODE', id) from people where id in (select id from people where car = 'car2' order by id limit 2)" >/dev/null
eq "2호차 손님 2명을 지우면 14·12, 정원 13·13(1호차 초과지만 오류 없음)" "car1:14,car2:12,none:2/13,13" "$(sql "select t.counts()")/$(anon "select string_agg(e->>'seats', ',') from json_array_elements(board_cars('$CODE')->'cars') e")"
sql "select t.add_people(2)" >/dev/null
eq "2명을 더해 뽑으면 둘 다 2호차 → 14·14" "2/car1:14,car2:14,none:2" "$(pick_rest)/$(sql "select t.counts()")"

title "정원 적은 차량 + 자동 차량, 운전자 미지정 차량이 섞임"
sql "select t.seed(20)" >/dev/null
sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":5,\"driver\":$(nth_id 0)},{\"id\":\"car2\",\"name\":\"2호차\"},{\"id\":\"car3\",\"name\":\"3호차\"}]')" >/dev/null
eq "손님 19명: 1호차 5(적음), 자동 2대는 ceil(14/2) = 7·7" "5:false,7:true,7:true" "$(anon "select string_agg((e->>'seats') || ':' || (e->>'auto'), ',') from json_array_elements(car_state('시험1팀', '김가람')->'cars') e")"
eq "운전자: 1호차만 있고 2·3호차는 null" "object,null,null" "$(anon "select string_agg(json_typeof(e->'driver'), ',') from json_array_elements(car_state('시험1팀', '김가람')->'cars') e")"
eq "19명 모두 뽑힘, 정원 초과 0" "19/0" "$(pick_rest)/$(sql "select t.overfull()")"
sql "select t.seed(21)" >/dev/null
cars2 "\"driver\":$(nth_id 0)" '' >/dev/null
eq "1호차만 운전자 지정(손님 20명) → 10·10" "10,10" "$(anon "select string_agg(e->>'seats', ',') from json_array_elements(car_state('시험1팀', '김가람')->'cars') e")"
sql "call t.all_rounds(200)" >/dev/null; r=$(sql "select t.rounds_summary()")
eq "전원 뽑기 200번 모두 10·10, 오류 0" "maxdiff:0,unassigned:0,overfull:0,errors:0,drvcar:0,more1:0,more2:0,equal:200" "$r"

title "세 번째 Run: 운전자·문구·자동 정원 유지, 예전 모양 car_list 는 바뀜"
sql "select t.seed(8)" >/dev/null
cars2 "\"driver\":$(nth_id 0)" '"seats":3' >/dev/null
pick_rest >/dev/null
before_cars=$(sql "select value from config where key = 'cars'")
before_people=$(sql "select string_agg(id || '/' || coalesce(car, '-') || '/' || coalesce(car_at::text, '-'), ',' order by id) from people")
# 예전 모양 car_list(운전자·문구 칸 없음)를 일부러 만들어 둔다
sql "drop function public.car_list(); create function public.car_list() returns table (ord int, id text, name text, seats int) language sql as 'select 1, ''x''::text, ''x''::text, 1'" >/dev/null
if run_file "$SQL_FILE" "$OUT/run3.log"; then ok "supabase.sql 세 번째 Run(예전 car_list 가 있어도) 오류 없음"; else ng "supabase.sql 세 번째 Run" "$(tail -5 "$OUT/run3.log")"; fi
run_file "$HERE/car_db_helpers.sql" "$OUT/helpers3.log" || { ng "시험 보조 함수(세 번째)" "$(cat "$OUT/helpers3.log")"; exit 1; }
eq "car_list 가 새 모양(driver 칸 있음)" "t" "$(sql "select 'driver' = any (proargnames) from pg_proc where oid = 'public.car_list()'::regprocedure")"
eq "anon 은 여전히 car_list 못 부름" "permission denied for function car_list" "$(anon "select * from car_list()" | grep -o 'permission denied for function car_list')"
eq "세 번째 Run 뒤 차량 목록(운전자·문구·정원) 유지" "$before_cars" "$(sql "select value from config where key = 'cars'")"
eq "세 번째 Run 뒤 뽑은 차량 유지" "$before_people" "$(sql "select string_agg(id || '/' || coalesce(car, '-') || '/' || coalesce(car_at::text, '-'), ',' order by id) from people")"

# ── 기록(people_log 트리거) ───────────────────────────────
title "people_log 에 차량 변경 기록"
sql "select t.seed(4)" >/dev/null
set_cars_44
c=$(anon "select pick_car('시험1팀', '김가람')")
eq "pick_car 가 남긴 기록: 바뀌기 전 car = null, 그 사람 줄" "1/true" "$(sql "select count(*) || '/' || bool_and(old->>'car' is null and old->>'name' = '김가람') from people_log where op = 'UPDATE'")"
eq "기록에 car·car_at 칸도 들어 있음" "t" "$(sql "select bool_and(old ? 'car' and old ? 'car_at') from people_log where op = 'UPDATE'")"
anon "select admin_clear_cars('$CODE')" >/dev/null
eq "admin_clear_cars 도 기록(바뀌기 전 car = $c)" "$c" "$(sql "select old->>'car' from people_log where op = 'UPDATE' order by at desc, ctid desc limit 1")"

# ── 권한 ──────────────────────────────────────────────────
title "권한: anon 은 표를 직접 못 읽고, 관리자 함수는 비밀번호 없이 못 씀"
has "anon: people 읽기 막힘" "permission denied for table people" "$(anon "select * from people")"
has "anon: config 읽기 막힘" "permission denied for table config" "$(anon "select * from config")"
has "anon: people_log 읽기 막힘" "permission denied for table people_log" "$(anon "select * from people_log")"
has "anon: people.car 고치기 막힘" "permission denied for table people" "$(anon "update people set car = 'car1'")"
has "anon: 안쪽 함수 car_list 막힘" "permission denied for function car_list" "$(anon "select * from car_list()")"
has "anon: 안쪽 함수 car_check 막힘" "permission denied for function car_check" "$(anon "select car_check('[]')")"
has "anon: 안쪽 함수 car_caps 막힘" "permission denied for function car_caps" "$(anon "select * from car_caps()")"
has "anon: 안쪽 함수 car_caps_of 막힘" "permission denied for function car_caps_of" "$(anon "select * from car_caps_of('[]')")"
has "authenticated: people 읽기 막힘" "permission denied for table people" "$(authd "select * from people")"
has "authenticated: car_list 막힘" "permission denied for function car_list" "$(authd "select * from car_list()")"
eq "anon·authenticated 는 참가자 함수 2개 실행 가능" "t" "$(sql "select bool_and(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated']) r, unnest(array['public.pick_car(text, text)', 'public.car_state(text, text)']) f")"
eq "PUBLIC(다른 역할)은 새 함수 6개 모두 실행 못 함" "f" "$(sql "select bool_or(has_function_privilege('nobody_test', f, 'execute')) from unnest(array['public.pick_car(text, text)', 'public.car_state(text, text)', 'public.board_cars(text)', 'public.admin_set_car(text, bigint, text)', 'public.admin_clear_cars(text)', 'public.admin_set_cars(text, jsonb)', 'public.car_list()', 'public.car_check(jsonb)', 'public.car_caps()', 'public.car_caps_of(jsonb)']) f")"
for f in "board_cars(null)" "board_cars('')" "admin_set_car(null, 1, 'car1')" "admin_clear_cars(null)" "admin_set_cars(null, '[{\"id\":\"a\",\"name\":\"가\",\"seats\":4}]')"; do
  has "anon: $f → 비밀번호 틀림" "ERROR:  관리자 비밀번호가 틀렸어요." "$(anon "select $f")"
done
eq "authenticated 도 pick_car 됨" "ok" "$(oneof "$(authd "select pick_car('시험2팀', '김나래')")" car1 car2)"
eq "새 함수는 모두 security definer + search_path 고정(안쪽 함수 제외)" "6/6" "$(sql "select count(*) filter (where prosecdef and proconfig::text like '%search_path=public%') || '/' || count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('pick_car', 'car_state', 'board_cars', 'admin_set_car', 'admin_clear_cars', 'admin_set_cars')")"

# ── 기존 기능 회귀 ─────────────────────────────────────────
title "기존 기능(로그인·팀 뽑기·방 뽑기·조식·점심·자유시간 등)이 차량 추가 뒤에도 그대로"
sql "select t.seed(12)" >/dev/null
set_cars_44
eq "departments()" "시험1팀,시험2팀,시험3팀" "$(anon "select string_agg(d, ',' order by d) from departments() d")"
eq "login() 열쇠 그대로(차량 칸 안 늘어남)" "activity,dept,lunch,menu,name,room,team" "$(anon "select string_agg(k, ',' order by k) from json_object_keys(login('시험1팀', '김가람')) k")"
eq "login() 없는 사람 null" "t" "$(anon "select login('시험1팀', '없는사람') is null")"
team=$(anon "select pick('시험1팀', '김가람')")
eq "pick() 팀 뽑기" "ok" "$(oneof "$team" red blue yellow green)"
eq "pick() 다시 눌러도 같은 팀" "$team" "$(anon "select pick('시험1팀', '김가람')")"
room=$(anon "select pick_room('시험1팀', '김가람')")
eq "pick_room() 남자 방" "ok" "$(oneof "$room" m1 m2 m3 m4 m5)"
room2=$(anon "select pick_room('시험2팀', '김나래')")
eq "pick_room() 여자 방" "ok" "$(oneof "$room2" f1 f2)"
# 조식·점심·자유시간은 마감(choices_closed(), 11/25 15시) 전까지 고르고 바꿀 수 있고, 마감 뒤에는 서버가 거절한다(main 의 규칙).
# 시험을 마감 뒤에 돌려도 맞게, 지금 마감인지 보고 기대값을 고른다
if [ "$(sql "select choices_closed()")" = "f" ]; then
  eq "choose_menu()" "miyeok" "$(anon "select choose_menu('시험1팀', '김가람', 'miyeok')")"
  eq "choose_menu() 마감 전에는 바꿀 수 있음" "ugeoji" "$(anon "select choose_menu('시험1팀', '김가람', 'ugeoji')")"
  eq "choose_lunch()" "spicy" "$(anon "select choose_lunch('시험1팀', '김가람', 'spicy')")"
  eq "choose_activity()" "ski" "$(anon "select choose_activity('시험1팀', '김가람', 'ski')")"
else
  has "choose_menu() 마감 뒤 거절" "까지만 고르고 바꿀 수 있어요" "$(anon "select choose_menu('시험1팀', '김가람', 'miyeok')")"
  sql "update people set menu = 'ugeoji', lunch = 'spicy', activity = 'ski' where name = '김가람'" >/dev/null
fi
car=$(anon "select pick_car('시험1팀', '김가람')")
eq "login() 결과가 차량 뽑기 뒤에도 같음" "$team/ugeoji/$room/ski/spicy" "$(anon "select (j->>'team') || '/' || (j->>'menu') || '/' || (j->>'room') || '/' || (j->>'activity') || '/' || (j->>'lunch') from login('시험1팀', '김가람') j")"
eq "team_members()" "김가람" "$(anon "select string_agg(e->>'name', ',') from json_array_elements(team_members('시험1팀', '김가람')) e")"
eq "board() 명단 전원" "12" "$(anon "select json_array_length(board('$CODE'))")"
eq "board_state() 열쇠 그대로" "people,schedule" "$(anon "select string_agg(k, ',' order by k) from json_object_keys(board_state('$CODE')) k")"
anon "select admin_set('$CODE', 'schedule', '시험 일정')" >/dev/null
eq "admin_set()·schedule()" "시험 일정" "$(anon "select schedule('시험1팀', '김가람')")"
anon "select admin_reset_all('$CODE')" >/dev/null
eq "admin_reset_all()(팀·조식 지움)은 차량을 건드리지 않음" "/$car" "$(sql "select coalesce(team, '') || '/' || car from people where name = '김가람'")"
anon "select admin_clear('$CODE', 'room')" >/dev/null
eq "admin_clear('room')은 차량을 건드리지 않음" "$car" "$(sql "select car from people where name = '김가람'")"
anon "select admin_clear('$CODE', 'lunch')" >/dev/null
eq "admin_clear('lunch')은 차량을 건드리지 않음" "/$car" "$(sql "select coalesce(lunch, '') || '/' || car from people where name = '김가람'")"
ID=$(sql "select id from people where name = '김가람'")
anon "select admin_update('$CODE', $ID, '{\"dept\":\"시험1팀\",\"name\":\"김가람\",\"title\":\"과장\",\"gender\":\"남\"}')" >/dev/null
eq "admin_update()은 차량을 건드리지 않음" "$car" "$(sql "select car from people where id = $ID")"
anon "select admin_remove('$CODE', $ID)" >/dev/null
eq "admin_remove() 뒤 그 사람 자리가 빔" "0" "$(sql "select count(*) from people where car = '$car'")"

# ── admin_set_cars: 새 목록으로 계산한 정원이 탄 인원보다 작아지면 거절 ──
title "admin_set_cars: 자동 정원이 줄어 탄 인원보다 작아지는 저장은 거절(어느 차량이 몇 명 넘는지)"
sql "select t.seed(12)" >/dev/null
sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\"},{\"id\":\"car2\",\"name\":\"2호차\"}]')" >/dev/null
eq "명단 12명·운전자 없음 → 정원 6·6" "6,6" "$(sql "select string_agg(seats::text, ',' order by ord) from car_caps()")"
# 운전자가 될 2명(id 가 가장 큰 둘)은 빼고, 1호차에 6명·2호차에 2명
sql "select admin_set_car('$CODE', id, 'car1') from (select id from people order by id limit 6) x" >/dev/null
sql "select admin_set_car('$CODE', id, 'car2') from (select id from people order by id offset 6 limit 2) x" >/dev/null
D1=$(sql "select id from people order by id desc limit 1"); D2=$(sql "select id from people order by id desc offset 1 limit 1")
BEFORE=$(sql "select value from config where key = 'cars'")
WITH_DRV="[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$D1},{\"id\":\"car2\",\"name\":\"2호차\",\"driver\":$D2}]"
has "재현: 1호차 6명 뒤 운전자 2명 지정 → 정원 5·5 라 거절" \
  'ERROR:  이대로 저장하면 정원보다 많이 탄 차량이 생겨요: "1호차" 은(는) 정원 5명인데 6명이 타 있어요(1명 넘어요). 먼저 직접 옮기기로 그 차량의 사람을 옮기거나 비워 주세요.' \
  "$(anon "select admin_set_cars('$CODE', '$WITH_DRV')")"
eq "거절된 뒤 목록 그대로" "$BEFORE" "$(sql "select value from config where key = 'cars'")"
has "다른 차량에 숫자 정원(2호차 8) → 1호차 자동 정원 4 라 거절" '"1호차" 은(는) 정원 4명인데 6명이 타 있어요(2명 넘어요)' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\"},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":8}]')")"
has "자동 차량 더하기(3대 → 정원 4·4·4) → 거절" '"1호차" 은(는) 정원 4명인데 6명이 타 있어요(2명 넘어요)' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\"},{\"id\":\"car2\",\"name\":\"2호차\"},{\"id\":\"car3\",\"name\":\"3호차\"}]')")"
sql "select admin_set_car('$CODE', id, 'car2') from (select id from people order by id offset 8 limit 2) x" >/dev/null
has "두 차량이 함께 넘으면 둘 다 알려 줌(운전자 2 + 3호차 숫자 정원 4 → 자동 3·3, 1호차 6·2호차 4)" \
  '"1호차" 은(는) 정원 3명인데 6명이 타 있어요(3명 넘어요), "2호차" 은(는) 정원 3명인데 4명이 타 있어요(1명 넘어요)' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$D1},{\"id\":\"car2\",\"name\":\"2호차\",\"driver\":$D2},{\"id\":\"car3\",\"name\":\"3호차\",\"seats\":4}]')")"
eq "지금 1호차 6명·2호차 4명" "car1:6,car2:4,none:2" "$(sql "select t.counts()")"
has "숫자 정원 둘(4·4) → 1호차 2명 넘음(숫자 정원은 기존 문구)" '"1호차" 의 정원(4명)이 지금 탄 인원(6명)보다 적어요.' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"seats\":4},{\"id\":\"car2\",\"name\":\"2호차\",\"seats\":4}]')")"
sql "select admin_set_car('$CODE', id, 'car2') from (select id from people where car = 'car1' order by id desc limit 1) x" >/dev/null

eq "1호차 5·2호차 5 로 맞춘 뒤" "car1:5,car2:5,none:2" "$(sql "select t.counts()")"
anon "select admin_set_cars('$CODE', '$WITH_DRV')" >/dev/null
eq "인원을 맞추면 운전자 지정 저장됨(정원 5·5)" "5,5/$D1" "$(sql "select string_agg(seats::text, ',' order by ord) from car_caps()")/$(sql "select value::jsonb->0->>'driver' from config where key = 'cars'")"
# 이미 넘어 있던 차량(명단에서 사람을 지움): 정원이 더 줄지 않는 저장(문구 고치기)은 됨, 더 줄이는 저장은 거절
sql "select admin_set_car('$CODE', id, null) from (select id from people where car = 'car2' order by id limit 2) x" >/dev/null
sql "select admin_remove('$CODE', id) from (select id from people where car is null and id not in ($D1, $D2) order by id limit 2) x" >/dev/null
eq "사람 2명을 지우면 정원 4·4, 1호차는 5명(이미 1명 넘음)" "4,4/car1:5,car2:3,none:2" "$(sql "select string_agg(seats::text, ',' order by ord) from car_caps()")/$(sql "select t.counts()")"
anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"label\":\"가온님 차량\",\"driver\":$D1},{\"id\":\"car2\",\"name\":\"2호차\",\"driver\":$D2}]')" >/dev/null
eq "이미 넘어 있어도 정원이 그대로인 저장(문구만)은 됨" "가온님 차량" "$(sql "select value::jsonb->0->>'label' from config where key = 'cars'")"
has "이미 넘은 차량의 정원을 더 줄이는 저장(차량 더하기 → 3·3·3… ceil(8/3)=3)은 거절" '"1호차" 은(는) 정원 3명인데 5명이 타 있어요(2명 넘어요)' \
  "$(anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$D1},{\"id\":\"car2\",\"name\":\"2호차\",\"driver\":$D2},{\"id\":\"car3\",\"name\":\"3호차\"}]')")"
eq "car_caps 와 car_caps_of(저장된 목록) 계산이 같음" "$(sql "select string_agg(id || ':' || seats, ',' order by ord) from car_caps()")" "$(sql "select string_agg(id || ':' || seats, ',' order by ord) from car_caps_of((select value::jsonb from config where key = 'cars'))")"

# ── 마감(choices_closed) 전·후 ─────────────────────────────
# 시험 안에서만 choices_closed() 의 '마감 시각'을 t.deadline 표의 값으로 바꿔 쓴다. 판단 방식(now() >= 마감 시각, now() = 요청이 시작된 시각)은
# supabase.sql 과 같게 둔다. 끝나면 supabase.sql 의 원래 정의로 되돌린다(supabase.sql 의 마감 시각은 건드리지 않음).
title "마감 전·후: 안 뽑은 사람 거절, 이미 뽑은 사람·운전자 그대로, 진행자는 계속"
sql "create table if not exists t.deadline (d timestamptz); delete from t.deadline; insert into t.deadline values (now() + interval '1 day')" >/dev/null
sql "create or replace function public.choices_closed() returns boolean language sql stable as \$\$ select now() >= (select d from t.deadline limit 1) \$\$" >/dev/null
closed_on()  { sql "update t.deadline set d = now() - interval '1 hour'" >/dev/null; }   # 마감 지남
closed_off() { sql "update t.deadline set d = now() + interval '1 day'" >/dev/null; }    # 마감 전
# 오류의 SQLSTATE 와 문구를 "코드|문구" 로(참가자 anon 으로 부름)
errof() { anon "do \$\$ begin perform $1; raise notice 'OK'; exception when others then raise notice '%|%', sqlstate, sqlerrm; end \$\$" | sed -n 's/^NOTICE:  //p'; }
CLOSED_MSG='탑승 차량 뽑기는 11월 25일(수) 15시에 마감됐어요. 차량은 진행자에게 말해 주세요.'
sql "select t.seed(12)" >/dev/null
DRV=$(idof 김가람)
sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$DRV},{\"id\":\"car2\",\"name\":\"2호차\"}]')" >/dev/null
# 마감 전
eq "마감 전: choices_closed() = f" "f" "$(sql "select choices_closed()")"
early=$(anon "select pick_car('시험2팀', '김나래')")
eq "마감 전: 뽑기 됨" "ok" "$(oneof "$early" car1 car2)"
# 마감 뒤
closed_on
eq "마감 뒤: choices_closed() = t" "t" "$(sql "select choices_closed()")"
eq "마감 뒤: 안 뽑은 사람은 거절(기존 고르기와 같은 코드 P0001)" "P0001|$CLOSED_MSG" "$(errof "pick_car('시험3팀', '김도윤')")"
LUNCH_ERR=$(errof "choose_lunch('시험3팀', '김도윤', 'plain')")
eq "점심 마감 거절도 같은 코드(P0001)" "P0001" "${LUNCH_ERR%%|*}"
# 화면이 마감 거절을 알아보는 common.js 의 CHOICE_CLOSED_ERR 로 두 문구를 직접 견줌
CLOSED_RE=$(sed -n 's/^const CHOICE_CLOSED_ERR = \/\(.*\)\/;.*/\1/p' "$ROOT/common.js")
eq "두 거절 문구 모두 common.js 의 CHOICE_CLOSED_ERR 에 맞음, 다른 오류는 안 맞음" "true,true,false" "$(node -e 'const re = new RegExp(process.argv[1]); console.log(process.argv.slice(2).map((m) => re.test(m)).join())' "$CLOSED_RE" "$CLOSED_MSG" "${LUNCH_ERR#*|}" '빈자리가 있는 차량이 없어요. 진행자에게 말해 주세요.')"
eq "마감 뒤: 거절된 사람은 차량 없음" "" "$(sql "select coalesce(car, '') from people where name = '김도윤'")"
eq "마감 뒤: 이미 뽑은 사람은 자기 차량 그대로" "$early" "$(anon "select pick_car('시험2팀', '김나래')")"
eq "마감 뒤: 운전자는 운전하는 차량 그대로" "car1" "$(anon "select pick_car('시험1팀', '김가람')")"
eq "마감 뒤: 차량 수는 그대로(1명)" "1" "$(sql "select count(*) from people where car is not null")"
S_YET="car_state('시험3팀', '김도윤')"
eq "마감 뒤: car_state 됨(안 뽑은 사람: car null, 차량 2대)" "null/2" "$(anon "select json_typeof($S_YET->'car') || '/' || json_array_length($S_YET->'cars')")"
eq "마감 뒤: car_state 됨(뽑은 사람: 자기 차량·같은 차 사람)" "$early/김나래" "$(anon "select (car_state('시험2팀', '김나래')->>'car') || '/' || (select string_agg(e->>'name', ',') from json_array_elements(car_state('시험2팀', '김나래')->'members') e)")"
eq "마감 뒤: car_state 됨(운전자)" "car1" "$(anon "select car_state('시험1팀', '김가람')->>'car'")"
# 진행자는 마감과 상관없이
YET=$(idof 김도윤)
anon "select admin_set_car('$CODE', $YET, 'car2')" >/dev/null
eq "마감 뒤: 진행자가 넣기 됨" "car2" "$(sql "select car from people where id = $YET")"
eq "마감 뒤: 진행자가 넣은 사람은 pick_car·car_state 로 그 차량을 받음" "car2/car2" "$(anon "select pick_car('시험3팀', '김도윤')")/$(anon "select $S_YET->>'car'")"
anon "select admin_set_car('$CODE', $YET, 'car1')" >/dev/null
eq "마감 뒤: 진행자가 옮기기 됨" "car1" "$(sql "select car from people where id = $YET")"
anon "select admin_set_car('$CODE', $YET, null)" >/dev/null
eq "마감 뒤: 진행자가 한 사람 비우기 됨" "" "$(sql "select coalesce(car, '') from people where id = $YET")"
eq "마감 뒤: 비운 사람은 다시 뽑지 못함(거절)" "P0001|$CLOSED_MSG" "$(errof "pick_car('시험3팀', '김도윤')")"
anon "select admin_clear_cars('$CODE')" >/dev/null
eq "마감 뒤: 진행자가 차량 모두 비우기 됨" "0" "$(sql "select count(*) from people where car is not null")"
anon "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"label\":\"가온님 차량\",\"driver\":$DRV},{\"id\":\"car2\",\"name\":\"2호차\"}]')" >/dev/null
eq "마감 뒤: 진행자가 차량 목록 저장 됨" "가온님 차량" "$(sql "select value::jsonb->0->>'label' from config where key = 'cars'")"
eq "마감 뒤: 비운 뒤에도 운전자는 자기 차량" "car1" "$(anon "select pick_car('시험1팀', '김가람')")"
closed_off
eq "마감을 되돌리면(시험용) 다시 뽑기 됨" "ok" "$(oneof "$(anon "select pick_car('시험3팀', '김도윤')")" car1 car2)"

title "마감 직전에 눌러 차례를 기다린 10명: 기다리는 사이 마감이 지나도 받아들여짐(누른 시각 기준, choose_lunch 등과 같음)"
sql "select t.seed(14)" >/dev/null
DRV=$(idof 김가람)
sql "select admin_set_cars('$CODE', '[{\"id\":\"car1\",\"name\":\"1호차\",\"driver\":$DRV},{\"id\":\"car2\",\"name\":\"2호차\"}]')" >/dev/null
closed_off
EARLY2=$(anon "select pick_car('시험2팀', '김나래')")
# 시험용 마감 시각을 지금부터 4초 뒤로
sql "update t.deadline set d = clock_timestamp() + interval '4 seconds'" >/dev/null
rm -f "$OUT"/dl-*
# 차례 잠금(261112, 3)을 먼저 쥔 세션: 10명이 그 잠금을 기다리면(이들의 요청은 마감 전에 시작됨) 마감 시각이 지날 때까지 더 쥐고 있다가 푼다
$PSQL -At -c "select pg_advisory_lock(261112, 3)" \
  -c "do \$\$ declare s timestamptz := clock_timestamp(); dl timestamptz := (select d from t.deadline); begin
        loop
          exit when (select count(*) from pg_locks where locktype = 'advisory' and classid = 261112 and objid = 3 and not granted) >= 10;
          if clock_timestamp() - s > interval '30 seconds' then raise exception '차례에 다 모이지 않음'; end if;
          perform pg_sleep(0.01);
        end loop;
        if clock_timestamp() >= dl then raise exception '마감 전에 10명이 다 모이지 못함(시험 무효)'; end if;
        perform pg_sleep(greatest(0, extract(epoch from dl - clock_timestamp())) + 0.3);
        raise notice '푸는 시각이 마감 뒤: %', clock_timestamp() > dl;
      end \$\$" \
  -c "select pg_advisory_unlock(261112, 3)" >"$OUT/dl-hold.log" 2>&1 &
i=0
while [ "$(sql "select count(*) from pg_locks where locktype = 'advisory' and classid = 261112 and objid = 3 and granted")" != "1" ]; do
  i=$((i + 1)); [ $i -gt 500 ] && { ng "차례 잠금을 쥐지 못함" "$(cat "$OUT/dl-hold.log")"; break; }
done
sql "select id || ' ' || dept || ' ' || name from people where car is null and id <> $DRV order by id limit 10" >"$OUT/list.txt"
while read -r id d n; do worker_pick "dl-$id" "$d" "$n" & done <"$OUT/list.txt"
worker_pick "dl-drv" "$(sql "select dept from people where id = $DRV")" "김가람" &
worker_pick "dl-early" "시험2팀" "김나래" &
wait
eq "잠금을 쥔 세션 오류 없음" "" "$(grep -i error "$OUT/dl-hold.log")"
has "잠금을 푼 것은 마감 시각 뒤" "푸는 시각이 마감 뒤: t" "$(cat "$OUT/dl-hold.log")"
eq "마감 전에 눌러 기다린 10명은 마감 뒤에 차례가 와도 모두 배정, 마감 거절 0" "10/0" "$(cat "$OUT"/dl-[0-9]*.out | grep -c '^R ')/$(cat "$OUT"/dl-[0-9]*.err | grep -c '에 마감됐어요')"
eq "운전자·이미 뽑은 사람은 기다리지 않고 자기 차량" "R car1/R $EARLY2" "$(grep '^R ' "$OUT/dl-drv.out")/$(grep '^R ' "$OUT/dl-early.out")"
eq "DB: 11명 배정(이미 뽑은 1 + 기다린 10)" "11" "$(sql "select count(*) from people where car is not null")"
eq "지금(마감 뒤) 새로 누른 사람은 거절" "P0001|$CLOSED_MSG" "$(errof "pick_car('$(sql "select dept from people where car is null and id <> $DRV order by id limit 1")', '$(sql "select name from people where car is null and id <> $DRV order by id limit 1")')")"

# 시험용 choices_closed() 를 supabase.sql 의 원래 정의로 되돌림
awk '/^create or replace function public.choices_closed\(\)/,/^\$\$;/' "$SQL_FILE" >"$OUT/choices_closed.sql"
run_file "$OUT/choices_closed.sql" "$OUT/choices_closed.log" && ok "choices_closed() 를 supabase.sql 의 정의로 되돌림" || ng "choices_closed() 되돌리기" "$(cat "$OUT/choices_closed.log")"
has "되돌린 choices_closed() 의 시각은 supabase.sql 그대로" "2026-11-25 15:00:00+09" "$(sql "select prosrc from pg_proc where proname = 'choices_closed'")"

# ── 결과 ──────────────────────────────────────────────────
echo
echo "════════════════════════════"
echo "통과 $PASS, 실패 $FAIL"
[ "$FAIL" -eq 0 ]
