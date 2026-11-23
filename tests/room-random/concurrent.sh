#!/bin/bash
# 시험용 DB 전용(rooms 를 비움). 사용: PGPORT=54339 tests/room-random/concurrent.sh [판 수] ['{"이름":"방"}']
# 29명 + 같은 사람 3명 중복을 서로 다른 연결로 동시에 pick_room. ROUNDS 번 반복. PRE 가 있으면 먼저 진행자가 넣은 상태로 시작.
ROUNDS=${1:-20}; PRE=$2; OUT=$(mktemp -d)
P=/opt/homebrew/bin/psql
q() { $P -h 127.0.0.1 -p ${PGPORT:-54339} -U postgres -d ws -tAq "$@"; }
LIST=$(q -F, -c "select dept||','||name from people where gender is not null")
bad=0
for r in $(seq 1 $ROUNDS); do
  q -c "update people set room = null where room is not null" 
  [ -n "$PRE" ] && q -c "update people p set room = e.value from jsonb_each_text('$PRE') e where p.name = e.key"
  rm -f $OUT/*.txt
  for dn in $LIST $(echo "$LIST" | head -3); do
    d=${dn%,*}; n=${dn#*,}
    ( q -c "select '$n', pick_room('$d','$n')" >> $OUT/$n.$RANDOM.txt 2>&1 ) &
  done
  wait
  # 돌려받은 방 == 저장된 방, 같은 사람 두 번이면 같은 방
  cat $OUT/*.txt | sort -u > $OUT/ret.$r
  q -F'|' -c "select name, room from people where room is not null and name in (select name from people where gender is not null)" | sort > $OUT/db.$r
  if ! diff <(grep -v '^$' $OUT/ret.$r | sort -u) <(grep -f <(cut -d'|' -f1 $OUT/ret.$r | sed 's/^/^/;s/$/|/') $OUT/db.$r) >/dev/null; then echo "round $r: 돌려받은 방과 저장된 방이 다름"; bad=$((bad+1)); fi
  n_ret=$(cut -d'|' -f1 $OUT/ret.$r | sort | uniq -d | wc -l | tr -d ' ')
  [ "$n_ret" != 0 ] && { echo "round $r: 한 사람이 다른 방 두 개를 받음"; bad=$((bad+1)); }
  grep -qv '^[A-Z0-9]*|[mf][1-5]$' $OUT/ret.$r && { echo "round $r: 오류 응답"; cat $OUT/ret.$r | grep -v '^[A-Z0-9]*|[mf][1-5]$'; bad=$((bad+1)); }
  q -F, -c "select string_agg(c::text, ',' order by room) from (select room, count(*) c from people where (gender='남' and room like 'm%') or (gender='여' and room like 'f%') group by room) x" >> $OUT/sizes
  q -c "select count(*) from people where gender is not null and room is null" | grep -qx 0 || { echo "round $r: 방 없는 사람이 남음"; bad=$((bad+1)); }
  q -c "select count(*) from people where room is not null and gender='남' and room like 'f%' and not ('$PRE' like '%\"'||name||'\":\"f%')" | grep -qx 0 || { echo "round $r: 남녀 섞임"; bad=$((bad+1)); }
done
echo "문제 $bad 판 / $ROUNDS 판"; sort $OUT/sizes | uniq -c
