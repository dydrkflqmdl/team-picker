// 발표용 점수판(score.html). 진행자가 노트북을 프로젝터에 띄워 두고 네 팀(빨강·파랑·노랑·초록)에 점수를 주거나 뺀다.
//
// 점수는 DB(team_scores)에 저장된다. 이 화면은 점수를 계산해서 덮어쓰지 않고, 서버 함수 score_add 에게 "이 팀에 +50" 만 말한다.
//   서버가 현재 값에 더하고 갱신한 네 팀 점수를 돌려주므로(한 문장으로 더함), 탭을 두 개 열어 동시에 줘도 어긋나지 않는다.
//   화면에 보이는 점수는 늘 '서버가 돌려준 값'이다: 누르면 먼저 서버에 저장하고, 답이 오면 그 값으로 슬롯 연출이 돈 뒤 멈춘다(답이 오기 전엔 연출 없음).
// 입구: 관리자 비밀번호를 넣어야 열린다(뽑기 화면 draw.js 와 같은 방식, 기억 키만 따로 score-gate). 연습 모드(?practice=1)는 입구 확인 말고는 DB 를 부르지 않는다.
// 시험용 관측: window.__score(화면 상태 요약, 읽기 전용) · window.__scoreAudio(소리 요청 기록).

// ── 바꾸기 쉬운 설정 ─────────────────────────────────────
const SCORE_CONFIG = {
  spinMs: 2000,            // 숫자가 도는 시간(처음 빠르고 끝에서 느려짐). 점수 변화가 아무리 커도 같음
  pollMs: 5000,            // 서버 점수·팀원 이름을 다시 받는 간격
  verifyMs: 1200,          // 저장 응답을 못 받은(저장됐는지 모르는) 뒤 서버 점수를 다시 읽어 보기까지의 시간
  pendMs: 120000,          // 응답을 못 받은 요청의 번호를 기억해 두는 시간((팀, 점수)마다 따로): 이 안에 같은 팀·같은 점수를 다시 누르면(그 사이 다른 점수를 줬어도) 같은 번호로 보내 서버가 두 번 더하지 않음
  hitMs: 1300,             // 멈춘 뒤 강조(밝게/가라앉게)가 남는 시간
  tagMs: 2200,             // +50·−10 표시가 보이는 시간
  reducedSoundMs: 600,     // '움직임 줄이기'일 때 소리 길이(돌지 않으니 짧게 마무리 소리만)
  maxStep: 1000000,        // 한 번에 줄 수 있는 점수(서버 score_add 와 같음)
  maxTotal: 1000000000,    // 팀 점수 한도(서버와 같음)
  soundDefault: true,      // 소리 기본값(켜짐). 소리 단추나 M 키로 끔. 이 탭에서 바꾼 값은 새로 고쳐도 유지
};

// 시험이 소리 '요청'을 확인하는 관측 장치(화면 동작과 무관). 페이지가 열리면 바로 있음.
//   log: 소리를 낼 때마다(소리가 꺼져 있어도) 한 줄 {dir, at(Date.now), ms, played, muted}
//     dir 'up' 점수 올라감(올리는 소리 + 멈출 때 밝은 화음 한 번) · 'down' 점수 내려감(내리는 소리 + 멈출 때 낮은 음 한 번) · 'test' 소리 시험 단추
//     ms: 소리가 도는 부분의 길이(= 숫자가 도는 시간, 기본 2000. 움직임 줄이기 600, test 1700). 마무리 소리의 꼬리는 그 뒤로 약 0.8초 더 남음
//     played: 실제로 소리를 만들어 재생 예약했는지(소리 꺼짐·브라우저 미지원이면 false) · muted: 요청 때 소리 꺼짐 여부
//     화면 점수가 서버 값에 맞춰 조용히 바뀌는 연출(다른 탭·초기화)은 소리를 내지 않으므로 log 에 안 남음
//   muted: 지금 소리 꺼짐 · started: 오디오가 실제로 돌고 있음(사용자 동작 뒤 running) · state: AudioContext.state('none'이면 아직 안 만듦) · cuts: 이전 소리를 끊고 새 소리를 시작한 횟수
window.__scoreAudio = { log: [], muted: false, started: false, state: 'none', cuts: 0 };

(() => {
  // common.js 를 못 받았으면(통신 불안정·차단) 안내는 common.js 가 띄우고 여기서 멈춘다
  if (typeof rpc !== 'function' || typeof TEAMS === 'undefined') return;

  const C = SCORE_CONFIG;
  const params = new URLSearchParams(location.search);
  const PRACTICE = params.get('practice') === '1';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isAuthErr = (e) => !PRACTICE && /비밀번호/.test(String(e && e.message));
  const fmt = (n) => (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US'); // 화면용(마이너스는 − 기호)
  const signed = (d) => (d > 0 ? '+' : '−') + Math.abs(d).toLocaleString('en-US');
  const label = (t) => `${TEAMS[t]} 팀`;
  // 점수 요청마다 붙이는 고유 번호(서버 score_add 의 p_req: 8~64자, 영문·숫자·-·_). 같은 번호가 두 번 도착해도 서버는 한 번만 더함
  const newReq = () => {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch {}
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${Date.now().toString(36)}-${h()}${h()}-${h()}${h()}${h()}`;
  };

  // ── 소리(WebAudio 합성음) ─────────────────────────────
  // 소리 파일·외부 소리 없이 oscillator/gain 만으로 만든다. 브라우저는 사용자 동작 전에는 소리를 막으므로
  // AudioContext 는 비밀번호 제출·단추·키 같은 사용자 동작 안에서 만들고 resume 한다(unlock).
  const audio = (() => {
    const obs = window.__scoreAudio;
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let cur = null; // 지금 나는 소리 { master, until }
    let muted = !C.soundDefault;
    try { const m = sessionStorage.getItem('score-muted'); if (m != null) muted = m === '1'; } catch {}
    obs.muted = muted;
    const sync = () => { obs.state = ctx ? ctx.state : 'none'; obs.started = !!ctx && ctx.state === 'running'; };
    function unlock() {
      if (!AC) return;
      try {
        if (!ctx) { ctx = new AC(); ctx.onstatechange = sync; }
        if (ctx.state === 'suspended') ctx.resume().then(sync, () => {});
        sync();
      } catch { ctx = null; }
    }
    // 이전 소리를 부드럽게(0.05초) 줄여 끊는다. 연달아 줄 때 겹쳐 시끄러워지지 않게
    function cut() {
      const c = cur;
      cur = null;
      if (!c || !ctx) return;
      try {
        const now = ctx.currentTime;
        if (c.until > now) obs.cuts++;
        c.master.gain.cancelScheduledValues(now);
        c.master.gain.setValueAtTime(c.master.gain.value, now);
        c.master.gain.linearRampToValueAtTime(0.0001, now + 0.05);
        setTimeout(() => { try { c.master.disconnect(); } catch {} }, 150);
      } catch {}
    }
    function setMuted(v) {
      muted = !!v;
      obs.muted = muted;
      try { sessionStorage.setItem('score-muted', muted ? '1' : '0'); } catch {}
      if (muted) cut(); else unlock();
    }
    // 소리 한 번 만들기. dir: 'up' | 'down' | 'test'
    function play(dir, o = {}) {
      const short = !!o.reduced && dir !== 'test';
      const T = dir === 'test' ? 1700 : short ? C.reducedSoundMs : C.spinMs; // 도는 부분의 길이(ms)
      const entry = { dir, at: Date.now(), ms: T, played: false, muted };
      obs.log.push(entry);
      if (obs.log.length > 400) obs.log.shift();
      cut();
      if (muted || !AC) return entry;
      unlock();
      if (!ctx) return entry;
      try {
        const t0 = ctx.currentTime + 0.02;
        const master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
        const osc = (type, f0, f1, at, dur, vol, hold) => { // hold: 소리가 천천히 커졌다 일정하게 이어지다 끝에서 줄어듦(스윕용)
          const o2 = ctx.createOscillator();
          const g = ctx.createGain();
          const s = t0 + at;
          o2.type = type;
          o2.frequency.setValueAtTime(f0, s);
          if (f1 && f1 !== f0) o2.frequency.exponentialRampToValueAtTime(f1, s + dur);
          g.gain.setValueAtTime(0.0001, s);
          if (hold) { g.gain.exponentialRampToValueAtTime(vol, s + Math.min(0.15, dur * 0.2)); g.gain.setValueAtTime(vol, s + dur * 0.8); }
          else g.gain.exponentialRampToValueAtTime(vol, s + Math.min(0.02, dur / 4));
          g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
          o2.connect(g).connect(master);
          o2.start(s);
          o2.stop(s + dur + 0.03);
        };
        const sweep = (up, at, dur) => osc('triangle', up ? 260 : 1000, up ? 1000 : 260, at, dur, 0.05, true);
        // 숫자가 칸을 지나가는 '딸깍' 소리: 숫자가 느려지는 것과 같은 간격으로 점점 드문드문, 올라갈 땐 음이 높아지고 내려갈 땐 낮아짐
        const ticks = (up, at, dur) => {
          const K = 24;
          for (let i = 1; i < K; i++) {
            const x = 1 - Math.pow(1 - i / K, 1 / 3);
            osc('square', up ? 600 + 900 * (i / K) : 1500 - 900 * (i / K), 0, at + x * dur, 0.035, 0.028);
          }
        };
        const cheer = (at) => { // 멈출 때 밝은 화음
          [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => osc('triangle', f, 0, at + i * 0.045, 0.75, 0.085));
          osc('sine', 2093, 0, at + 0.18, 0.5, 0.03);
        };
        const thud = (at) => { // 멈출 때 낮은 음
          osc('triangle', 220, 147, at, 0.5, 0.13);
          osc('sine', 110, 82, at, 0.6, 0.14);
          osc('sawtooth', 165, 110, at, 0.45, 0.035);
        };
        const sec = T / 1000;
        let total;
        if (dir === 'test') { sweep(true, 0, 0.5); cheer(0.45); sweep(false, 0.95, 0.4); thud(1.3); total = 2.0; }
        else if (short) { sweep(dir === 'up', 0, 0.22); (dir === 'up' ? cheer : thud)(0.2); total = 1.0; }
        else { sweep(dir === 'up', 0, sec); ticks(dir === 'up', 0, sec); (dir === 'up' ? cheer : thud)(sec - 0.04); total = sec + 0.8; }
        cur = { master, until: t0 + total };
        entry.played = true;
      } catch { /* 소리를 못 내도 화면은 그대로 */ }
      return entry;
    }
    return { unlock, play, cut, setMuted, get muted() { return muted; } };
  })();
  // 첫 사용자 동작(키·클릭)에서 오디오를 깨움: 새로 고친 뒤(입구를 건너뛰고 열림) 첫 단추·키부터 소리가 나게
  for (const t of ['pointerdown', 'keydown']) document.addEventListener(t, () => audio.unlock(), true);

  // ── 입구(진행자 확인) ─────────────────────────────────
  // 관리자 비밀번호를 넣어야 화면이 열린다(연습 모드도 같음). 맞는지는 서버가 판단한다: check_admin 은 브라우저에서 직접 부를 수 없어
  // 그것을 거치는 관리자 읽기 함수 board_state 로 확인한다(관리자 페이지·뽑기 화면과 같은 방법).
  // 기억: 이 탭의 sessionStorage(GATE_KEY)에만 — 같은 탭에서 새로 고치면 다시 묻지 않고(대신 서버에 다시 확인), 탭을 닫으면 사라진다.
  //   localStorage·쿠키에는 적지 않고, 관리자 페이지가 localStorage 에 저장한 비밀번호도 읽지 않는다(새 탭은 직접 넣음).
  // 다시 확인할 때 서버가 비밀번호를 거절하면 기억을 지우고 입구에 남고, 통신이 안 되면(틀린 것과 구분) 기억은 둔 채 '다시 연결'을 보인다.
  const GATE_KEY = 'score-gate';
  const GATE_NOTE_KEY = 'score-gate-note'; // 잠근 뒤 다시 열린 입구에 보일 안내('lock' | 'auth'). 비밀번호 아님, 한 번 읽고 지움
  const sess = {
    get() { try { return sessionStorage.getItem(GATE_KEY) || null; } catch { return null; } },
    set(v) { try { sessionStorage.setItem(GATE_KEY, v); } catch {} },
    clear() { try { sessionStorage.removeItem(GATE_KEY); } catch {} },
  };
  const gate = { state: 'idle', busy: false, retry: null, retryAuto: false, checks: 0 };
  let app = null; // 입구를 통과하면 startApp 이 돌려준 상태 요약 함수
  // state: idle · checking · wrong(비밀번호 거절) · offline(통신 오류) · server(그 밖의 서버 오류) · locked(잠가서 다시 여는 중)
  function gateUi(state, err, info) {
    gate.state = state;
    const wait = state === 'checking' || state === 'locked';
    $('#stage').dataset.view = 'login';
    document.body.dataset.phase = 'login';
    $('#code').disabled = wait;
    $('#loginBtn').disabled = wait;
    $('#reconnectBtn').hidden = !gate.retry || state === 'locked';
    $('#reconnectBtn').disabled = wait;
    $('#gateInfo').textContent = info || '';
    $('#gateInfo').hidden = !info;
    $('#loginErr').textContent = err || '';
    $('#loginErr').dataset.kind = err ? state : '';
    if (!wait) $('#code').focus();
  }
  async function check(c, auto) {
    if (gate.busy || app) return;
    gate.busy = true;
    gate.checks++;
    gateUi('checking', '', auto ? '이 탭에서 확인한 비밀번호를 서버에 다시 확인하고 있어요…' : '확인하고 있어요…');
    let d;
    try {
      d = await rpc('board_state', { p_code: c }); // 성공 = 관리자 비밀번호가 맞음
      if (!d || !Array.isArray(d.people)) throw new Error('서버 답을 제대로 받지 못했어요.');
    } catch (e) {
      gate.busy = false;
      const msg = String((e && e.message) || '');
      if (/비밀번호/.test(msg)) {
        sess.clear();
        gate.retry = null;
        return gateUi('wrong', /틀렸/.test(msg) ? (auto ? '관리자 비밀번호가 바뀌었어요. 새 비밀번호를 넣어 주세요.' : '비밀번호가 맞지 않아요. 다시 넣어 주세요.') : msg);
      }
      gate.retry = c; // 맞는지 아직 모름(기억은 그대로). '다시 연결'이 같은 값으로 다시 보냄(메모리에만)
      gate.retryAuto = auto;
      if ((e && e.retryable) || /연결이 느려요|인터넷 연결/.test(msg)) {
        return gateUi('offline', '서버와 연결이 안 돼 비밀번호를 확인하지 못했어요(비밀번호가 틀렸다는 뜻은 아니에요). 인터넷 연결을 확인한 뒤 ‘다시 연결’을 눌러 주세요.');
      }
      return gateUi('server', `서버가 확인하지 못했어요: ${msg || '알 수 없는 오류'} 잠시 뒤 ‘다시 연결’을 눌러 주세요.`);
    }
    gate.busy = false;
    gate.retry = null;
    sess.set(c);
    $('#code').value = '';
    $('#loginErr').textContent = '';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    app = startApp(c, PRACTICE ? null : d.people); // 연습 모드는 받은 실제 명단을 쓰지 않음
  }
  function gateSubmit() {
    if (gate.busy || app) return;
    audio.unlock(); // 비밀번호 제출은 사용자 동작 — 여기서 오디오를 깨워 두면 들어와서 첫 점수부터 소리가 남
    const c = $('#code').value;
    $('#code').value = '';
    if (!c.trim()) return gateUi('idle', '관리자 비밀번호를 넣어 주세요.');
    check(c, false);
  }
  $('#code').addEventListener('keydown', (e) => { // 입구에서 Enter 는 비밀번호 제출로만
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (!e.repeat) gateSubmit();
  });
  $('#loginBtn').addEventListener('click', gateSubmit);
  $('#reconnectBtn').addEventListener('click', () => { audio.unlock(); if (gate.retry) check(gate.retry, gate.retryAuto); });
  function gateInit() {
    let note = null;
    try { note = sessionStorage.getItem(GATE_NOTE_KEY); sessionStorage.removeItem(GATE_NOTE_KEY); } catch {}
    const saved = sess.get();
    if (saved) return check(saved, true); // 같은 탭에서 새로 고침: 묻지 않고 서버에 다시 확인
    if (note === 'auth') return gateUi('wrong', '관리자 비밀번호가 바뀌었어요. 새 비밀번호를 넣어 주세요.');
    gateUi('idle', '', note === 'lock' ? '화면을 잠갔어요. 다시 열려면 관리자 비밀번호를 넣어 주세요.' : '');
  }
  // 잠그기(또는 들어온 뒤 서버가 비밀번호를 거절함): 이 탭의 기억을 지우고, 화면에 남은 점수·이름 DOM 을 바로 없앤 뒤 페이지를 다시 불러 입구로.
  let locking = false;
  let stopApp = () => {}; // startApp 이 정해 두는 '주기적 받기 멈추기'(잠그는 순간 5초 타이머를 지움)
  function lockNow(reason) {
    if (locking) return;
    locking = true;
    stopApp();
    sess.clear();
    audio.cut();
    try { sessionStorage.setItem(GATE_NOTE_KEY, reason === 'lock' ? 'lock' : 'auth'); } catch {}
    const stop = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
    for (const t of ['keydown', 'keyup', 'keypress', 'click', 'mousedown']) window.addEventListener(t, stop, true);
    for (const el of [...$('#stage').children]) if (el.id !== 'loginView' && el.id !== 'error') el.remove();
    $('#error').textContent = '';
    document.title = '팀 점수판';
    delete $('#stage').dataset.mode;
    app = null;
    $('#loginView').hidden = false;
    gateUi('locked', '', navigator.onLine === false ? '화면을 잠갔어요. 인터넷이 연결되면 새로 고쳐 주세요.' : '잠그는 중…');
    location.reload();
  }
  Object.defineProperty(window, '__score', { // 시험용 상태 요약(읽기 전용)
    configurable: false,
    enumerable: false,
    get() {
      if (app) return app();
      return Object.freeze({ version: 1, mode: PRACTICE ? 'practice' : 'live', view: 'login', phase: 'login', gate: gate.state, ready: false, busy: gate.busy,
        error: null, calls: Object.freeze({ board_state: gate.checks, score_state: 0, score_add: 0 }) });
    },
  });

  function startApp(code, first) { // code: 서버가 맞다고 한 관리자 비밀번호, first: 그때 받은 명단(연습 모드는 null)
    $('#stage').append($('#appTpl').content.cloneNode(true));
    $('#loginView').hidden = true;
    const stage = $('#stage');
    stage.dataset.view = 'board';
    stage.dataset.mode = PRACTICE ? 'practice' : 'live';

    // ── 상태 ──────────────────────────────────────────────
    const S = {
      ready: false,        // 서버 점수를 한 번이라도 받음(연습 모드는 바로 true). 그 전엔 점수 단추가 잠김
      shown: Object.fromEntries(TEAM_KEYS.map((t) => [t, null])), // 화면이 보여 주는(또는 돌아서 가는 중인) 점수. null = 아직 못 받음
      server: null,        // 마지막으로 받은 서버 점수(저장 응답·새로 받기). 화면이 이것과 다르면 연출이 끝난 뒤 맞춤
      anim: {},            // 팀 → 돌고 있는 연출
      team: null,          // 점수를 줄 팀(고른 팀)
      busy: false,         // 저장 요청이 서버에 나가 답을 기다리는 중 — 이때는 점수 단추·키가 잠김(중복 요청 방지)
      sending: null,       // 보내는 중인 {team, delta}
      verifying: null,     // 저장 응답을 못 받아 저장됐는지 모르는 상태: {team, delta, before}. 서버 점수를 다시 읽어 확인할 때까지 점수 단추 잠김
      pend: new Map(),     // 응답을 못 받아 서버에 들어갔는지 모르는 요청들: '팀|점수' → {team, delta, req, until}. 같은 팀·같은 점수를 다시 누르면 같은 번호(req)로 보냄(늦게 도착한 원래 요청과 겹쳐도 한 번만 더해짐). 다른 점수를 줘도 지우지 않음
      last: null,          // 마지막으로 성공한 {team, delta} (되돌리기용)
      writes: 0,           // 저장 요청이 시작·끝날 때마다 +1: 새로 받기 도중에 저장이 끼었는지 알아봄
      people: first || [], // board_state 의 명단
      namesSig: '',
      namesOff: false,
      polling: false,
      pollAgain: false,
      pollFails: 0,
      pollTimer: 0,
      dialog: null,
      alert: null,         // {kind: 'error'|'warn', msg, scope}
      status: '',
      tagN: 0,
      soundNote: false,    // 지금 안내 줄이 '소리가 꺼져 있어서 안 들려요'인지
    };
    try { S.namesOff = sessionStorage.getItem('score-names-off') === '1'; } catch {}
    const calls = { board_state: 0, score_state: 0, score_add: 0 }; // 시험용: 입구 다음에 보낸 요청 수

    // ── DB 호출(실제) · 연습 모드 ─────────────────────────
    const checkScores = (d) => {
      if (!d || typeof d !== 'object' || !TEAM_KEYS.every((t) => Number.isFinite(Number(d[t])))) throw new Error('서버 답을 제대로 받지 못했어요.');
      return Object.fromEntries(TEAM_KEYS.map((t) => [t, Number(d[t])]));
    };
    const live = {
      async state() { calls.score_state++; return checkScores(await rpc('score_state', { p_code: code })); },
      async people() {
        calls.board_state++;
        const d = await rpc('board_state', { p_code: code });
        if (!d || !Array.isArray(d.people)) throw new Error('명단을 제대로 받지 못했어요.');
        return d.people;
      },
      // 서버가 현재 값에 더하고, 갱신한 네 팀 점수를 돌려줌. 같은 요청을 자동으로 다시 보내지 않음. 요청 번호(req)는 진행자가 다시 누를 때만 재사용(서버가 같은 번호는 한 번만 더함)
      async add(team, delta, req) { calls.score_add++; return checkScores(await rpc('score_add', { p_code: code, p_team: team, p_delta: delta, p_req: req })); },
    };
    // 연습 모드: 입구를 통과한 뒤에는 DB 를 전혀 부르지 않는다. 점수·이름은 이 화면 메모리에만 있고 새로 고치면 처음(0점)으로 돌아간다.
    const practice = {
      scores: Object.fromEntries(TEAM_KEYS.map((t) => [t, 0])),
      people: (() => {
        const names = ['토끼', '판다', '여우', '수달', '고래', '사자', '하마', '펭귄', '기린', '오리', '두더지', '너구리', '코알라', '미어캣', '알파카', '부엉이', '햄스터', '거북이', '다람쥐', '고슴도치', '사과', '포도', '자두', '레몬', '키위', '망고', '딸기', '앵두', '복숭아'];
        const sizes = { red: 10, blue: 7, yellow: 8, green: 4 }; // 팀원이 많은 칸·적은 칸을 함께 보려고 일부러 다르게
        const out = [];
        let i = 0;
        for (const t of TEAM_KEYS) for (let n = 0; n < sizes[t]; n++, i++) out.push({ id: i + 1, dept: `연습부 ${'가나다라마바'[i % 6]}`, name: `견본 ${names[i]}`, team: t });
        return out;
      })(),
      async add(team, delta) {
        await sleep(90); // 실제 요청처럼 잠깐 기다림
        const n = practice.scores[team] + delta;
        if (Math.abs(n) > C.maxTotal) { const e = new Error('팀 점수가 너무 커져요(±1,000,000,000 까지). 점수를 바꾸지 않았어요.'); e.code = 'practice'; throw e; }
        practice.scores[team] = n;
        return { ...practice.scores };
      },
    };
    const api = PRACTICE ? practice : live;
    if (PRACTICE) S.people = practice.people;

    // ── 화면 뼈대: 네 팀 칸 · 팀 고르기 단추 ─────────────
    const el = { score: {}, team: {}, tags: {}, names: {}, count: {}, pick: {} };
    for (const t of TEAM_KEYS) {
      const sec = document.createElement('section');
      sec.className = 'team';
      sec.id = `team-${t}`;
      sec.dataset.team = t;
      sec.dataset.testid = `score-team-${t}`;
      sec.setAttribute('data-testid', `score-team-${t}`);
      sec.setAttribute('aria-label', label(t));
      sec.innerHTML = `<h2 class="team-h team-${t}"><span class="tn">${esc(label(t))}</span><span class="tc" id="count-${t}"></span></h2>
        <div class="score-box"><div class="score" id="score-${t}" data-testid="score-${t}" data-team="${t}" data-value="" data-spin="" role="img"></div><div class="tags" id="tags-${t}" aria-hidden="true"></div></div>
        <p class="names" id="names-${t}" data-testid="score-names-${t}"></p>`;
      $('#teams').append(sec);
      el.team[t] = sec;
      el.score[t] = sec.querySelector('.score');
      el.tags[t] = sec.querySelector('.tags');
      el.names[t] = sec.querySelector('.names');
      el.count[t] = sec.querySelector('.tc');
      sec.addEventListener('click', (e) => { if (!e.target.closest('button, a, input')) selectTeam(t); });
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn pick team-${t}`;
      b.id = `pick-${t}`;
      b.dataset.team = t;
      b.setAttribute('data-testid', `score-pick-${t}`);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.title = `${label(t)} 고르기 (${TEAM_KEYS.indexOf(t) + 1})`;
      b.innerHTML = `<kbd>${TEAM_KEYS.indexOf(t) + 1}</kbd>${esc(TEAMS[t])}`;
      b.addEventListener('click', () => { selectTeam(t); b.blur(); });
      $('#picks').append(b);
      el.pick[t] = b;
    }

    // ── 점수 숫자 그리기 ─────────────────────────────────
    // 숫자 한 자리마다 세로로 긴 숫자띠(strip)가 위아래로 지나가는 슬롯 모양. 멈춰 있을 때도 같은 모양(칸 하나짜리 띠)이라 돌다 멈출 때 어긋나지 않는다.
    const DW = 0.7, CW = 0.3, SW = 0.68; // 숫자·쉼표·마이너스 한 칸의 너비(em). score.css 의 .dg .cm .sg 와 같음(글자 크기 자동 줄임 계산용)
    const digitsOf = (v) => String(Math.abs(v)).split('').reverse().map(Number); // 일의 자리부터
    const mod10 = (n) => ((n % 10) + 10) % 10;
    function layout(m, neg) { // m자리 숫자의 칸 나열: [{t:'s'}, {t:'d', r}, {t:'c'}, ...] 와 너비(em)
      const items = [];
      let wem = 0;
      if (neg) { items.push({ t: 's' }); wem += SW; }
      for (let r = m - 1; r >= 0; r--) {
        items.push({ t: 'd', r }); wem += DW;
        if (r > 0 && r % 3 === 0) { items.push({ t: 'c' }); wem += CW; }
      }
      return { items, wem };
    }
    // 글자 크기는 --wem(숫자 줄의 너비)에 맞춰 정해짐. 자릿수가 늘어 글자가 작아질 때는 바로 줄여 칸 밖으로 안 넘치게 하고, 커질 때만 서서히(.grow) 바꿈
    function setWem(box, wem) {
      const old = parseFloat(box.style.getPropertyValue('--wem')) || 0;
      box.classList.toggle('grow', wem < old);
      box.style.setProperty('--wem', String(wem));
    }
    function renderStatic(t) {
      const v = S.shown[t];
      const box = el.score[t];
      box.dataset.spin = '';
      box.classList.remove('spinning', 'sp-up', 'sp-down');
      if (v == null) {
        box.dataset.value = '';
        setWem(box, 1.4);
        box.innerHTML = '<span class="vis" aria-hidden="true"><span class="dg"><span class="strip"><i>–</i></span></span></span>';
        box.setAttribute('aria-label', `${label(t)} 점수를 아직 못 받았어요`);
        return;
      }
      const ds = digitsOf(v);
      const { items, wem } = layout(ds.length, v < 0);
      box.dataset.value = String(v);
      setWem(box, wem);
      box.setAttribute('aria-label', `${label(t)} ${fmt(v)}점`);
      box.innerHTML = `<span class="vis" aria-hidden="true">${items.map((it) => (it.t === 's' ? '<span class="sg">−</span>' : it.t === 'c' ? '<span class="cm">,</span>'
        : `<span class="dg"><span class="strip"><i>${ds[it.r]}</i></span></span>`)).join('')}</span>`;
    }

    // ── 슬롯 연출 ─────────────────────────────────────────
    // 점수가 올라가면 숫자가 위로 흘러 올라가고(띠가 위로 올라가며 아래에서 새 숫자가 나옴), 내려가면 아래로 흘러 내려간다.
    // 자리마다 띠의 길이(k칸)는 '도착 숫자가 되는 칸 수 + 한두 바퀴'. 시간은 늘 같음(C.spinMs): 처음에 빠르고 끝에서 느려지는(ease-out 3제곱) 속도로 k칸을 지나감.
    //   바뀐 점수가 아무리 커도 길이가 같고, 왼쪽 자리부터 조금씩 먼저 멈추고 일의 자리가 마지막에 멈춘다.
    const active = new Map(); // 팀 → 도는 연출
    let raf = 0;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    function snapshot(t) { // 지금 이 팀 점수가 '눈에 보이는' 자리별 숫자(도는 중이면 지금 보이는 숫자 — 새 목표로 이어 돌 때 시작점)
      const a = active.get(t);
      if (!a) { const v = S.shown[t] == null ? 0 : S.shown[t]; return { digits: digitsOf(v), len: String(Math.abs(v)).length, neg: v < 0 }; }
      const digits = [];
      for (const c of a.cols) digits[c.r] = c.cells[Math.max(0, Math.min(c.k, Math.round(c.pos)))];
      return { digits, len: a.toLen, neg: a.toNeg };
    }
    function startSpin(t, from, to, dir) {
      const prevAnim = active.get(t);
      if (prevAnim) active.delete(t);
      const toD = digitsOf(to);
      const toLen = toD.length;
      const m = Math.max(from.len, toLen);
      const toNeg = to < 0;
      const signSlot = from.neg || toNeg;
      const { items, wem } = layout(m, signSlot);
      const cols = [];
      for (let r = 0; r < m; r++) {
        const fd = from.digits[r] == null || r >= from.len ? 0 : from.digits[r];
        const td = toD[r] == null ? 0 : toD[r];
        const k = (r <= 1 ? 20 : 10) + mod10(dir === 'up' ? td - fd : fd - td); // 도착까지 지나갈 칸 수(일·십의 자리는 두 바퀴, 나머지는 한 바퀴 + 차이)
        const cells = [];
        for (let i = 0; i <= k; i++) cells.push(dir === 'up' ? (fd + i) % 10 : (td + i) % 10); // 올라갈 땐 출발→도착 순서로 위에서 아래로, 내려갈 땐 도착→출발 순서
        const idx = m - 1 - r; // 왼쪽부터 0
        cols.push({ r, k, cells, ti: C.spinMs * (0.6 + 0.4 * ((idx + 1) / m)), mode: r >= from.len ? 'in' : r >= toLen ? 'out' : 'keep', pos: dir === 'up' ? 0 : k });
      }
      const box = el.score[t];
      setWem(box, wem);
      box.dataset.spin = dir;
      box.dataset.value = String(to);
      box.setAttribute('aria-label', `${label(t)} ${fmt(to)}점`);
      box.classList.remove('hit-up', 'hit-down');
      box.classList.add('spinning', dir === 'up' ? 'sp-up' : 'sp-down');
      box.classList.remove(dir === 'up' ? 'sp-down' : 'sp-up');
      box.innerHTML = `<span class="vis" aria-hidden="true">${items.map((it) => {
        if (it.t === 's') return `<span class="sg" style="opacity:${from.neg ? 1 : 0}">−</span>`;
        if (it.t === 'c') return '<span class="cm">,</span>';
        const c = cols[it.r];
        return `<span class="dg" data-r="${it.r}"><span class="strip">${c.cells.map((d) => `<i>${d}</i>`).join('')}</span></span>`;
      }).join('')}</span>`;
      for (const c of cols) {
        c.win = box.querySelector(`.dg[data-r="${c.r}"]`);
        c.strip = c.win.firstElementChild;
        c.strip.style.transform = `translate3d(0, ${(-c.pos / (c.k + 1) * 100).toFixed(3)}%, 0)`;
        if (c.mode === 'in') c.win.style.opacity = '0';
      }
      const sg = box.querySelector('.sg');
      if (sg) requestAnimationFrame(() => { sg.style.opacity = toNeg ? '1' : '0'; }); // 마이너스 표시는 서서히 나타나거나 사라짐
      active.set(t, { team: t, dir, to, toLen, toNeg, cols, t0: performance.now() });
      if (!raf) raf = requestAnimationFrame(frame);
      updateControls();
    }
    function frame(now) {
      raf = 0;
      for (const a of [...active.values()]) {
        let all = true;
        for (const c of a.cols) {
          const x = Math.min(1, Math.max(0, (now - a.t0) / c.ti));
          const s = ease(x);
          c.pos = a.dir === 'up' ? c.k * s : c.k * (1 - s);
          c.strip.style.transform = `translate3d(0, ${(-c.pos / (c.k + 1) * 100).toFixed(3)}%, 0)`;
          if (c.mode === 'in') c.win.style.opacity = Math.min(1, x * 3).toFixed(2);
          else if (c.mode === 'out') c.win.style.opacity = Math.max(0, 1 - x * 1.4).toFixed(2);
          if (x < 1) all = false;
        }
        if (all) finishSpin(a);
      }
      if (active.size && !raf) raf = requestAnimationFrame(frame); // 끝난 연출이 다시 맞추려고 새 연출(startSpin)을 시작했으면 그쪽이 이미 루프를 잡아 둠: 둘이 되지 않게
    }
    const hitTimers = {};
    function hit(t, dir) { // 멈춘 순간 강조: 올라가면 밝게, 내려가면 가라앉게(움직임 줄이기에서는 색만)
      const box = el.score[t];
      const card = el.team[t];
      clearTimeout(hitTimers[t]);
      box.classList.remove('hit-up', 'hit-down');
      card.classList.remove('glow-up', 'glow-down');
      void box.offsetWidth;
      box.classList.add(dir === 'up' ? 'hit-up' : 'hit-down');
      card.classList.add(dir === 'up' ? 'glow-up' : 'glow-down');
      hitTimers[t] = setTimeout(() => { box.classList.remove('hit-up', 'hit-down'); card.classList.remove('glow-up', 'glow-down'); }, C.hitMs);
    }
    function finishSpin(a) {
      if (active.get(a.team) !== a) return;
      active.delete(a.team);
      renderStatic(a.team);
      hit(a.team, a.dir);
      reconcile(a.team); // 도는 동안 서버 값이 바뀌었으면 이제 맞춤
      updateControls();
    }
    function showTag(t, diff) { // +50 · −10
      const tag = document.createElement('span');
      tag.className = `delta ${diff > 0 ? 'up' : 'down'}`;
      tag.textContent = signed(diff);
      tag.style.setProperty('--n', String(S.tagN++ % 3));
      while (el.tags[t].children.length >= 4) el.tags[t].firstElementChild.remove();
      el.tags[t].append(tag);
      setTimeout(() => tag.remove(), C.tagMs);
    }

    // 이 팀의 화면 점수를 value 로 바꾼다(처음이면 바로, 아니면 슬롯 연출). 최종 표시값은 늘 value(서버가 돌려준 값).
    //   o.sound: 효과음(점수를 준 사람의 화면에서만. 조용히 맞출 때는 안 냄)
    //   o.delta: 내가 방금 보낸 요청이 더한 점수. 있으면 +N 표시·도는 방향·소리를 이 값으로 정하고(다른 곳에서 5초 안에 같은 팀이 바뀌었어도 준 점수 그대로),
    //            요청 전에 화면이 서버와 달랐던 차이는 연출 없이 조용히 먼저 맞춘다. 없으면(폴링·다른 탭) 화면 점수와의 차이를 씀
    function setTarget(t, value, o = {}) {
      let prev = S.shown[t];
      const given = Number.isInteger(o.delta) && o.delta !== 0 ? o.delta : null;
      if (given === null && prev === value) return false;
      let from = snapshot(t); // 연출의 시작점(S.shown 을 바꾸기 전에 잡음)
      if (given !== null && prev != null && value - given !== prev) { // 화면이 서버와 달랐음(다른 곳에서 바뀐 것): 먼저 조용히 맞춤
        const base = value - given;
        active.delete(t);
        S.shown[t] = base;
        renderStatic(t);
        prev = base;
        from = snapshot(t);
      }
      S.shown[t] = value;
      if (prev == null) { renderStatic(t); return true; } // 처음 받은 점수: 연출 없이 바로
      const diff = given !== null ? given : value - prev;
      const dir = diff > 0 ? 'up' : 'down';
      showTag(t, diff);
      if (o.sound) audio.play(dir, { reduced: reduced() });
      if (reduced()) { // 움직임 줄이기: 돌지 않고 바로 새 점수(강조는 색만)
        active.delete(t);
        renderStatic(t);
        hit(t, dir);
      } else {
        startSpin(t, from, value, dir);
      }
      updateControls();
      return true;
    }
    // 서버 점수와 화면 점수가 다르고 그 팀이 돌고 있지 않으면 조용히 맞춘다
    //   내가 준 것이 아닌 변화(다른 탭·관리자 초기화·늦게 반영된 요청)로 맞춰지는 팀이 '방금 준 것'(되돌리기용)의 팀이면 되돌리기를 비운다: 낡은 기록으로 점수를 깎지 않게
    function reconcile(t) {
      if (S.server && !active.has(t) && S.server[t] !== S.shown[t]) {
        if (S.last && S.last.team === t) S.last = null;
        setTarget(t, S.server[t], { sound: false });
        updateControls();
      }
    }

    // ── 이름 ──────────────────────────────────────────────
    function renderNames() {
      const by = Object.fromEntries(TEAM_KEYS.map((t) => [t, []]));
      const seen = new Map();
      for (const p of S.people) seen.set(String(p.name).trim(), (seen.get(String(p.name).trim()) || 0) + 1);
      for (const p of S.people) if (by[p.team]) by[p.team].push(p);
      const sig = JSON.stringify(TEAM_KEYS.map((t) => by[t].map((p) => [p.name, p.dept, seen.get(String(p.name).trim()) > 1])));
      if (sig === S.namesSig) return;
      S.namesSig = sig;
      for (const t of TEAM_KEYS) {
        const list = by[t].slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko') || String(a.dept || '').localeCompare(String(b.dept || ''), 'ko'));
        el.names[t].innerHTML = list.map((p) => `<span class="nm">${esc(p.name)}${seen.get(String(p.name).trim()) > 1 && p.dept ? `<small>(${esc(p.dept)})</small>` : ''}</span>`).join(' ');
        el.count[t].textContent = list.length ? `${list.length}명` : '';
      }
    }

    // ── 안내(상태 줄·경고 상자) ───────────────────────────
    const announce = (text) => { $('#live').textContent = text; };
    function setStatus(text, kind) { S.soundNote = false; S.status = text || ''; $('#status').textContent = text || ''; $('#status').dataset.kind = kind || ''; $('#status').title = text || ''; }
    function showAlert(msg, kind, scope) { // kind: 'error'(안 됐어요, 빨강) | 'warn'(됐는지 몰라요, 노랑)
      S.alert = { kind, msg, scope: scope || '' };
      $('#alertMsg').textContent = msg;
      $('#alert').dataset.kind = kind;
      $('#alert').hidden = false;
      $('#controls').classList.add('has-alert');
      announce(msg);
      updateControls();
    }
    function hideAlert(scope) {
      if (!S.alert || (scope && S.alert.scope !== scope)) return;
      S.alert = null;
      $('#alert').hidden = true;
      $('#alertMsg').textContent = '';
      $('#controls').classList.remove('has-alert');
      updateControls();
    }

    // ── 점수 주기 ─────────────────────────────────────────
    // 한 번에 한 요청: 서버 답을 기다리는 동안(busy)은 점수 단추·키가 모두 잠긴다. 그 사이 누른 것은 큐에 쌓지 않고 무시한다(두 번 들어가지 않게).
    // 답이 오면 서버가 돌려준 점수가 진짜 값이라 그 값으로 연출이 돌고, 실패하면 화면 점수는 그대로 둔다.
    const canGive = () => S.ready && !S.busy && !S.verifying && !S.dialog && !locking;
    function selectTeam(t) {
      S.team = t;
      for (const k of TEAM_KEYS) {
        el.team[k].classList.toggle('sel', k === t);
        el.pick[k].setAttribute('aria-checked', String(k === t));
      }
      $('#picks').classList.add('has-sel');
      $('#picks').classList.remove('need');
      updateControls();
    }
    function nudgePick() { const p = $('#picks'); p.classList.remove('need'); void p.offsetWidth; p.classList.add('need'); setTimeout(() => p.classList.remove('need'), 1500); }
    async function give(team, delta, o = {}) {
      if (!canGive()) return false;
      if (!TEAMS[team]) { setStatus('먼저 팀을 골라 주세요 (1~4)', 'warn'); nudgePick(); return false; }
      if (!Number.isInteger(delta) || delta === 0) { setStatus('점수를 넣어 주세요.', 'warn'); return false; }
      if (Math.abs(delta) > C.maxStep) { setStatus(`한 번에 줄 수 있는 점수는 ${C.maxStep.toLocaleString('en-US')}점까지예요.`, 'warn'); return false; }
      audio.unlock(); // 누른 바로 이 순간(사용자 동작) 오디오를 깨움 — 답이 온 뒤 소리가 나게
      // 요청 번호: 응답을 못 받았던 요청과 같은 팀·같은 점수를 (기억 시간 안에) 다시 누르면 같은 번호를 다시 씀 → 늦게 도착한 원래 요청이 있어도 서버가 한 번만 더함.
      //   번호는 (팀, 점수)마다 따로 기억하므로 그 사이 다른 점수를 줘도 남아 있다. 다른 팀·다른 점수를 누르면 새 번호(그 요청은 옛 요청과 별개).
      //   다시 보낸 요청이 성공하면 그 번호만 지우고, 서버가 확실히 거절하면 그 번호를 지움(giveFailed). 기억 시간이 지난 번호는 정리
      const key = `${team}|${delta}`;
      pruneOld();
      const p = S.pend.get(key);
      const reuse = !!p;
      const req = reuse ? p.req : newReq();
      const base = S.server ? S.server[team] : null; // 이 요청을 보내기 전에 알던 서버 점수
      S.busy = true;
      S.sending = { team, delta };
      S.writes++;
      setStatus(`${label(team)} ${signed(delta)} 저장 중…`, 'busy');
      hideAlert();
      updateControls();
      let res = null;
      let err = null;
      try { res = await api.add(team, delta, req); } catch (e) { err = e; }
      S.writes++;
      S.busy = false;
      S.sending = null;
      if (err) return giveFailed(err, team, delta, req);
      S.pend.delete(key); // 서버가 답함: 이 (팀, 점수)의 번호는 끝난 것(다른 번호는 그대로)
      S.server = { ...res };
      S.pollFails = 0;
      updateLink();
      if (reuse && base != null && res[team] === base) { // 다시 보낸 요청인데 점수가 그대로: 서버가 이미 처리한 요청이라 더하지 않음(그 뒤 점수가 바뀐 경우 등)
        setTarget(team, res[team], { sound: false });
        for (const t of TEAM_KEYS) if (t !== team) reconcile(t);
        S.last = null;
        setStatus(`${label(team)} ${signed(delta)}은 이미 반영된 요청이라 다시 더하지 않았어요 → ${fmt(res[team])}점`, 'warn');
        announce(`${label(team)} ${signed(delta)}은 이미 반영돼 있어요. ${fmt(res[team])}점`);
        updateControls();
        return true;
      }
      setTarget(team, res[team], { sound: true, delta });
      for (const t of TEAM_KEYS) if (t !== team) reconcile(t); // 다른 곳에서 바뀐 다른 팀 점수도 함께 맞춤
      S.last = o.undo ? null : { team, delta };
      setStatus(`${label(team)} ${signed(delta)}${o.undo ? ' (되돌림)' : ''} → ${fmt(res[team])}점`, 'ok');
      announce(`${label(team)} ${signed(delta)}, ${fmt(res[team])}점`);
      updateControls();
      return true;
    }
    function pruneOld() { const now = Date.now(); for (const [k, v] of S.pend) if (now >= v.until) S.pend.delete(k); }
    function giveFailed(e, team, delta, req) {
      const msg = String((e && e.message) || '').trim() || '알 수 없는 오류';
      if (isAuthErr(e)) { lockNow('auth'); return false; }
      // 서버가 이유를 적어 거절한 오류(e.code 있음)면 확실히 안 들어간 것(요청 번호도 버림). 그 밖(시간 초과·통신 끊김·이상한 답)은 서버에 들어갔는지 모른다.
      const uncertain = !e.code || e.retryable;
      if (!uncertain) {
        S.pend.delete(`${team}|${delta}`); // 확실히 안 들어갔으니 번호도 버림
        setStatus(`${label(team)} ${signed(delta)} 저장 안 됨`, 'warn');
        showAlert(`저장하지 못했어요: ${msg} 점수는 그대로예요. 다시 눌러 주세요.`, 'error', 'give');
        return false;
      }
      S.pend.set(`${team}|${delta}`, { team, delta, req, until: Date.now() + C.pendMs }); // 요청이 나중에 서버에 도착할 수도 있음: 번호를 기억해 두었다가 같은 점수를 다시 누르면 재사용
      S.verifying = { team, delta, before: S.shown[team] };
      setStatus('저장됐는지 서버 점수를 확인하는 중…', 'busy');
      showAlert(`${label(team)} ${signed(delta)} 저장 응답을 받지 못했어요(통신이 끊겼거나 너무 느렸어요). 서버에는 들어갔을 수도 있어서 같은 요청을 다시 보내지 않았어요. 서버 점수를 다시 읽어 화면을 맞출게요.`, 'warn', 'give');
      schedulePoll(C.verifyMs);
      return false;
    }
    // 저장 응답을 못 받은 뒤 서버 점수를 다시 읽는 데 성공했을 때: 들어갔는지 알려 줌
    function resolveVerify() {
      const v = S.verifying;
      if (!v || !S.server) return;
      S.verifying = null;
      const now = S.server[v.team];
      const base = v.before == null ? now : v.before;
      let msg;
      if (now - base === v.delta) {
        S.pend.delete(`${v.team}|${v.delta}`); // 들어간 것이 확인됨: 같은 점수를 또 누르면 새로 주는 것
        S.last = { team: v.team, delta: v.delta };
        msg = `${label(v.team)} ${signed(v.delta)}은 저장돼 있었어요. 화면을 서버 점수(${fmt(now)}점)에 맞췄어요. 다시 누르지 않아도 돼요.`;
        showAlert(msg, 'warn', 'give');
      } else if (now === base) {
        // 아직 안 들어갔을 뿐, 요청이 늦게 도착해 반영될 수도 있음(요청 번호는 그대로 기억 중). 같은 점수를 다시 누르면 같은 번호라 두 번 들어가지 않음
        msg = `${label(v.team)} ${signed(v.delta)}은 아직 반영되지 않았어요(점수 ${fmt(now)}점 그대로). 늦게 반영될 수도 있으니 점수가 맞는지 확인해 주세요. 같은 팀에 같은 점수를 2분 안에 다시 누르면(그 사이 다른 점수를 줘도) 두 번 들어가지 않아요.`;
        showAlert(msg, 'warn', 'give');
      } else {
        msg = `서버 점수(${label(v.team)} ${fmt(now)}점)가 화면과 달라서 맞췄어요. ${signed(v.delta)}이 들어갔는지 점수를 확인한 뒤 필요하면 다시 눌러 주세요. 같은 팀에 같은 점수를 2분 안에 다시 누르면(그 사이 다른 점수를 줘도) 두 번 들어가지 않아요.`;
        showAlert(msg, 'warn', 'give');
      }
      setStatus('', '');
      updateControls();
    }
    const undo = () => { const l = S.last; return l ? give(l.team, -l.delta, { undo: true }) : false; };
    function parseAmount(raw) {
      const t = String(raw).replace(/[,\s]/g, '').replace(/[−–—－]/g, '-').replace(/＋/g, '+');
      return /^[+-]?\d{1,9}$/.test(t) ? parseInt(t, 10) : null;
    }
    // 직접 넣은 점수: 더하기 = 입력한 수 그대로(−50 을 적으면 −50), 빼기 = 늘 마이너스(50 이든 −50 이든 −50 — 빼기를 눌렀는데 점수가 오르는 일이 없게)
    function giveCustom(sign) {
      if (!canGive()) return false;
      const n = parseAmount($('#customAmt').value);
      if (n === null) { setStatus('점수는 숫자로 넣어 주세요(예: 30).', 'warn'); $('#customAmt').focus(); return false; }
      if (n === 0) { setStatus('0점은 줄 수 없어요.', 'warn'); $('#customAmt').focus(); return false; }
      if (!S.team) { setStatus('먼저 팀을 골라 주세요 (1~4)', 'warn'); nudgePick(); return false; }
      const sent = $('#customAmt').value; // 보낸 값(입력 원문)
      return give(S.team, sign < 0 ? -Math.abs(n) : n).then((ok) => {
        // 요청이 오가는 사이 다음 숫자를 쳐 두었으면(칸의 값이 보낸 값과 다름) 지우지 않음
        if (ok && $('#customAmt').value === sent) { $('#customAmt').value = ''; if (document.activeElement === $('#customAmt')) $('#customAmt').blur(); }
        return ok;
      });
    }

    // ── 서버 점수·이름 다시 받기(5초마다) ─────────────────
    // 다른 탭·관리자 페이지에서 바뀐 점수도 이 화면에 맞춘다. 돌고 있는 연출은 방해하지 않고(그 팀은 연출이 끝난 뒤 맞춤), 저장 요청이 끼어든 받기는 오래된 값일 수 있어 버린다.
    function updateLink() { $('#linkWarn').hidden = S.pollFails < 2; }
    async function refreshOnce() {
      if (PRACTICE) return true;
      if (locking) return false;
      if (S.polling) { S.pollAgain = true; return false; }
      S.polling = true;
      const w0 = S.writes;
      let ok = false;
      try {
        const [sc, pe] = await Promise.allSettled([api.state(), api.people()]);
        if (locking) return false; // 잠그는 사이 날아간 받기: 결과를 화면·상태에 반영하지 않음
        for (const r of [sc, pe]) if (r.status === 'rejected' && isAuthErr(r.reason)) return lockNow('auth');
        if (pe.status === 'fulfilled') { S.people = pe.value; renderNames(); }
        if (sc.status === 'rejected') {
          S.pollFails++;
          updateLink();
          if (!S.ready) showAlert(`점수를 불러오지 못했어요: ${String(sc.reason && sc.reason.message || '알 수 없는 오류')} 아래 단추로 다시 받아 주세요.`, 'error', 'load');
        } else if (S.writes !== w0 || S.busy) {
          S.pollAgain = true; // 받는 사이 저장이 있었음 → 이 값은 버리고 곧 다시 받음
        } else {
          ok = true;
          S.pollFails = 0;
          updateLink();
          S.server = sc.value;
          for (const t of TEAM_KEYS) reconcile(t);
          if (!S.ready) { S.ready = true; hideAlert('load'); setStatus('팀을 고르고(1~4) 점수를 주세요.', ''); updateControls(); }
          resolveVerify();
        }
      } finally { S.polling = false; }
      return ok;
    }
    stopApp = () => { clearTimeout(S.pollTimer); S.pollAgain = false; }; // 잠그는 순간: 다음 받기 예약을 지움
    function schedulePoll(ms) {
      if (PRACTICE || locking) return;
      clearTimeout(S.pollTimer);
      S.pollTimer = setTimeout(async () => {
        if (locking) return;
        if (!document.hidden || S.verifying || !S.ready) await refreshOnce();
        if (locking) return;
        const again = S.pollAgain;
        S.pollAgain = false;
        schedulePoll(again ? 800 : C.pollMs);
      }, ms);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });

    // ── 소리·이름·잠그기·전체 화면 단추 ───────────────────
    function updateControls() {
      const can = canGive();
      for (const b of document.querySelectorAll('.quick, #addBtn, #subBtn')) b.disabled = !can;
      $('#undoBtn').disabled = !can || !S.last;
      $('#undoWhat').textContent = S.last ? `${TEAMS[S.last.team]} ${signed(S.last.delta)}` : '';
      $('#lockBtn').disabled = S.busy || !!S.dialog;
      const sb = $('#soundBtn');
      sb.textContent = audio.muted ? '🔇 소리 꺼짐' : '🔊 소리 켜짐';
      sb.setAttribute('aria-pressed', String(!audio.muted));
      const nb = $('#namesBtn');
      nb.textContent = S.namesOff ? '이름 보이기' : '이름 숨기기';
      nb.setAttribute('aria-pressed', String(S.namesOff));
      stage.dataset.names = S.namesOff ? 'off' : 'on';
      document.body.dataset.phase = S.busy ? 'saving' : S.verifying ? 'verifying' : active.size ? 'spinning' : S.ready ? 'idle' : 'loading';
    }
    function toggleSound() {
      audio.setMuted(!audio.muted);
      if (!audio.muted && S.soundNote) setStatus('', ''); // 소리를 켜면 '소리가 꺼져 있어서 안 들려요' 안내만 지움(다른 안내는 그대로)
      updateControls();
    }
    function soundTest() {
      audio.unlock();
      audio.play('test');
      if (audio.muted) { setStatus('소리가 꺼져 있어서 안 들려요. ‘소리 켜짐’으로 바꿔 주세요.', 'warn'); S.soundNote = true; }
      else setStatus('소리 시험: 올라가는 소리 → 내려가는 소리', '');
    }
    function toggleNames() {
      S.namesOff = !S.namesOff;
      try { sessionStorage.setItem('score-names-off', S.namesOff ? '1' : '0'); } catch {}
      updateControls();
    }
    function toggleFs() {
      const d = document;
      const root = d.documentElement;
      try {
        if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
        else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      } catch {}
    }

    // ── 확인 상자(화면 안) ────────────────────────────────
    let dlgDone = null;
    let dlgOpenAt = 0;
    const DLG_GUARD_MS = 500; // 열린 직후 이 시간의 키 입력은 무시(습관적으로 누른 키가 바로 확정되지 않게)
    const dlgGuarded = () => performance.now() - dlgOpenAt < DLG_GUARD_MS;
    function ask(name, o) {
      S.dialog = name;
      $('#dlgTitle').textContent = o.title;
      $('#dlgBody').innerHTML = o.body;
      $('#dlgOk').textContent = o.ok;
      $('#dlgOk').className = `btn ${o.danger ? 'danger' : 'primary'}`;
      $('#dlg').hidden = false;
      updateControls();
      dlgOpenAt = performance.now();
      $('#dlgCancel').focus(); // 초점은 늘 '취소'
      return new Promise((res) => { dlgDone = res; });
    }
    function closeDialog(yes) {
      if (!S.dialog) return;
      S.dialog = null;
      $('#dlg').hidden = true;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      updateControls();
      const r = dlgDone;
      dlgDone = null;
      if (r) r(!!yes);
    }
    $('#dlgOk').addEventListener('click', (e) => { if (e.detail === 0 && dlgGuarded()) return; closeDialog(true); });
    $('#dlgCancel').addEventListener('click', (e) => { if (e.detail === 0 && dlgGuarded()) return; closeDialog(false); });
    document.addEventListener('keyup', (e) => { if (S.dialog && (e.key === ' ' || e.key === 'Enter') && dlgGuarded()) e.preventDefault(); }, true);
    $('#dlg').addEventListener('click', (e) => { if (e.target === $('#dlg')) closeDialog(false); });
    $('#dlg').addEventListener('keydown', (e) => { if (e.key !== 'Tab') return; e.preventDefault(); (document.activeElement === $('#dlgOk') ? $('#dlgCancel') : $('#dlgOk')).focus(); });
    async function askLock() {
      if (S.busy || S.dialog) return;
      const yes = await ask('lock', {
        title: '화면을 잠글까요?',
        body: '이 탭에 기억한 관리자 비밀번호를 지우고 비밀번호 입력 화면으로 돌아가요. 다시 열려면 비밀번호를 넣어야 해요.<br>저장된 점수는 그대로예요.',
        ok: '잠그기',
      });
      if (yes && !S.busy) lockNow('lock');
    }

    // ── 단추 · 키 ─────────────────────────────────────────
    const blurAfter = (fn) => (e) => { fn(e); if (e.currentTarget.blur) e.currentTarget.blur(); }; // 단추에 초점이 남아 Enter·스페이스가 그 단추를 또 누르지 않게
    for (const b of document.querySelectorAll('.quick')) b.addEventListener('click', blurAfter(() => give(S.team, Number(b.dataset.delta))));
    $('#addBtn').addEventListener('click', blurAfter(() => giveCustom(1)));
    $('#subBtn').addEventListener('click', blurAfter(() => giveCustom(-1)));
    $('#undoBtn').addEventListener('click', blurAfter(() => undo()));
    $('#soundBtn').addEventListener('click', blurAfter(() => toggleSound()));
    $('#soundTestBtn').addEventListener('click', blurAfter(() => soundTest()));
    $('#namesBtn').addEventListener('click', blurAfter(() => toggleNames()));
    $('#fsBtn').addEventListener('click', blurAfter(() => toggleFs()));
    $('#lockBtn').addEventListener('click', blurAfter(() => askLock()));
    $('#alertClose').addEventListener('click', blurAfter(() => hideAlert()));
    $('#refreshBtn').addEventListener('click', blurAfter(() => { if (!PRACTICE) schedulePoll(0); }));
    $('#customAmt').addEventListener('input', () => { const v = $('#customAmt').value; const c = v.replace(/[^0-9+\-−–＋－,\s]/g, ''); if (c !== v) $('#customAmt').value = c; });
    $('#customAmt').addEventListener('keydown', (e) => { // 직접 넣는 칸: Enter = 더하기, Shift+Enter = 빼기, Esc = 비우고 나가기
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) giveCustom(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); $('#customAmt').value = ''; $('#customAmt').blur(); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // 글자를 치는 중엔 가로채지 않음
      if (S.dialog) {
        if (e.key === 'Escape') { if (!e.repeat) { e.preventDefault(); closeDialog(false); } return; }
        if (e.repeat || dlgGuarded()) e.preventDefault();
        return;
      }
      const onControl = t && t.closest && t.closest('button, a, summary, select');
      if ((e.key === 'Enter' || e.key === ' ') && onControl) { if (e.repeat) e.preventDefault(); return; } // 단추 위의 Enter·스페이스는 브라우저가 한 번만 누름(누르고 있는 반복은 막음)
      const code = e.code;
      const digit = /^(?:Digit|Numpad)([1-4])$/.exec(code);
      if (digit) { selectTeam(TEAM_KEYS[Number(digit[1]) - 1]); return; }
      if (e.repeat) { if (code === 'KeyF' || e.key === 'Enter') e.preventDefault(); return; } // 키를 누르고 있어 반복되는 입력은 모두 무시: 점수가 계속 들어가거나 소리·이름·전체 화면이 계속 바뀌지 않게
      if (code === 'KeyM') { toggleSound(); return; }
      if (code === 'KeyF') { e.preventDefault(); toggleFs(); return; }
      if (code === 'KeyH') { toggleNames(); return; }
      if (code === 'KeyR') { if (!PRACTICE) schedulePoll(0); return; }
      if (code === 'KeyU') { undo(); return; }
      if (e.key === 'Enter') { e.preventDefault(); $('#customAmt').focus(); $('#customAmt').select(); return; } // Enter → 점수 칸으로. 숫자를 치고 Enter 로 주기
      const q = [...document.querySelectorAll('.quick')].find((b) => b.dataset.key === code);
      if (q) { give(S.team, Number(q.dataset.delta)); }
    });

    // ── 화면 꺼짐 막기(지원하는 브라우저에서) ─────────────
    let wake = null;
    async function keepAwake() {
      if (wake || document.hidden || !navigator.wakeLock) return;
      try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch { wake = null; }
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });

    // ── 시험용 상태 요약(읽기 전용, window.__score) ───────
    function summary() {
      return Object.freeze({
        version: 1,
        mode: PRACTICE ? 'practice' : 'live',
        view: 'board',
        phase: document.body.dataset.phase,
        ready: S.ready,
        busy: S.busy,                  // 서버 답을 기다리는 중(점수 단추 잠김)
        locked: !canGive(),
        sending: S.sending ? Object.freeze({ ...S.sending }) : null,
        verifying: S.verifying ? Object.freeze({ ...S.verifying }) : null, // 저장 응답을 못 받아 서버 점수를 확인하는 중
        team: S.team,
        shown: Object.freeze({ ...S.shown }), // 화면이 보여 주는(돌아서 가는 중이면 도착할) 점수
        server: S.server ? Object.freeze({ ...S.server }) : null,
        spinning: Object.freeze(Object.fromEntries(TEAM_KEYS.map((t) => [t, active.has(t) ? active.get(t).dir : null]))),
        animating: active.size > 0,
        last: S.last ? Object.freeze({ ...S.last }) : null,
        namesHidden: S.namesOff,
        people: S.people.length,
        muted: audio.muted,
        reduced: reduced(),
        dialog: S.dialog,
        error: S.alert ? S.alert.msg : null,
        errorKind: S.alert ? S.alert.kind : null,
        status: S.status,
        pollFails: S.pollFails,
        pend: S.pend.size,             // 기억해 둔 요청 번호 수
        calls: Object.freeze({ ...calls }),
      });
    }

    // ── 시작(입구를 통과한 뒤) ────────────────────────────
    if (PRACTICE) {
      $('#practiceBadge').hidden = false;
      $('#watermark').hidden = false;
      $('#toPractice').hidden = true;
      $('#toLive').hidden = false;
      document.title = '연습 · 팀 점수판';
      $('#title').textContent = '팀 점수판';
    } else {
      document.title = '팀 점수판';
    }
    for (const t of TEAM_KEYS) renderStatic(t);
    renderNames();
    updateControls();
    keepAwake();
    if (PRACTICE) {
      S.server = { ...practice.scores };
      for (const t of TEAM_KEYS) setTarget(t, 0, {});
      S.ready = true;
      setStatus('연습 중이에요 · 점수는 저장되지 않아요', '');
      updateControls();
    } else {
      setStatus('점수를 불러오는 중…', 'busy');
      refreshOnce().then(() => { if (!locking) { const again = S.pollAgain; S.pollAgain = false; schedulePoll(again ? 800 : C.pollMs); } });
    }
    return () => {
      try { return summary(); } catch (e) { // 상태가 망가져도 시험이 읽다가 멈추지 않게
        return Object.freeze({ version: 1, mode: PRACTICE ? 'practice' : 'live', view: 'board', error: String(e && e.message) });
      }
    };
  }

  gateInit();
})();
