// 발표용 뽑기 화면(draw.html). 진행자가 노트북을 프로젝터에 띄워 레크리에이션 팀 뽑기·방 배정 뽑기를 다 함께 본다.
//
// 배정 규칙은 DB 함수가 정한다: 팀은 pick(), 방은 pick_room(). 이 화면은 배정을 계산하지 않는다.
//   두 함수는 '부른 사람 한 명'의 결과만 저장하고(나머지는 계획만 세웠다 버림), 이미 정해진 사람에게는 그 결과를 그대로 돌려준다.
//   그래서 진행자가 한 사람씩 대신 부르는 것은 참가자들이 자기 휴대폰으로 하나씩 누르는 것과 똑같이 규칙을 지킨다.
//   이 화면이 정하는 것은 '다음에 누구를 부를지'(공개 순서)뿐이고, 그건 무작위다(배정 규칙과 상관없음).
// 같은 사람에게 요청이 두 번 가도(통신이 끊겨 다시 시도 등) 처음 정해진 팀·방이 돌아오므로 결과가 바뀌지 않는다.
// 연습 모드(?practice=1)는 DB 를 전혀 부르지 않는다(아래 practice).

// ── 바꾸기 쉬운 설정 ─────────────────────────────────────
const DRAW_CONFIG = {
  // 공개 방법 기본값. 'all' 전체 한 번에(기본: 한 번 누르면 룰렛이 돌며 남은 사람 전원을 저장하고, 끝나면 저절로 전체 결과)
  //   | 'group' 한 팀·한 방씩(누를 때마다 팀 하나·방 하나) | 'person' 한 명씩.  주소 ?unit=all · ?unit=group · ?unit=person 으로도 고름
  unit: 'all',
  // ── 전체 한 번에(룰렛) ──
  rouletteMinMs: 3500,     // 룰렛이 도는 최소 시간. 저장이 이보다 빨리 끝나도 이만큼은 돌아 기대감을 줌(29명 저장: 로컬 약 1초, 실제 약 3~9초)
  rouletteTickMs: 90,      // 룰렛이 도는 동안 이름·칸이 바뀌는 간격. 저장이 길어지면 진행 막대(n / 전체 명)가 차오르며 계속 돎(최대 시간은 저장이 끝날 때까지)
  rouletteLandMs: 1400,    // 저장이 끝난 뒤 룰렛이 점점 느려지다 멈추는 시간
  allHoldMs: 700,          // 멈춘 뒤 모든 팀(방) 칸이 한꺼번에 켜진 채 머무는 시간 → 그다음 저절로 전체 결과 화면
  nameSpinMs: 1800,        // 한 명씩: 이름이 섞이다 멈추기까지 걸리는 시간
  resultSpinMs: 1500,      // 한 명씩: 팀·방 돌림판이 도는 최소 시간(답이 늦으면 답이 올 때까지 계속 돎)
  pauseAfterName: false,   // true 면 이름이 멈춘 뒤 한 번 더 눌러야 팀·방이 돌아감(긴장감을 한 번 더)
  revealHoldMs: 800,       // 공개 직후 키를 받지 않는 시간(연타로 다음 사람이 바로 넘어가는 것을 막음)
  bulkStepMs: 350,         // '남은 사람 모두 공개' 때 한 사람 사이 간격
  groupMemberDelayMs: 160, // 한 팀·한 방씩: 이름이 하나씩 튀어나오는 간격
  sound: false,            // 소리 기본값(꺼짐). 화면의 소리 단추나 M 키로 켬
  confettiMs: 6000,        // 마지막 장면 꽃가루가 내리는 시간
  reducedSpinMs: 200,      // '움직임 줄이기'가 켜진 기기에서 섞는 시간(연출은 거의 없이 바로 결과)
  // 화면이 바뀐 직후 그 화면의 단추가 누름(클릭·Enter·Space)을 받지 않는 시간(ms). 앞 화면에서 두 번 누른 것이
  // 같은 자리에 새로 나타난 단추를 눌러 버리는 일을 막는다(예: '마지막 장면 보기'를 두 번 → '방 배정 뽑기로'가 눌림)
  // finaleAuto: 룰렛이 끝나 저절로 전체 결과로 넘어간 직후(이름이 칸에 채워지는 연출 약 2초 + 여유). 룰렛 중에 누르던 키·클릭이 '방 배정 뽑기로' 등을 누르지 않게
  // play: 시작 화면에서 '시작하기'를 Enter 로 두 번 누른 것이 곧바로 '뽑기 시작'(저장)으로 이어지지 않게
  screenGuardMs: { menu: 700, intro: 700, play: 600, finale: 1500, finaleAuto: 2800 },
};

(() => {
  // common.js 를 못 받았으면(통신 불안정·차단) 안내는 common.js 가 띄우고 여기서 멈춘다
  if (typeof rpc !== 'function' || typeof TEAMS === 'undefined') return;

  const C = DRAW_CONFIG;
  const params = new URLSearchParams(location.search);
  const PRACTICE = params.get('practice') === '1';
  const UNITS = ['all', 'group', 'person'];
  const UNIT_LABEL = { all: '전체 한 번에', group: '한 팀·한 방씩', person: '한 명씩' };
  const FINALE_KEY = 'draw-finale'; // 전체 한 번에: 전체 결과를 띄운 탭이면(sessionStorage) 새로 고쳐도 전체 결과로 다시 엶
  const CODE_KEY = 'team-picker-admin'; // board.html 과 같은 저장 키: 같은 기기에서 관리자 페이지에 들어갔으면 다시 묻지 않음
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const KINDS = {
    team: { label: '레크리에이션 팀 뽑기', unitWord: '팀', groups: TEAM_KEYS, done: '팀이 모두 정해졌어요!' },
    room: { label: '방 배정 뽑기', unitWord: '방', groups: ROOM_KEYS, done: '방 배정이 끝났어요!' },
  };
  const COLORS = { red: '#dc2626', blue: '#2563eb', yellow: '#facc15', green: '#15803d', m: '#0ea5e9', f: '#ec4899' }; // style.css·draw.css 와 같은 색
  const colorOf = (key) => (TEAMS[key] ? COLORS[key] : COLORS[key[0]]);
  const groupClass = (key) => (TEAMS[key] ? `team-${key}` : `room-${key[0]}`);
  const groupLabel = (key) => (TEAMS[key] ? `${TEAMS[key]} 팀` : ROOMS[key]);
  const shortLabel = (key) => (TEAMS[key] ? TEAMS[key] : ROOMS[key].replace(/^(남자|여자)\s*/, ''));
  // 공개 화면에는 부서를 보이지 않는다(이름만). 정렬도 눈에 보이는 이름순(이름이 같으면 부서순).
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko') || a.dept.localeCompare(b.dept, 'ko');
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }; // 같은 애니메이션을 다시 틀기
  // 방 뽑기는 성별이 있는 사람만 뽑을 수 있다(pick_room 이 거절). 성별이 없어도 진행자가 이미 방을 넣었으면 결과에는 나옴
  const eligible = (p, kind) => kind === 'team' || !!p.gender || !!p.room;
  const optionsFor = (p, kind) => (kind === 'team' ? TEAM_KEYS : ROOM_KEYS.filter((k) => roomGender(k) === p.gender));

  // ── 상태 ──────────────────────────────────────────────
  const S = {
    view: '',            // 보이는 화면: login · loading · menu · intro · play · finale
    phase: 'loading',    // 진행 단계(window.__draw.phase): login · loading · menu · intro · ready · spinning · named · reveal · saving · bulk · error · finale
    kind: null,          // 'team' | 'room'
    unit: UNITS.includes(params.get('unit')) ? params.get('unit') : UNITS.includes(C.unit) ? C.unit : 'all', // 'all' | 'group' | 'person'
    people: [],          // board_state 의 명단(연습 모드는 견본 명단의 복사본)
    shown: new Set(),    // 화면 결과판에 나온 사람 id
    order: [],           // 결과판에 나온 순서
    fresh: new Set(),    // 방금 공개된 사람 id(결과판에서 강조)
    queue: [],           // 아직 안 뽑은 사람 id(공개 순서 — 무작위)
    skipped: new Set(),  // 오류로 이번에 건너뛴 사람 id
    current: null,       // 지금 뽑는 사람
    pending: null,       // pauseAfterName 일 때 미리 보낸 요청
    last: null,          // 마지막 공개 { id, value } 또는 { group }
    groupList: [],       // 한 팀·한 방씩: 공개할 팀·방 순서
    groupIdx: -1,        // 한 팀·한 방씩: 마지막으로 공개한 순번
    busy: false,         // 연출 중·요청 중이면 true — 이때 누른 키는 무시(잠금)
    dialog: null,        // 열린 확인 상자: 'clear' | 'all' | null
    error: '',
    retry: null,         // 오류 때 '다시 시도'가 할 일(같은 사람으로)
    afterSkip: null,     // 오류 때 '건너뛰기' 뒤 할 일
    guardUntil: 0,       // 이 시각(performance.now)까지 지금 화면의 단추는 누름을 받지 않음(screenGuardMs)
    saveDone: 0,         // 전체 한 번에: 저장(팀·방이 정해진) 인원 — 진행 막대
    saveTotal: 0,        // 전체 한 번에: 뽑을 수 있는 전체 인원
  };
  const byId = (id) => S.people.find((p) => p.id === id);
  // 같은 이름인 사람(이 화면 명단 안에서 name 이 같음)에게만 부서를 붙여 구분한다. 그 밖의 사람은 어디서도 부서가 안 보인다.
  let dupMemo = { ref: null, names: new Set() };
  const dupNames = () => {
    if (dupMemo.ref !== S.people) {
      const n = new Map();
      for (const p of S.people) n.set(p.name.trim(), (n.get(p.name.trim()) || 0) + 1); // 앞뒤 공백만 다른 이름도 같은 이름
      dupMemo = { ref: S.people, names: new Set([...n].filter(([, c]) => c > 1).map(([k]) => k)) };
    }
    return dupMemo.names;
  };
  const isDup = (p) => dupNames().has(p.name.trim());
  const who = (p) => (isDup(p) ? `${p.name}(${p.dept})` : p.name); // 글·안내용: 같은 이름이면 이름(부서)
  const dupTag = (p) => (isDup(p) ? `<small class="dup">(${esc(p.dept)})</small>` : ''); // 칸 안: 이름 뒤 작은 글씨
  const lock = () => { S.busy = true; updateControls(); };
  const unlock = () => { S.busy = false; updateControls(); };

  // ── DB 호출(실제) ──────────────────────────────────────
  let code = PRACTICE ? null : store.get(CODE_KEY);
  const calls = { board_state: 0, pick: 0, pick_room: 0, admin_reset: 0, admin_clear: 0 }; // 시험용: 보낸 요청 수
  const live = {
    async state() {
      calls.board_state++;
      const d = await rpc('board_state', { p_code: code }); // 성공 = 관리자 비밀번호가 맞음
      if (!d || !Array.isArray(d.people)) throw new Error('명단을 제대로 받지 못했어요. 다시 해 주세요.');
      return d.people;
    },
    // 그 사람의 팀·방을 DB 가 정해 저장하고 돌려줌. 이미 정해졌으면 그 결과를 그대로 돌려줌(두 번 불러도 같음)
    async pick(kind, p, onRetry) {
      const fn = kind === 'team' ? 'pick' : 'pick_room';
      calls[fn]++;
      const v = await rpc(fn, { p_dept: p.dept, p_name: p.name }, { retry: 2, onRetry });
      if (!(kind === 'team' ? TEAMS : ROOMS)[v]) throw new Error('결과를 받지 못했어요. 다시 시도해 주세요.');
      return v;
    },
    // 모두 비우기: 팀은 admin_reset(전원) — 팀·뽑은 시각만 지우고 조식은 그대로. 방은 admin_clear('room')
    async clear(kind) {
      if (kind === 'team') { calls.admin_reset++; await rpc('admin_reset', { p_code: code, p_id: null }); }
      else { calls.admin_clear++; await rpc('admin_clear', { p_code: code, p_what: 'room' }); }
    },
  };

  // ── 연습 모드 ─────────────────────────────────────────
  // DB 를 전혀 부르지 않는다(읽기도 쓰기도). 누가 봐도 견본인 명단을 이 화면 메모리에만 두고, 새로고침하면 처음으로 돌아간다.
  // ⚠️ 아래 배정은 연출 리허설용 흉내일 뿐 실제 규칙이 아니다: '지금 인원이 가장 적은 팀·방 중 아무 데나'만 본다
  //    (실제 규칙은 DB 함수 pick·pick_room 에만 있다. 이 화면은 실제 뽑기에서 규칙을 계산하지 않는다).
  function makePracticePeople() {
    const men = ['토끼', '판다', '여우', '수달', '고래', '사자', '하마', '펭귄', '기린', '오리', '두더지', '너구리', '코알라', '미어캣', '알파카', '부엉이', '햄스터', '거북이', '다람쥐', '고슴도치'];
    const women = ['사과', '포도', '자두', '레몬', '키위', '망고', '딸기', '앵두', '복숭아'];
    const depts = ['연습부 가', '연습부 나', '연습부 다', '연습부 라', '연습부 마', '연습부 바'];
    let id = 0;
    const mk = (name, gender, i) => ({ id: ++id, dept: depts[i % depts.length], name: `견본 ${name}`, title: '견본', gender, is_exec: false, team: null, room: null });
    return [...men.map((n, i) => mk(n, '남', i)), ...women.map((n, i) => mk(n, '여', i + 2)), mk('감자', null, 3)]; // 감자: 성별 없음(방 뽑기에서 건너뜀)
  }
  const practice = {
    people: makePracticePeople(),
    async state() { await sleep(120); return practice.people.map((p) => ({ ...p })); },
    async pick(kind, p) {
      await sleep(60 + Math.random() * 140); // 실제 요청처럼 잠깐 기다림(전체 한 번에서 30명 저장이 3~4초쯤 걸리게)
      const me = practice.people.find((x) => x.id === p.id);
      if (!me) throw new Error('명단에 없는 부서·이름이에요.');
      if (me[kind]) return me[kind];
      if (kind === 'room' && !me.gender) throw new Error('명단에 성별이 없어 방을 뽑을 수 없어요. 진행자에게 말해 주세요.');
      const keys = optionsFor(me, kind);
      const count = (k) => practice.people.filter((x) => x[kind] === k).length;
      const min = Math.min(...keys.map(count));
      const best = keys.filter((k) => count(k) === min);
      me[kind] = best[Math.floor(Math.random() * best.length)];
      return me[kind];
    },
    async clear(kind) { await sleep(150); for (const p of practice.people) p[kind] = null; },
  };
  const api = PRACTICE ? practice : live;
  const isAuthErr = (e) => !PRACTICE && /비밀번호/.test(String(e && e.message));

  // ── 한 팀·한 방씩: 어디까지 공개했는지 ────────────────
  // 결과는 DB 에 있고, '몇 번째 팀(방)까지 화면에 공개했는지'만 이 기기에 둔다(연습 모드는 이 화면 메모리에만).
  // 지금 결과와 함께 저장해 두고(sig), 결과가 바뀌었으면(비우기·다시 뽑기·누가 더 뽑음 등) 버리고 첫 팀(방)부터 다시 공개한다.
  const REVEAL_KEY = 'draw-reveal';
  const practiceReveal = {};
  const groupsFor = (kind) => KINDS[kind].groups.filter((g) => S.people.some((p) => eligible(p, kind) && p[kind] === g)); // 사람이 있는 팀·방만, 정해진 순서로
  function resultSig(kind) {
    const t = S.people.filter((p) => eligible(p, kind) && p[kind]).map((p) => `${p.id}:${p[kind]}`).sort().join(',');
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    return `${kind}:${t.length}:${h}`;
  }
  function savedReveal(kind) { // 마지막으로 공개한 팀(방)의 순번. 모르거나 결과가 바뀌었으면 -1
    const r = PRACTICE ? practiceReveal[kind] : store.get(`${REVEAL_KEY}-${kind}`);
    return r && r.sig === resultSig(kind) && Number.isInteger(r.idx) ? r.idx : -1;
  }
  function saveReveal() {
    const r = { sig: resultSig(S.kind), idx: S.groupIdx, at: Date.now() };
    if (PRACTICE) practiceReveal[S.kind] = r; else store.set(`${REVEAL_KEY}-${S.kind}`, r);
  }

  // ── 소리(WebAudio 합성음, 기본 꺼짐) ──────────────────
  const sound = (() => {
    let on = !!C.sound;
    let ctx = null;
    const ac = () => {
      try {
        if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch { return null; }
    };
    const tone = (f, at, dur, type, vol) => {
      const a = ac();
      if (!a) return;
      const o = a.createOscillator();
      const g = a.createGain();
      const s = a.currentTime + at;
      o.type = type;
      o.frequency.setValueAtTime(f, s);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(vol, s + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
      o.connect(g).connect(a.destination);
      o.start(s);
      o.stop(s + dur + 0.03);
    };
    return {
      get on() { return on; },
      set(v) { on = !!v; if (on) ac(); },
      tick() { if (on) tone(1300 + Math.random() * 250, 0, 0.035, 'square', 0.025); },
      land() { if (on) tone(660, 0, 0.16, 'triangle', 0.1); },
      reveal() { if (on) [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.08, 0.4, 'triangle', 0.12)); },
      fanfare() { if (on) [[523.25, 0], [659.25, 0.14], [783.99, 0.28], [1046.5, 0.42], [783.99, 0.7], [1046.5, 0.84], [1318.5, 1.0]].forEach(([f, t]) => tone(f, t, 0.5, 'triangle', 0.13)); },
      oops() { if (on) tone(220, 0, 0.3, 'sawtooth', 0.05); },
    };
  })();

  // ── 꽃가루(캔버스) ────────────────────────────────────
  const confetti = (() => {
    const cv = $('#confetti');
    const ctx = cv.getContext && cv.getContext('2d');
    let parts = [];
    let raf = 0;
    let until = 0;
    let rainColors = [];
    let last = 0;
    const size = () => {
      const r = cv.getBoundingClientRect();
      const d = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(r.width * d);
      cv.height = Math.round(r.height * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      return r;
    };
    const piece = (x, y, vx, vy, color) => ({ x, y, vx, vy, color, rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 12,
      w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, round: Math.random() < 0.3, life: 0 });
    const frame = (t) => {
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      const r = cv.getBoundingClientRect();
      if (until && t < until) { // 위에서 계속 내림
        for (let i = 0; i < 4; i++) parts.push(piece(Math.random() * r.width, -10, (Math.random() - 0.5) * 80, 60 + Math.random() * 120, rainColors[Math.floor(Math.random() * rainColors.length)]));
      }
      ctx.clearRect(0, 0, r.width, r.height);
      parts = parts.filter((p) => p.y < r.height + 30 && p.life < 9);
      for (const p of parts) {
        p.life += dt;
        p.vy += 420 * dt;            // 중력
        p.vx *= 1 - 0.9 * dt;        // 공기 저항
        p.vy = Math.min(p.vy, 260);
        p.x += p.vx * dt + Math.sin(p.life * 6 + p.rot) * 0.6;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.h / 2, 0, 6.3); ctx.fill(); } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life * 5)) + 1);
        ctx.restore();
      }
      if (parts.length || (until && t < until)) raf = requestAnimationFrame(frame);
      else { raf = 0; last = 0; ctx.clearRect(0, 0, r.width, r.height); }
    };
    const run = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
    return {
      // 공개 순간: 공개 자리에서 사방으로 터짐
      burst(colors, n = 90, at) {
        if (!ctx || reduced()) return;
        const r = size();
        const x = at ? at.x : r.width * 0.27;
        const y = at ? at.y : r.height * 0.55;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = 200 + Math.random() * 520;
          parts.push(piece(x, y, Math.cos(a) * v, Math.sin(a) * v - 260, colors[i % colors.length]));
        }
        run();
      },
      // 마지막 장면: 위에서 계속 내림
      rain(colors, ms) {
        if (!ctx || reduced()) return;
        size();
        rainColors = colors;
        until = performance.now() + ms;
        run();
      },
      stop() { parts = []; until = 0; },
    };
  })();

  // ── 화면 전환 · 공통 그리기 ───────────────────────────
  const VIEWS = ['login', 'loading', 'menu', 'intro', 'play', 'finale'];
  function show(view, guardMs) {
    S.view = view;
    $('#stage').dataset.view = view; // 마지막 장면에서는 꽃가루를 결과판 뒤로(draw.css)
    $('#stage').dataset.kind = S.kind || '';
    if (view !== 'loading') { $('#stuck').hidden = true; $('#loadingMsg').textContent = '불러오는 중…'; }
    if (['menu', 'intro', 'play'].includes(view)) finaleMark(null); // 전체 결과를 떠났으면 새로 고칠 때 다시 열지 않음
    for (const v of VIEWS) { $(`#${v}View`).hidden = v !== view; $(`#${v}View`).removeAttribute('aria-disabled'); }
    guardScreen(view, guardMs);
    $('#homeBtn').hidden = !['intro', 'play', 'finale'].includes(view);
    $('#progress').hidden = view !== 'play' || S.unit === 'all'; // 전체 한 번에는 진행 막대(정한 인원 / 전체)만
    if (view !== 'finale') confetti.stop();
    setTitle();
    updateControls();
  }
  // 화면이 바뀐 직후 잠깐 그 화면의 단추를 막음(아래 click 가로채기). aria-disabled 는 보조 기기·자동 시험도 '아직 못 누름'을 알게 함
  let guardTimer = 0;
  function guardScreen(view, override) {
    clearTimeout(guardTimer);
    const ms = override != null ? override : (C.screenGuardMs && C.screenGuardMs[view]) || 0;
    S.guardUntil = ms ? performance.now() + ms : 0;
    if (!ms) return;
    const el = $(`#${view}View`);
    el.setAttribute('aria-disabled', 'true');
    guardTimer = setTimeout(() => { el.removeAttribute('aria-disabled'); S.guardUntil = 0; }, ms);
  }
  const screenGuarded = () => performance.now() < S.guardUntil;
  // 전체 한 번에: 전체 결과를 띄운 탭이면 새로 고쳐도 전체 결과로 다시 엶(이 탭에만 기억, 연습 모드는 기억 안 함)
  function finaleMark(kind) {
    if (PRACTICE) return;
    try { if (kind) sessionStorage.setItem(FINALE_KEY, JSON.stringify({ kind, at: Date.now() })); else sessionStorage.removeItem(FINALE_KEY); } catch {}
  }
  function finaleMarked() {
    if (PRACTICE || S.unit !== 'all') return null;
    try { const r = JSON.parse(sessionStorage.getItem(FINALE_KEY) || 'null'); return r && KINDS[r.kind] ? r.kind : null; } catch { return null; }
  }
  document.addEventListener('click', (e) => { // 키보드로 누른 것도 click 으로 오므로 여기서 함께 막힘
    if (!screenGuarded()) return;
    const b = e.target && e.target.closest && e.target.closest('button, a');
    if (b && b.closest(`#${S.view}View`)) { e.preventDefault(); e.stopImmediatePropagation(); if (b.blur) b.blur(); }
  }, true);
  // 막힌 클릭으로 그 단추에 초점이 남으면, 보호가 끝난 뒤 스페이스·Enter 가 그 단추를 누름 → 보호 중에는 마우스로 초점도 못 옮기게
  document.addEventListener('mousedown', (e) => {
    if (!screenGuarded()) return;
    const b = e.target && e.target.closest && e.target.closest('button, a');
    if (b && b.closest(`#${S.view}View`)) e.preventDefault();
  }, true);

  function setPhase(ph) {
    S.phase = ph;
    document.body.dataset.phase = ph;
    updateControls();
  }
  function setTitle() {
    const t = ['intro', 'play', 'finale'].includes(S.view) && S.kind ? KINDS[S.kind].label : '발표용 뽑기';
    $('#title').textContent = t;
    document.title = `${PRACTICE ? '연습 · ' : ''}${t}`;
  }
  const announce = (text) => { $('#live').textContent = text; };
  const setMsg = (text) => { $('#stageMsg').textContent = text || ''; };

  function eligiblePeople() { return S.people.filter((p) => eligible(p, S.kind)); }
  function shownEligible() { return [...S.shown].filter((id) => { const p = byId(id); return p && eligible(p, S.kind); }); }

  function updateControls() {
    const next = $('#nextBtn');
    const all = $('#allBtn');
    const grp = S.unit === 'group';
    const allMode = S.unit === 'all';
    const w = S.kind ? KINDS[S.kind].unitWord : '';
    let text = '다음 ▶';
    if (S.phase === 'ready') {
      if (allMode) text = S.queue.length ? '뽑기 시작 ▶' : '전체 결과 보기 ▶';
      else if (grp) {
        if (S.queue.length) text = '뽑기 시작 ▶';
        else if (S.groupIdx + 1 < S.groupList.length) text = `${S.groupIdx < 0 ? '첫' : '다음'} ${w} 공개 ▶`;
        else text = '마지막 장면 보기 ▶';
      } else text = S.queue.length ? (S.shown.size || S.last ? '다음 사람 뽑기 ▶' : '첫 사람 뽑기 ▶') : '마지막 장면 보기 ▶';
    } else if (S.phase === 'named') text = `${w} 공개 ▶`;
    else if (S.phase === 'error') text = '다시 시도 ▶';
    else if (S.busy) text = '…';
    next.textContent = text;
    const locked = S.busy || !!S.dialog;
    next.classList.toggle('wait', locked);
    next.setAttribute('aria-disabled', String(locked));
    // '모두 공개'는 기다리는 동안에만. 한 팀·한 방씩에서 이미 다 저장했으면 '남은 팀 모두 공개'
    const unrevealed = grp && !S.queue.length && S.groupIdx + 1 < S.groupList.length;
    all.hidden = allMode || !(S.phase === 'ready' || S.phase === 'named') || !(S.queue.length || unrevealed); // 전체 한 번에는 한 번 누르면 다 되므로 없음
    all.textContent = S.queue.length ? `남은 ${S.queue.length}명 모두 공개` : `남은 ${w} 모두 공개`;
    $('#homeBtn').disabled = S.busy;
    // 진행 숫자: 공개한 사람 / 뽑을 수 있는 사람
    if (S.kind && S.view === 'play') {
      if (!allMode) $('#progress').innerHTML = `공개 <b>${shownEligible().length}</b> / ${eligiblePeople().length}명`;
    }
    const sb = $('#soundBtn');
    sb.textContent = sound.on ? '🔊 소리 켜짐' : '🔇 소리 꺼짐';
    sb.setAttribute('aria-pressed', String(sound.on));
  }

  // 결과판: 팀 4열 또는 방 7칸. opt.finale 이면 마지막 장면(이름순, 방은 남자 줄·여자 줄)
  function renderBoard(target, opt = {}) {
    const kind = S.kind;
    const groups = KINDS[kind].groups;
    const by = Object.fromEntries(groups.map((g) => [g, []]));
    const ids = opt.finale ? S.people.filter((p) => p[kind]).sort(byName).map((p) => p.id) : S.order;
    for (const id of ids) { const p = byId(id); if (p && by[p[kind]]) by[p[kind]].push(p); }
    const max = Math.max(0, ...groups.map((g) => by[g].length));
    const roomy = kind === 'team' ? (opt.finale ? 10 : 9) : (opt.finale ? 6 : 5); // 한 칸에 이보다 많으면 글자를 줄여 한 화면에
    target.className = `board${opt.finale ? ' finale-board' : ''} board-${kind}${max > roomy && !opt.finale ? ' dense' : ''}`;
    // --i: 칸 순번, --r: 칸 안 줄 순번(전체 결과 연출에서 모든 칸이 같은 줄부터 함께 채워짐)
    const card = (g, i) => `<section class="grp${by[g].length ? '' : ' empty-g'}" style="--i:${i}" data-testid="draw-group-${g}" data-count="${by[g].length}">`
      + `<h3 class="grp-h ${groupClass(g)}"><span>${esc(groupLabel(g))}</span><b>${by[g].length}</b></h3>`
      + `<ol>${by[g].map((p, r) => `<li${!opt.finale && S.fresh.has(p.id) ? ' class="new"' : ''} style="--r:${r}" data-id="${p.id}"><span class="nm">${esc(p.name)}</span>${dupTag(p)}</li>`).join('')}</ol></section>`;
    if (opt.finale && kind === 'room') {
      const men = groups.filter((g) => roomGender(g) === '남');
      const women = groups.filter((g) => roomGender(g) === '여');
      target.innerHTML = `<div class="rrow men">${men.map(card).join('')}</div><div class="rrow women">${women.map((g, i) => card(g, i + men.length)).join('')}</div>`;
    } else target.innerHTML = groups.map(card).join('');
    fitNames(target);
  }

  // 이름 글자 크기 맞춤. 같은 칸(.grp·.group-box) 안의 이름은 글자 크기가 모두 같다(이름마다 따로 줄이지 않음).
  // 칸 안 어느 이름이든 칸 너비를 넘으면 그 칸의 글자 배율 --k 를 이름 전체가 같이 줄어들게 낮춘다(줄임표보다 축소 우선).
  // 같은 이름 구분용 부서(small.dup)는 이름 뒤 남는 자리에 들어가고, 자리가 모자라면 배율을 조금(0.85배까지)만 더 줄이고 그래도 모자라면 줄임표.
  const hardOver = (li) => li.scrollWidth > li.clientWidth + 1; // 이름이 칸 너비를 넘음
  const softOver = (li) => { const d = li.querySelector('small.dup'); return !!d && d.scrollWidth > d.clientWidth + 1; }; // 부서 표시가 잘림
  function fitNames(root) {
    let tooLong = 0; // 가장 작게(0.5배) 줄여도 칸에 안 들어가는 칸 수
    const cards = root.matches('.grp, .group-box') ? [root] : [...root.querySelectorAll('.grp, .group-box')];
    for (const card of cards) {
      const lis = [...card.querySelectorAll('li')];
      let k = 1;
      const set = (v) => { k = Math.round(v * 1000) / 1000; card.style.setProperty('--k', k); };
      set(1);
      while (k > 0.5 && lis.some(hardOver)) set(k - 0.02);
      while (k > 0.85 && lis.some(softOver) && !lis.some(hardOver)) set(k - 0.02);
      if (lis.some(hardOver)) tooLong++;
    }
    return tooLong;
  }
  // 전체 결과 판: 이름 글자를 칸 높이에 맞춰 가장 크게(뒷자리에서도 읽히게). 판 전체가 같은 크기이고, 넘치면 0.1씩 줄임.
  // 칸 너비를 넘는 긴 이름은 그 칸만 따로 줄임(fitNames)
  const FINALE_FONT = { team: 4.2, room: 4.2, min: 1.2 }; // 이름 글자 크기(무대 너비 %)의 시작값. 칸에 넘치면 0.1씩 줄임(견본 29~30명은 칸 높이가 정함)
  function fitBoard(board) {
    let u = board.classList.contains('board-team') ? FINALE_FONT.team : FINALE_FONT.room;
    // 칸(grp)은 판 높이까지 늘어나고 넘치는 것은 칸 안에서 잘리므로, 판과 칸 모두 넘치지 않는지 봄
    const over = () => board.scrollHeight > board.clientHeight + 1 || [...board.querySelectorAll('.grp')].some((g) => g.scrollHeight > g.clientHeight + 1);
    board.classList.add('fit'); // 재는 동안 칸이 들어오는 연출(움직인 위치)을 멈춤 — 움직인 위치가 넘침으로 잡히지 않게
    board.style.setProperty('--nm', u);
    for (let i = 0; i < 60 && u > FINALE_FONT.min && over(); i++) { u = Math.round((u - 0.1) * 100) / 100; board.style.setProperty('--nm', u); }
    fitNames(board);
    board.classList.remove('fit');
  }

  // 공개 자리(왼쪽)에 무엇을 보일지
  function setReveal(mode) {
    $('#reveal').dataset.mode = mode;
    $('#idleBox').hidden = mode !== 'idle';
    $('#slot').hidden = !['person', 'saving', 'bulk', 'error', 'roulette'].includes(mode);
    $('#wheel').hidden = !((S.unit === 'person' && ['person', 'error'].includes(mode)) || mode === 'roulette');
    $('#wheel').classList.toggle('roulette', mode === 'roulette');
    $('#saveBar').hidden = !(S.unit === 'all' && (mode === 'roulette' || mode === 'error'));
    $('#groupBox').hidden = mode !== 'group';
    $('#errBox').hidden = mode !== 'error';
    if (mode !== 'person' && mode !== 'bulk') $('#result').hidden = true;
  }
  function showName(p, final) {
    const n = $('#slotName');
    const t = $('#slotTag'); // 이름 아래 작은 줄: 같은 이름인 사람에게만 부서를 붙임(그 밖에는 비어 있고 안 보임)
    n.textContent = p.name;
    t.textContent = isDup(p) ? `(${p.dept})` : '';
    n.classList.remove('land');
    $('#slot').classList.toggle('land', !!final);
    fitSlotName(n);
    restart(n, final ? 'land' : 'tick');
    if (!final && isDup(p)) restart(t, 'tick');
  }
  // 이름이 길어도 칸 안에 들어가게 글자 배율(--k)을 줄임(착지 때 1.12배로 커지는 것까지 생각해 여유를 둠)
  function fitSlotName(n) {
    n.style.setProperty('--k', 1);
    const slot = $('#slot');
    const cs = getComputedStyle(slot);
    const room = slot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const w = n.scrollWidth * 1.14;
    if (room > 0 && w > room) n.style.setProperty('--k', Math.max(0.4, room / w).toFixed(3));
  }
  function clearSlot() {
    $('#slotName').textContent = '';
    $('#slotTag').textContent = '';
    $('#slot').classList.remove('land');
  }
  function renderWheel(p) {
    $('#wheel').innerHTML = optionsFor(p, S.kind).map((k) => `<span class="opt ${groupClass(k)}" data-key="${k}" data-testid="draw-wheel-${k}">${esc(shortLabel(k))}</span>`).join('');
  }
  function flash(color) {
    if (reduced()) return;
    const f = $('#flash');
    f.style.setProperty('--flash', color);
    restart(f, 'go');
  }
  function idle(title, sub) {
    setReveal('idle');
    $('#idleTitle').textContent = title;
    $('#idleSub').textContent = sub || '';
  }
  function readyMsg() {
    const w = KINDS[S.kind].unitWord;
    if (S.unit === 'all') return S.queue.length ? '' : '누르면 전체 결과를 보여 줘요';
    if (S.unit === 'group') {
      if (S.queue.length) return '';
      return S.groupIdx + 1 < S.groupList.length ? `누르면 다음 ${w}을 공개해요` : '모두 공개했어요! 누르면 마지막 장면으로 넘어가요';
    }
    return S.queue.length ? `남은 ${S.queue.length}명 · 누르면 다음 사람을 뽑아요` : '모두 뽑았어요! 누르면 마지막 장면으로 넘어가요';
  }

  // ── 한 명씩 ───────────────────────────────────────────
  // 1) 이름이 섞이다 멈춤 → 2) 팀·방 돌림판이 돌다 DB 답에서 멈춤 → 3) 공개(번쩍임·확대·꽃가루)
  function startPick(p) {
    const req = api.pick(S.kind, p, (n) => setMsg(`연결이 느려 다시 보내고 있어요… (${n})`));
    req.catch(() => {}); // 거절은 spinWheel 이 받아 처리(처리 전 경고만 막음)
    return req;
  }
  async function stepPerson() {
    if (!S.queue.length) return finale();
    const p = byId(S.queue[0]);
    lock();
    setPhase('spinning');
    S.current = p;
    S.fresh = new Set();
    renderBoard($('#board'));
    setReveal('person');
    renderWheel(p);
    setMsg('누가 나올까요?');
    const req = startPick(p); // 이름이 섞이는 동안 미리 요청(답은 돌림판이 멈출 때 보여 줌)
    await spinName(p);
    if (C.pauseAfterName) {
      S.pending = req;
      setPhase('named');
      setMsg(`${who(p)} 님! 누르면 ${KINDS[S.kind].unitWord}을 공개해요`);
      unlock();
      return;
    }
    await spinAndReveal(p, req);
  }
  async function spinName(p) {
    const pool = S.queue.length > 1 ? S.queue.map(byId).filter(Boolean) : eligiblePeople();
    const total = reduced() ? C.reducedSpinMs : C.nameSpinMs;
    let t = 0;
    let prev = null;
    // 처음엔 빠르게(45ms), 끝으로 갈수록 느리게(최대 약 280ms) 바뀌다 p 에서 멈춘다
    while (t < total && pool.length > 1) {
      let x = pool[Math.floor(Math.random() * pool.length)];
      if (x === prev) x = pool[(pool.indexOf(x) + 1) % pool.length];
      prev = x;
      showName(x, false);
      sound.tick();
      const k = t / total;
      const gap = 45 + 235 * k * k;
      await sleep(gap);
      t += gap;
    }
    showName(p, true);
    sound.land();
    announce(who(p));
    await sleep(reduced() ? 0 : 350);
  }
  // 돌림판: 답이 오고 최소 시간이 지날 때까지 일정하게 돌다가, 답에서 멈추도록 점점 느려짐. 요청이 실패하면 바로 멈추고 던짐
  async function spinWheel(p, req) {
    const keys = optionsFor(p, S.kind);
    const chips = [...$('#wheel').children];
    const light = (j, win) => chips.forEach((c, n) => { c.classList.toggle('on', n === j && !win); c.classList.toggle('win', n === j && !!win); });
    let settled = null;
    req.then((v) => { settled = { v }; }, (e) => { settled = { e }; });
    const min = reduced() ? C.reducedSpinMs : C.resultSpinMs;
    const start = performance.now();
    let i = Math.floor(Math.random() * Math.max(1, keys.length));
    for (;;) {
      if (settled && (settled.e || performance.now() - start >= min)) break;
      if (!reduced() && keys.length) { i = (i + 1) % keys.length; light(i); sound.tick(); }
      await sleep(reduced() ? 40 : 75);
    }
    if (settled.e) { light(-1); throw settled.e; }
    const target = keys.indexOf(settled.v);
    if (target < 0) { light(-1); return settled.v; } // 진행자가 다른 성별의 방에 직접 넣어 둔 사람 등: 돌림판에 없는 방은 그냥 공개
    if (!reduced()) {
      const steps = ((target - i + keys.length) % keys.length) + keys.length * (keys.length > 2 ? 1 : 2);
      for (let s = 1; s <= steps; s++) {
        i = (i + 1) % keys.length;
        light(i);
        sound.tick();
        await sleep(80 + 300 * (s / steps) ** 2);
      }
    }
    light(target, true);
    return settled.v;
  }
  async function spinAndReveal(p, req) {
    lock();
    setPhase('spinning');
    setMsg(`${who(p)} 님의 ${KINDS[S.kind].unitWord}은…`);
    let v;
    try { v = await spinWheel(p, req); } catch (e) {
      return fail(e, { retry: () => retryPerson(p), afterSkip: afterPersonSkip });
    }
    revealPerson(p, v, true);
    setPhase('reveal');
    await sleep(reduced() ? Math.min(300, C.revealHoldMs) : C.revealHoldMs);
    setMsg(readyMsg());
    setPhase('ready');
    unlock();
  }
  function retryPerson(p) {
    lock();
    setPhase('spinning');
    S.error = '';
    setReveal('person');
    showName(p, true);
    renderWheel(p);
    return spinAndReveal(p, startPick(p));
  }
  function afterPersonSkip() {
    clearSlot();
    idle('건너뛰었어요', S.queue.length ? '누르면 다음 사람을 뽑아요' : '누르면 마지막 장면으로 넘어가요');
    setMsg('');
    setPhase('ready');
  }
  // 결과를 화면에 반영(DB 에는 이미 저장됨). big 이면 크게 공개(번쩍임·확대·꽃가루)
  function revealPerson(p, v, big) {
    p[S.kind] = v;
    S.queue = S.queue.filter((id) => id !== p.id);
    if (!S.shown.has(p.id)) { S.shown.add(p.id); S.order.push(p.id); }
    S.fresh = new Set([p.id]);
    S.last = { id: p.id, value: v };
    const res = $('#result');
    res.className = `result ${groupClass(v)}`;
    res.textContent = `${groupLabel(v)}!`;
    res.hidden = false;
    if (big) {
      restart(res, 'pop');
      flash(colorOf(v));
      confetti.burst([colorOf(v), '#ffffff', '#fbbf24'], 110);
      sound.reveal();
    } else sound.land();
    renderBoard($('#board'));
    announce(`${who(p)} 님은 ${groupLabel(v)}`);
  }

  // ── 한 팀·한 방씩 ─────────────────────────────────────
  // 첫 누름에 남은 사람을 한 명씩 DB 로 정해 저장한 뒤(그동안 이름이 섞임), 누를 때마다 팀·방 하나씩 그 사람들을 공개한다
  async function stepGroup() {
    if (S.queue.length) return saveAll();
    if (S.groupIdx + 1 >= S.groupList.length) return finale();
    return revealGroup(S.groupList[S.groupIdx + 1]);
  }
  async function saveAll() {
    lock();
    setPhase('saving');
    setReveal('saving');
    $('#wheel').innerHTML = '';
    const pool = S.queue.map(byId).filter(Boolean);
    let stop = !pool.length;
    (async () => { // 저장하는 동안 이름이 계속 섞임(연출)
      while (!stop) {
        showName(pool[Math.floor(Math.random() * pool.length)], false);
        sound.tick();
        await sleep(reduced() ? 400 : 90);
      }
    })();
    try {
      while (S.queue.length) {
        const p = byId(S.queue[0]);
        S.current = p;
        setMsg(`${KINDS[S.kind].unitWord}을 정하고 있어요… 남은 ${S.queue.length}명`);
        let v;
        try { v = await api.pick(S.kind, p, (n) => setMsg(`연결이 느려 다시 보내고 있어요… (${n})`)); } catch (e) {
          stop = true;
          showName(p, true);
          return fail(e, { retry: saveAll, afterSkip: saveAll });
        }
        p[S.kind] = v; // 아직 결과판에는 안 보임(팀·방 공개 때 보임)
        S.queue = S.queue.filter((id) => id !== p.id);
      }
    } finally { stop = true; }
    S.current = null;
    clearSlot();
    S.groupList = groupsFor(S.kind);
    S.groupIdx = -1;
    if (!S.groupList.length) return finale();
    return revealGroup(S.groupList[0]);
  }
  async function revealGroup(g) {
    lock();
    setPhase('reveal');
    S.groupIdx++;
    const members = eligiblePeople().filter((p) => p[S.kind] === g).sort(byName);
    S.fresh = new Set(members.filter((p) => !S.shown.has(p.id)).map((p) => p.id));
    for (const p of members) if (!S.shown.has(p.id)) { S.shown.add(p.id); S.order.push(p.id); }
    S.last = { group: g };
    saveReveal();
    setReveal('group');
    const step = reduced() ? 0 : C.groupMemberDelayMs;
    $('#groupBox').innerHTML = `<h3 class="pop ${groupClass(g)}" data-testid="draw-group-title">${esc(groupLabel(g))}</h3>`
      + `<ol class="${members.length > 8 ? 'many' : ''}" style="--step:${step}ms">${members.map((p, i) => `<li style="--i:${i}" class="${S.fresh.has(p.id) ? 'new' : ''}"><span class="nm">${esc(p.name)}</span>${dupTag(p)}</li>`).join('')}</ol>`;
    fitNames($('#groupBox'));
    flash(colorOf(g));
    confetti.burst([colorOf(g), '#ffffff', '#fbbf24'], 120);
    sound.reveal();
    renderBoard($('#board'));
    announce(`${groupLabel(g)}: ${members.map((p) => who(p)).join(', ')}`);
    setMsg('');
    await sleep(reduced() ? 300 : C.revealHoldMs + members.length * step);
    setMsg(readyMsg());
    setPhase('ready');
    unlock();
  }

  // ── 전체 한 번에(기본) ────────────────────────────────
  // 한 번 누르면 룰렛이 돌며 남은 사람을 한 명씩 DB 로 정해 저장한다(이름이 섞이고 팀·방 칸에 불이 돎, 진행 막대가 참).
  // 저장이 끝나고 최소 시간(rouletteMinMs)이 지나면 점점 느려지다 멈추고, 모든 칸이 한꺼번에 켜진 뒤 저절로 전체 결과 화면으로 넘어간다.
  async function stepAll() {
    if (S.queue.length) return rouletteAll();
    return finale({ enter: true });
  }
  const chipLabel = (key) => (TEAMS[key] ? TEAMS[key] : `${roomGender(key)} ${key.slice(1)}호`);
  function saveProgress() {
    const el = eligiblePeople();
    S.saveTotal = el.length;
    S.saveDone = el.filter((p) => p[S.kind]).length;
    $('#saveBar').style.setProperty('--p', S.saveTotal ? (S.saveDone / S.saveTotal).toFixed(4) : 0);
    $('#saveBar').setAttribute('aria-valuenow', String(S.saveDone));
    $('#saveBar').setAttribute('aria-valuemax', String(S.saveTotal));
    $('#saveCount').textContent = `${S.saveDone} / ${S.saveTotal}명`;
    updateControls();
  }
  async function rouletteAll() {
    if (!S.queue.length) return finale({ enter: true }); // 저장할 사람이 없음(예: 마지막 한 명을 건너뜀) → 룰렛 없이 바로
    lock();
    setPhase('saving');
    setReveal('roulette');
    const k = S.kind;
    const w = KINDS[k].unitWord;
    const rm = reduced();
    const wheel = $('#wheel');
    wheel.classList.remove('all-on');
    wheel.innerHTML = KINDS[k].groups.map((g) => `<span class="opt ${groupClass(g)}" data-key="${g}" data-testid="draw-wheel-${g}">${esc(chipLabel(g))}</span>`).join('');
    const chips = [...wheel.children];
    // 이름과 함께 칸에 불: 이미 정해진 사람이면 그 사람의 진짜 팀(방)만 밝게(on).
    // 아직 안 정한 사람이면 어느 칸도 밝히지 않고 그 사람이 갈 수 있는 칸(방은 같은 성별)만 옅게(maybe) — 정해진 짝처럼 보이지 않게.
    // 느려질 때는 모두 저장된 뒤라 보이는 짝이 모두 진짜 결과(맛보기)
    const showPair = (p) => {
      showName(p, false);
      const opts = p[k] ? [] : optionsFor(p, k);
      chips.forEach((c) => {
        c.classList.toggle('on', !!p[k] && c.dataset.key === p[k]);
        c.classList.toggle('maybe', opts.includes(c.dataset.key));
      });
    };
    let prev = null;
    const nextPerson = () => { // 지난번과 다른 사람
      let x = pool[Math.floor(Math.random() * pool.length)];
      if (x === prev && pool.length > 1) x = pool[(pool.indexOf(x) + 1) % pool.length];
      prev = x;
      return x;
    };
    const pool = (S.queue.length > 1 ? S.queue : eligiblePeople().map((p) => p.id)).map(byId).filter(Boolean);
    saveProgress();
    setMsg(`${w}을 정하고 있어요…`);
    if (rm) { $('#slotTag').textContent = ''; $('#slotName').textContent = `${w}을 정하는 중`; fitSlotName($('#slotName')); $('#slot').classList.remove('land'); }
    const start = performance.now();
    let spinning = !rm;
    const spin = (async () => { // 저장하는 동안 이름·칸이 계속 바뀜(연출). 움직임 줄이기면 돌지 않음
      while (spinning) {
        if (pool.length) showPair(nextPerson());
        sound.tick();
        await sleep(C.rouletteTickMs);
      }
    })();
    try {
      while (S.queue.length) {
        const p = byId(S.queue[0]);
        S.current = p;
        let v;
        try { v = await api.pick(k, p, (n) => setMsg(`연결이 느려 다시 보내고 있어요… (${n})`)); } catch (e) {
          spinning = false;
          await spin;
          chips.forEach((c) => c.classList.remove('on', 'maybe'));
          showName(p, true);
          return fail(e, { retry: rouletteAll, afterSkip: rouletteAll });
        }
        p[k] = v; // 화면에는 아직 안 보임(전체 결과에서 한꺼번에)
        S.queue = S.queue.filter((id) => id !== p.id);
        saveProgress();
      }
      S.current = null;
      setMsg(S.saveDone >= S.saveTotal ? `${w}을 모두 정했어요!` : `${S.saveDone} / ${S.saveTotal}명의 ${w}을 정했어요`); // 건너뛴 사람이 있으면 '모두'라고 하지 않음
      while (performance.now() - start < (rm ? C.reducedSpinMs : C.rouletteMinMs)) await sleep(30); // 최소 시간까지는 계속 돎
    } finally { spinning = false; }
    await spin;
    const fresh = api.state().catch(() => null); // 전체 결과에 쓸 최신 명단을 멈추는 동안 미리 받아 둠
    if (!rm) { // 점점 느려지다 멈춤
      setPhase('landing');
      let t = 0;
      while (t < C.rouletteLandMs) {
        const q = t / C.rouletteLandMs;
        const gap = C.rouletteTickMs + 300 * q * q;
        if (pool.length) showPair(nextPerson());
        sound.tick();
        await sleep(gap);
        t += gap;
      }
    }
    // 모든 칸이 한꺼번에 켜짐 → 전체 결과로
    chips.forEach((c) => c.classList.remove('on', 'maybe'));
    wheel.classList.add('all-on');
    $('#slotTag').textContent = S.saveDone >= S.saveTotal ? `${S.saveDone}명 모두 정했어요` : `${S.saveDone} / ${S.saveTotal}명 정했어요`;
    const n = $('#slotName');
    n.textContent = '결과 공개!';
    fitSlotName(n);
    n.classList.remove('tick');
    $('#slot').classList.add('land');
    restart(n, 'land');
    flash('#ffffff');
    const sr = $('#slot').getBoundingClientRect();
    const cr = $('#confetti').getBoundingClientRect();
    confetti.burst([...KINDS[k].groups.map(colorOf), '#ffffff', '#fbbf24'], 140, { x: sr.left - cr.left + sr.width / 2, y: sr.top - cr.top + sr.height / 2 });
    sound.reveal();
    announce(`${KINDS[k].label}: 모두 정했어요. 전체 결과를 보여 줘요.`);
    await sleep(rm ? 0 : C.allHoldMs);
    return finale({ enter: true, fresh });
  }

  // ── 남은 사람 모두 공개 ───────────────────────────────
  // 남은 사람을 차례로 DB 로 정해 저장하며 빠르게 보여 준 뒤 마지막 장면으로
  async function runBulk() {
    lock();
    setPhase('bulk');
    setReveal('bulk');
    $('#wheel').innerHTML = '';
    while (S.queue.length) {
      const p = byId(S.queue[0]);
      S.current = p;
      showName(p, true);
      setMsg(`남은 ${S.queue.length}명을 차례로 공개하고 있어요…`);
      let v;
      try { v = await api.pick(S.kind, p, (n) => setMsg(`연결이 느려 다시 보내고 있어요… (${n})`)); } catch (e) {
        return fail(e, { retry: runBulk, afterSkip: runBulk });
      }
      revealPerson(p, v, false);
      await sleep(reduced() ? 0 : C.bulkStepMs);
    }
    // 한 팀·한 방씩에서 저장만 하고 아직 공개하지 않은 사람도 모두 공개
    for (const p of eligiblePeople()) if (p[S.kind] && !S.shown.has(p.id)) { S.shown.add(p.id); S.order.push(p.id); }
    S.groupIdx = S.groupList.length - 1;
    if (S.groupList.length) saveReveal();
    return finale();
  }

  // ── 오류: 같은 사람으로 다시 시도하거나 건너뛰기 ─────────
  function fail(e, ctx) {
    S.error = (e && e.message) || '잠시 문제가 생겼어요.';
    S.retry = ctx.retry;
    S.afterSkip = ctx.afterSkip;
    if (isAuthErr(e)) { toLogin(S.error, true); unlock(); return; }
    setReveal('error');
    $('#errMsg').textContent = S.error;
    setMsg(S.current ? `${who(S.current)} 님 차례에서 멈췄어요. 다시 시도하면 같은 사람으로 이어서 해요(이미 정해졌으면 그 결과가 그대로 나와요).` : '');
    sound.oops();
    setPhase('error');
    unlock();
  }
  function retryNow() {
    if (S.phase !== 'error' || S.busy || S.dialog) return;
    const fn = S.retry;
    S.error = '';
    S.retry = null;
    setMsg('');
    go(fn);
  }
  function skipNow() {
    if (S.phase !== 'error' || S.busy || S.dialog || !S.current) return;
    const p = S.current;
    S.skipped.add(p.id);
    S.queue = S.queue.filter((id) => id !== p.id);
    S.error = '';
    S.retry = null;
    S.current = null;
    const after = S.afterSkip;
    S.afterSkip = null;
    go(after);
  }

  // ── 진행: 키·단추를 누를 때마다 ───────────────────────
  // 연출 중이거나 요청 중(busy)이면 무시한다. 확인 상자가 열려 있어도 무시.
  function advance() {
    if (S.dialog || S.busy || S.view !== 'play') return;
    if (screenGuarded()) return; // 뽑는 화면이 막 열린 직후(screenGuardMs.play)의 키는 무시 — 앞 화면에서 두 번 누른 키로 저장이 시작되지 않게
    if (S.phase === 'ready') return go(S.unit === 'all' ? stepAll : S.unit === 'group' ? stepGroup : stepPerson);
    if (S.phase === 'named') return go(() => spinAndReveal(S.current, S.pending));
    if (S.phase === 'error') return retryNow();
  }
  // 비동기 진행을 시작하고, 예상 못 한 오류가 나도 화면이 잠긴 채 멈추지 않게
  function go(fn) {
    Promise.resolve().then(fn).catch((e) => {
      console.error(e);
      const raw = String((e && e.message) || '');
      const msg = /[가-힣]/.test(raw) ? raw : '잠시 문제가 생겼어요. 처음 화면으로 돌아가 다시 해 주세요.'; // 영어로 된 예기치 못한 오류는 쉬운 말로
      S.busy = false;
      if (S.dialog) closeDialog(false);
      if (S.view === 'play') { showError(msg); setPhase('ready'); return; } // 뽑는 화면은 그대로 두고 다시 누를 수 있게
      // 불러오는 중 등에서 멈추면: 오류 안내와 '처음 화면' 단추를 보임
      $('#loadingMsg').textContent = '';
      $('#stuckMsg').textContent = msg;
      $('#stuck').hidden = false;
      setPhase('loading');
      show('loading');
      $('#stuckHome').focus();
    });
  }

  // ── 시작 화면 ─────────────────────────────────────────
  async function loadPeople() {
    S.people = await api.state();
    return S.people;
  }
  async function openKind(kind) {
    if (S.busy) return;
    S.kind = kind;
    setPhase('loading');
    show('loading');
    showError('');
    try { await loadPeople(); } catch (e) {
      if (isAuthErr(e)) return toLogin(e.message, true);
      showError(e.message);
      return showMenu();
    }
    renderIntro();
  }
  function renderIntro() {
    const k = S.kind;
    const el = eligiblePeople();
    const done = el.filter((p) => p[k]);
    const left = el.filter((p) => !p[k]);
    const noGender = k === 'room' ? S.people.filter((p) => !eligible(p, k)) : [];
    $('#introTitle').textContent = `${PRACTICE ? '연습 · ' : ''}${KINDS[k].label}`;
    const whole = k === 'room' ? `방을 뽑을 수 있는 사람 <b>${el.length}명</b>` : `전체 <b>${el.length}명</b>`;
    $('#introSummary').innerHTML = !el.length ? '뽑을 사람이 없어요. 관리자 페이지에서 명단을 확인해 주세요.'
      : done.length ? `${whole} 가운데 이미 <b>${done.length}명</b>이 뽑았어요.${left.length ? ` 남은 사람은 <b>${left.length}명</b>이에요.` : ' 모두 뽑았어요.'}`
        : `${whole} · 아직 아무도 안 뽑았어요.`;
    const ng = $('#introNoGender');
    ng.hidden = !noGender.length;
    ng.innerHTML = noGender.length
      ? `성별이 없어 뽑을 수 없는 <b>${noGender.length}명</b>은 이번에 건너뛰어요: ${noGender.map((p) => esc(who(p))).join(', ')}<br>관리자 페이지 명단에서 성별을 넣으면 같이 뽑을 수 있고, 객실표에서 방을 직접 넣어도 돼요.`
      : '';
    const acts = [];
    let hint = '';
    if (left.length && !done.length) acts.push(`<button class="btn big primary" type="button" data-act="keep" data-testid="draw-start">시작하기 ▶</button>`);
    if (left.length && done.length) acts.push(`<button class="btn big primary" type="button" data-act="keep" data-testid="draw-keep">그대로 두고 남은 ${left.length}명만 뽑기 ▶</button>`);
    if (!left.length && done.length) {
      if (S.unit === 'all') { // 모두 정해졌으면 룰렛 없이 전체 결과. 다시 뽑으려면 '모두 비우고 처음부터'
        acts.push(`<button class="btn big primary" type="button" data-act="keep" data-testid="draw-show-result">전체 결과 보기 ▶</button>`);
        hint = `룰렛 없이 전체 결과를 바로 보여 줘요. 다시 뽑으려면 <b>모두 비우고 처음부터</b>를 눌러요(한 번 더 물어봐요).`;
      } else if (S.unit === 'group') { // 모두 정해졌으면 팀(방) 하나씩 공개. 이 기기에서 하다 끊겼으면 이어서
        const gl = groupsFor(k);
        const r = savedReveal(k);
        if (r >= 0 && r < gl.length - 1) {
          acts.push(`<button class="btn big primary" type="button" data-act="resume" data-testid="draw-resume">이어서 공개 (${esc(groupLabel(gl[r + 1]))}부터) ▶</button>`);
          acts.push(`<button class="btn" type="button" data-act="keep" data-testid="draw-reveal-again">처음 ${KINDS[k].unitWord}부터 다시 공개</button>`);
        } else acts.push(`<button class="btn big primary" type="button" data-act="keep" data-testid="draw-show-result">${esc(groupLabel(gl[0]))}부터 공개 ▶</button>`);
        acts.push(`<button class="btn" type="button" data-act="finale" data-testid="draw-to-finale">마지막 장면 바로 보기</button>`);
      } else acts.push(`<button class="btn big primary" type="button" data-act="keep" data-testid="draw-show-result">결과 보기 ▶</button>`);
    }
    if (done.length) acts.push(`<button class="btn danger" type="button" data-act="clear" data-testid="draw-clear">모두 비우고 처음부터</button>`);
    acts.push(`<button class="btn ghost" type="button" data-act="back" data-testid="draw-back">← 처음 화면</button>`);
    $('#introActs').innerHTML = acts.join('');
    $('#introHint').hidden = !hint;
    $('#introHint').innerHTML = hint;
    setPhase('intro');
    show('intro');
    const first = $('#introActs .primary');
    if (first) first.focus(); // Enter 로 바로 시작(모두 비우기는 초점을 주지 않음)
  }
  $('#introActs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || S.busy || S.dialog) return;
    if (b.dataset.act === 'keep') begin();
    else if (b.dataset.act === 'resume') begin({ resumeIdx: savedReveal(S.kind) });
    else if (b.dataset.act === 'finale') go(askFinale);
    else if (b.dataset.act === 'clear') go(clearAndStart);
    else if (b.dataset.act === 'back') go(showMenuFresh);
  });

  async function askFinale() {
    const w = KINDS[S.kind].unitWord;
    const yes = await ask('finale', {
      title: '마지막 장면을 바로 볼까요?',
      body: `${w}을 하나씩 공개하지 않고 모든 결과를 한 화면에 바로 보여 줘요.`,
      ok: '마지막 장면 보기',
    });
    if (yes) begin({ finale: true });
  }

  async function clearAndStart() {
    const k = S.kind;
    const n = eligiblePeople().filter((p) => p[k]).length;
    const body = k === 'team'
      ? `이미 뽑은 <b>${n}명</b>의 팀이 지워지고 모두 처음부터 다시 뽑아요. 조식·점심·방·자유시간은 그대로예요.`
      : `이미 들어간 <b>${n}명</b>의 방이 지워지고 모두 처음부터 다시 뽑아요(관리자 페이지에서 직접 넣은 방도 함께 지워져요). 팀·조식·점심·자유시간은 그대로예요.`;
    const yes = await ask('clear', {
      title: `${KINDS[k].unitWord}을 모두 비울까요?`,
      body: `${body}${PRACTICE ? '<br>(연습: 견본 명단만 비워요)' : '<br>되돌릴 수 없어요.'}`,
      ok: '네, 모두 비우고 처음부터',
      danger: true,
    });
    if (!yes) return;
    lock();
    setPhase('loading');
    show('loading');
    try {
      await api.clear(k);
      await loadPeople();
    } catch (e) {
      unlock();
      if (isAuthErr(e)) return toLogin(e.message, true);
      showError(e.message);
      try { await loadPeople(); } catch {}
      return renderIntro();
    }
    unlock();
    begin();
  }

  // 뽑기 시작: 남은 사람은 무작위 순서로 줄 세움.
  // 한 명씩: 이미 뽑은 사람은 처음부터 결과판에 보임. 한 팀·한 방씩: 이미 뽑은 사람도 자기 팀(방)을 공개할 때 함께 나옴(그 전에는 안 보임).
  // opt.resumeIdx: 이 기기에서 그 순번의 팀(방)까지 공개했었음 → 그다음부터. opt.finale: 바로 마지막 장면
  function begin(opt = {}) {
    const k = S.kind;
    const grp = S.unit === 'group';
    const allMode = S.unit === 'all';
    const el = eligiblePeople();
    const done = grp || allMode ? [] : el.filter((p) => p[k]).sort(byName);
    S.shown = new Set(done.map((p) => p.id));
    S.order = done.map((p) => p.id);
    S.fresh = new Set();
    S.queue = shuffle(el.filter((p) => !p[k]).map((p) => p.id));
    S.skipped = new Set();
    S.current = null;
    S.pending = null;
    S.last = null;
    S.groupList = [];
    S.groupIdx = -1;
    S.error = '';
    showError('');
    const w = KINDS[k].unitWord;
    S.saveDone = el.length - S.queue.length;
    S.saveTotal = el.length;
    let sub = `누르면 첫 사람을 뽑아요 (남은 ${S.queue.length}명)`;
    if (!S.queue.length) { // 모두 정해져 있음
      if (allMode) return go(() => finale({ enter: true })); // 룰렛 없이 바로 전체 결과
      if (!grp || opt.finale) return go(finale);
      S.groupList = groupsFor(k);
      S.groupIdx = Math.max(-1, Math.min(opt.resumeIdx == null ? -1 : opt.resumeIdx, S.groupList.length - 1));
      if (S.groupIdx + 1 >= S.groupList.length) return go(finale);
      for (const g of S.groupList.slice(0, S.groupIdx + 1)) { // 이미 공개했던 팀(방)은 결과판에 다시 보임
        for (const p of el.filter((x) => x[k] === g).sort(byName)) { S.shown.add(p.id); S.order.push(p.id); }
      }
      sub = S.groupIdx < 0 ? `누르면 ${groupLabel(S.groupList[0])}부터 하나씩 공개해요`
        : `${groupLabel(S.groupList[S.groupIdx])}까지 공개했어요. 누르면 ${groupLabel(S.groupList[S.groupIdx + 1])}을 공개해요`;
    } else if (allMode) {
      sub = `누르면 남은 ${S.queue.length}명의 ${w}을 한꺼번에 정하고, 끝나면 전체 결과를 보여 줘요`;
      if (S.saveDone) sub += ` (이미 뽑은 ${S.saveDone}명도 함께 나와요)`;
    } else if (grp) sub = `누르면 남은 ${S.queue.length}명의 ${w}을 정해 저장하고, ${w} 하나씩 공개해요`;
    show('play');
    clearSlot();
    idle('준비됐어요', sub);
    setMsg('');
    renderBoard($('#board'));
    setPhase('ready');
    keepAwake();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // ── 마지막 장면 ───────────────────────────────────────
  // opt.enter: 전체 한 번에 — 칸 색이 켜지고 이름이 칸에 채워지는 연출 + 넘어간 직후 단추를 더 오래 막음(screenGuardMs.finaleAuto)
  // opt.fresh: 미리 받아 둔 명단(Promise). opt.quiet: 새로 고친 뒤 다시 여는 것 — 꽃가루·소리 없이
  async function finale(opt = {}) {
    lock();
    setPhase('finale');
    let stale = false;
    const pre = opt.fresh ? await opt.fresh : null;
    if (pre && Array.isArray(pre)) S.people = pre;
    else { try { await loadPeople(); } catch (e) { stale = true; } } // 못 받으면 지금 가진 결과로 보여 줌
    const k = S.kind;
    const el = eligiblePeople();
    const left = el.filter((p) => !p[k]);
    const skippedLeft = left.filter((p) => S.skipped.has(p.id));
    const noGender = k === 'room' ? S.people.filter((p) => !eligible(p, k)) : [];
    if (S.unit === 'all') { // 전체 결과에 나온 사람 = 공개한 사람(__draw.revealed)
      S.shown = new Set(el.filter((p) => p[k]).map((p) => p.id));
      S.order = [...S.shown];
    }
    // 아직 안 뽑은 사람이 있으면(건너뛰기·그사이 비운 사람 등) 축하 제목·꽃가루 대신 안내 제목
    $('#finaleTitle').textContent = left.length ? `${PRACTICE ? '(연습) ' : ''}아직 안 뽑은 사람이 있어요` : `🎉 ${PRACTICE ? '(연습) ' : ''}${KINDS[k].done}`;
    renderBoard($('#finaleBoard'), { finale: true });
    const notes = [];
    if (left.length) notes.push(`아직 안 뽑은 사람 <b>${left.length}명</b>: ${left.map((p) => esc(who(p))).join(', ')}${skippedLeft.length ? ' (오류로 건너뛴 사람 포함)' : ''}`);
    if (noGender.length) notes.push(`성별이 없어 못 뽑은 사람 <b>${noGender.length}명</b>: ${noGender.map((p) => esc(who(p))).join(', ')}`);
    if (stale) notes.push('최신 결과를 받지 못해 이 화면에서 본 결과로 보여 줘요.');
    $('#finaleNote').hidden = !notes.length;
    $('#finaleNote').innerHTML = notes.join('<br>');
    const acts = [];
    if (left.length) acts.push(`<button class="btn primary" type="button" data-act="continue" data-testid="draw-continue">남은 ${left.length}명 이어서 뽑기</button>`);
    if (k === 'team') acts.push(`<button class="btn" type="button" data-act="room" data-testid="draw-next-kind">② 방 배정 뽑기로 →</button>`);
    else acts.push(`<button class="btn" type="button" data-act="team" data-testid="draw-next-kind">① 팀 뽑기로 →</button>`);
    acts.push(`<button class="btn ghost" type="button" data-act="home" data-testid="draw-finale-home">처음 화면으로</button>`);
    $('#finaleActs').innerHTML = acts.join('');
    show('finale', opt.enter ? C.screenGuardMs.finaleAuto : undefined);
    fitBoard($('#finaleBoard')); // 연출(처음에 커졌다 줄어드는 이름) 전에 크기를 잼
    if (opt.enter && !reduced()) $('#finaleBoard').classList.add('enter');
    if (S.unit === 'all') finaleMark(k);
    if (!opt.quiet && !left.length) {
      const colors = [...KINDS[k].groups.map(colorOf), '#ffffff', '#fbbf24'];
      if (opt.enter) { const r = $('#confetti').getBoundingClientRect(); confetti.burst(colors, 160, { x: r.width / 2, y: r.height * 0.12 }); }
      confetti.rain(colors, C.confettiMs);
      sound.fanfare();
    }
    announce(left.length ? `아직 안 뽑은 사람 ${left.length}명이 있어요` : KINDS[k].done);
    unlock();
  }
  $('#finaleActs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || S.busy || S.dialog) return;
    const a = b.dataset.act;
    if (a === 'continue') go(() => openKind(S.kind));
    else if (a === 'room' || a === 'team') go(() => openKind(a));
    else go(showMenuFresh);
  });

  // ── 첫 화면 ───────────────────────────────────────────
  function showMenu() {
    const st = (kind) => {
      const el = S.people.filter((p) => eligible(p, kind));
      const done = el.filter((p) => p[kind]).length;
      return !S.people.length ? '' : done === el.length && done ? `✓ 모두 뽑았어요 (${done}명)` : `뽑음 ${done} / ${el.length}명`;
    };
    $('#teamStatus').textContent = st('team');
    $('#roomStatus').textContent = st('room');
    S.kind = null;
    setPhase('menu');
    show('menu');
  }
  async function showMenuFresh() {
    setPhase('loading');
    show('loading');
    try { await loadPeople(); } catch (e) {
      if (isAuthErr(e)) return toLogin(e.message, true);
      showError(e.message);
    }
    showMenu();
  }
  $('#pickTeam').addEventListener('click', () => go(() => openKind('team')));
  $('#pickRoom').addEventListener('click', () => go(() => openKind('room')));
  // 공개 방법: 첫 화면은 단순하게(기본 '전체 한 번에'는 따로 표시하지 않음). 다른 방법은 DRAW_CONFIG.unit 이나 주소 ?unit=group · ?unit=person 으로 고르고,
  // 그때만 첫 화면에 지금 방법과 '기본으로 되돌리기' 링크가 보임(모르고 다른 방법으로 진행하지 않게)
  function setupUnitLine() {
    const keep = (u) => { const q = new URLSearchParams(location.search); if (u) q.set('unit', u); else q.delete('unit'); const s = q.toString(); return `draw.html${s ? `?${s}` : ''}`; };
    $('#stage').dataset.unit = S.unit; // 전체 한 번에는 뽑는 화면을 가운데 한 줄로(draw.css)
    const line = $('#unitLine');
    line.hidden = S.unit === 'all';
    $('#unitName').textContent = UNIT_LABEL[S.unit];
    $('#unitReset').href = keep('all');
    // 연습 ↔ 실제 링크도 지금 공개 방법을 그대로 가져감
    const u = params.get('unit');
    $('#toPractice').href = `draw.html?practice=1${u ? `&unit=${encodeURIComponent(u)}` : ''}`;
    $('#toLive').href = `draw.html${u ? `?unit=${encodeURIComponent(u)}` : ''}`;
  }
  setupUnitLine();

  // ── 진행자 확인 ───────────────────────────────────────
  function toLogin(msg, wrongCode) {
    if (wrongCode) { code = null; store.set(CODE_KEY, null); }
    S.kind = null;
    $('#loginErr').textContent = msg || '';
    $('#reconnectBtn').hidden = !code; // 비밀번호는 맞을 수 있는데 통신 문제로 실패했을 때
    $('#reconnectBtn').textContent = code && store.get(CODE_KEY) === code ? '저장된 비밀번호로 다시 연결' : '다시 연결';
    setPhase('login');
    show('login');
  }
  async function tryCode(c) {
    setPhase('loading');
    show('loading');
    code = c;
    try {
      await loadPeople(); // board_state 가 성공해야 열림
    } catch (e) {
      return toLogin(e.message, isAuthErr(e));
    }
    store.set(CODE_KEY, code);
    $('#code').value = '';
    showError('');
    const back = finaleMarked();
    if (back) return reopenFinale(back);
    showMenu();
  }
  // 전체 결과를 띄운 채 새로 고쳤으면 전체 결과로 다시(결과는 DB 에 있어 그대로). 꽃가루·소리 없이
  function reopenFinale(kind) {
    // 그사이 다른 곳(관리자 페이지 등)에서 결과를 모두 비웠으면 빈 판 대신 첫 화면으로(기억도 지움)
    if (!S.people.some((p) => eligible(p, kind) && p[kind])) { finaleMark(null); return showMenu(); }
    S.kind = kind;
    S.queue = [];
    S.skipped = new Set();
    S.current = null;
    S.last = null;
    return finale({ quiet: true });
  }
  $('#codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = $('#code').value;
    if (c) go(() => tryCode(c));
  });
  $('#reconnectBtn').addEventListener('click', () => { if (code) go(() => tryCode(code)); });
  $('#stuckHome').addEventListener('click', () => {
    if (S.busy) return;
    $('#stuck').hidden = true;
    $('#loadingMsg').textContent = '불러오는 중…';
    if (PRACTICE || code) go(showMenuFresh); else toLogin('');
  });

  // ── 확인 상자(화면 안) ────────────────────────────────
  let dlgDone = null;
  let dlgOpenAt = 0;
  const DLG_GUARD_MS = 500; // 상자가 열린 직후 이 시간 동안의 키 입력은 무시(습관적으로 누른 키가 바로 확정·취소로 이어지지 않게)
  const dlgGuarded = () => performance.now() - dlgOpenAt < DLG_GUARD_MS;
  // 그 화면의 주 단추(상자를 닫은 뒤 초점을 돌려줄 곳)
  function mainButton() {
    if (S.view === 'play') return $('#nextBtn');
    if (S.view === 'intro') return $('#introActs .primary') || $('#introActs button');
    if (S.view === 'finale') return $('#finaleActs button');
    return null;
  }
  function ask(name, o) {
    S.dialog = name;
    $('#dlgTitle').textContent = o.title;
    $('#dlgBody').innerHTML = o.body;
    $('#dlgOk').textContent = o.ok;
    $('#dlgOk').className = `btn ${o.danger ? 'danger' : 'primary'}`;
    $('#dlg').hidden = false;
    updateControls();
    dlgOpenAt = performance.now();
    $('#dlgCancel').focus(); // 초점은 늘 '취소'. 확정은 확인 단추로 초점을 옮겨 누르거나 마우스로만
    return new Promise((res) => { dlgDone = res; });
  }
  function closeDialog(yes) {
    if (!S.dialog) return;
    S.dialog = null;
    $('#dlg').hidden = true;
    updateControls();
    const mb = mainButton(); // 초점을 그 화면의 주 단추로(그 단추에서 스페이스·Enter 는 브라우저가 한 번만 누름 — 아래 keydown 은 단추 위의 스페이스·Enter 를 건드리지 않음)
    if (mb) mb.focus(); else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const r = dlgDone;
    dlgDone = null;
    if (r) r(!!yes);
  }
  // 키보드로 눌린 클릭(detail 0)이 열린 직후면 무시(마우스 클릭은 그대로)
  $('#dlgOk').addEventListener('click', (e) => { if (e.detail === 0 && dlgGuarded()) return; closeDialog(true); });
  $('#dlgCancel').addEventListener('click', (e) => { if (e.detail === 0 && dlgGuarded()) return; closeDialog(false); });
  // 스페이스는 키를 뗄 때 단추가 눌리므로 떼는 것도 막음
  document.addEventListener('keyup', (e) => { if (S.dialog && (e.key === ' ' || e.key === 'Enter') && dlgGuarded()) e.preventDefault(); }, true);
  // 화면이 막 바뀐 동안(예: 룰렛이 끝나 저절로 전체 결과로 넘어간 직후)은 그 화면 단추 위에서 뗀 스페이스도 누름이 되지 않게
  document.addEventListener('keyup', (e) => {
    if (S.dialog || !screenGuarded() || !(e.key === ' ' || e.key === 'Enter')) return;
    const b = e.target && e.target.closest && e.target.closest('button, a');
    if (b && b.closest(`#${S.view}View`)) e.preventDefault();
  }, true);
  $('#dlg').addEventListener('click', (e) => { if (e.target === $('#dlg')) closeDialog(false); });
  $('#dlg').addEventListener('keydown', (e) => { // Tab 은 취소 ↔ 확인 사이만 오감
    if (e.key !== 'Tab') return;
    e.preventDefault();
    (document.activeElement === $('#dlgOk') ? $('#dlgCancel') : $('#dlgOk')).focus();
  });

  async function askAll() {
    if (S.busy || S.dialog || !(S.phase === 'ready' || S.phase === 'named')) return;
    const w = KINDS[S.kind].unitWord;
    const yes = await ask('all', S.queue.length
      ? { title: `남은 ${S.queue.length}명을 모두 공개할까요?`, body: `남은 사람을 차례로 뽑아 저장하면서 빠르게 보여 준 뒤 마지막 장면으로 넘어가요.${PRACTICE ? '' : ' 뽑은 결과는 바로 저장돼요.'}`, ok: '모두 공개' }
      : { title: `남은 ${w}을 모두 공개할까요?`, body: `아직 공개하지 않은 ${w}을 한꺼번에 보여 주고 마지막 장면으로 넘어가요.`, ok: '모두 공개' });
    if (!yes) return;
    if (S.phase === 'named') { S.pending = null; } // 이미 보낸 요청은 같은 사람이라 다시 보내도 결과가 같음
    go(runBulk);
  }

  // ── 단추 · 키 ─────────────────────────────────────────
  const blurAfter = (fn) => (e) => { fn(e); if (e.currentTarget.blur) e.currentTarget.blur(); }; // 단추에 초점이 남아 스페이스가 그 단추를 다시 누르지 않게
  $('#nextBtn').addEventListener('click', blurAfter(() => advance()));
  $('#allBtn').addEventListener('click', blurAfter(() => go(askAll)));
  $('#retryBtn').addEventListener('click', blurAfter(() => retryNow()));
  $('#skipBtn').addEventListener('click', blurAfter(() => skipNow()));
  $('#soundBtn').addEventListener('click', blurAfter(() => toggleSound()));
  $('#fsBtn').addEventListener('click', blurAfter(() => toggleFs()));
  $('#homeBtn').addEventListener('click', blurAfter(() => { if (!S.busy && !S.dialog) go(showMenuFresh); }));

  function toggleSound() { sound.set(!sound.on); updateControls(); if (sound.on) sound.land(); }
  function toggleFs() {
    const d = document;
    const el = d.documentElement;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    } catch {}
  }

  const NEXT_KEYS = new Set([' ', 'Spacebar', 'Enter', 'ArrowRight', 'PageDown']); // PageDown·→: 발표용 무선 리모컨이 보내는 키
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (S.dialog) {
      if (e.key === 'Escape') { if (!e.repeat) { e.preventDefault(); closeDialog(false); } return; }
      // 누르고 있어 반복되는 키, 열린 직후의 키는 상자 단추도 누르지 못하게. →·PageDown 은 상자에서 아무 일도 안 함(확정으로 이어지지 않음)
      if (e.repeat || dlgGuarded() || e.key === 'ArrowRight' || e.key === 'PageDown') e.preventDefault();
      return;
    }
    if (e.code === 'KeyF') { e.preventDefault(); toggleFs(); return; } // 한글 입력 상태(ㄹ)에서도 되게 e.code 로
    if (e.code === 'KeyM') { toggleSound(); return; }
    if (S.view === 'menu' && (e.code === 'Digit1' || e.code === 'Digit2')) { go(() => openKind(e.code === 'Digit1' ? 'team' : 'room')); return; }
    if (!NEXT_KEYS.has(e.key)) return;
    const onControl = t && t.closest && t.closest('button, a, summary, select');
    if ((e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') && onControl) { // 단추에 초점이 있으면 브라우저가 그 단추를 한 번 누름
      // 누르고 있어 반복되는 Enter 로 단추가 계속 눌리지 않게. 화면이 막 바뀐 동안(screenGuardMs)은 그 화면 단추를 키로 누르지 못하게
      if (e.repeat || (screenGuarded() && onControl.closest(`#${S.view}View`))) e.preventDefault();
      return;
    }
    if (S.view !== 'play') return;
    e.preventDefault();
    if (e.repeat) return; // 키를 누르고 있어 반복되는 입력은 무시
    advance();
  });

  // ── 화면 꺼짐 막기(지원하는 브라우저에서) ─────────────
  let wake = null;
  async function keepAwake() {
    if (wake || document.hidden || !navigator.wakeLock) return;
    try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch { wake = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.view === 'play') keepAwake(); });

  // ── 시험용 상태 요약(읽기 전용) ───────────────────────
  Object.defineProperty(window, '__draw', {
    configurable: false,
    enumerable: false,
    get() {
      try { return summary(); } catch (e) { // 상태가 망가져도 시험이 읽다가 멈추지 않게
        return Object.freeze({ version: 1, mode: PRACTICE ? 'practice' : 'live', view: S.view, phase: S.phase, kind: S.kind, busy: S.busy, locked: S.busy || !!S.dialog, dialog: S.dialog, error: String(e && e.message) });
      }
    },
  });
  function summary() {
    {
      const k = S.kind;
      const counts = {};
      if (k) {
        for (const g of KINDS[k].groups) counts[g] = 0;
        for (const id of S.shown) { const p = byId(id); if (p && counts[p[k]] != null) counts[p[k]]++; }
      }
      const pick = (p) => (p ? Object.freeze({ id: p.id, dept: p.dept, name: p.name }) : null);
      return Object.freeze({
        version: 1,
        mode: PRACTICE ? 'practice' : 'live',
        view: S.view,
        phase: S.phase,
        kind: k,
        unit: S.unit,
        locked: S.busy || !!S.dialog,
        busy: S.busy,
        dialog: S.dialog,
        total: k ? eligiblePeople().length : 0,
        revealed: k ? shownEligible().length : 0,
        remaining: S.queue.length,
        skipped: S.skipped.size,
        noGender: k === 'room' ? S.people.filter((p) => !eligible(p, k)).length : 0,
        current: pick(S.current),
        last: S.last ? Object.freeze({ ...S.last }) : null,
        saveDone: S.saveDone,
        saveTotal: S.saveTotal,
        groupIndex: S.groupIdx,
        groupCount: S.groupList.length,
        savedRevealIndex: k ? savedReveal(k) : -1,
        guarded: screenGuarded(),
        counts: Object.freeze(counts),
        error: S.error || null,
        sound: sound.on,
        reduced: reduced(),
        calls: Object.freeze({ ...calls }),
      });
    }
  }

  // ── 시작 ──────────────────────────────────────────────
  if (PRACTICE) {
    $('#practiceBadge').hidden = false;
    $('#watermark').hidden = false;
    $('#toPractice').hidden = true;
    $('#toLive').hidden = false;
    $('#toBoard').hidden = true;
    go(showMenuFresh); // 견본 명단(메모리)
  } else if (code) {
    go(() => tryCode(code));
  } else {
    toLogin('');
  }
})();
