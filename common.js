// 참가자 화면(index.html)과 진행자 화면(board.html)이 같이 쓰는 설정·도구

// Supabase 연결용 파일(supabase.js)을 못 받았으면(통신 불안정·차단) 화면이 말없이 멈추지 않게 안내를 띄우고 여기서 멈춘다
if (typeof supabase === 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#error').textContent = '필요한 파일을 받지 못했어요. 인터넷 연결을 확인한 뒤 새로고침하거나 다른 브라우저로 열어 주세요.';
    const loading = document.querySelector('#loading'); // 참가자 화면의 "불러오는 중…"
    if (loading) loading.hidden = true;
  });
  throw new Error('supabase.js 를 받지 못했어요');
}

// Supabase: 대시보드 → Project Settings → API. 공개용(publishable) 키만 넣는다. secret/service_role 키는 절대 금지.
const SUPABASE_URL = 'https://qvplrrhxlrzqvnqfpfsu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_qC654tfLhn9u0OrPk2xtqA_7zIMTeCO';
// 이 사이트는 Supabase 로그인(세션)을 쓰지 않고 공개 키로 함수만 부르므로, 세션을 저장·갱신·주소에서 찾지 않게 끔(불필요한 저장·요청을 줄임)
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const TEAMS = { red: '빨강', blue: '파랑', yellow: '노랑', green: '초록' };
const TEAM_KEYS = Object.keys(TEAMS);
// 조식 메뉴. 앞의 영어 이름은 DB에 저장되는 값이자 그림 파일 이름(menu_이름_art.jpg = 일러스트, menu_이름_photo.jpg = 사진)
const MENUS = { ugeoji: '우거지 해장국', miyeok: '소고기 미역국', hwangtae: '버섯 황태 해장국' };
const MENU_KEYS = Object.keys(MENUS);
// 객실 7개(남자 5 + 여자 2). 앞의 영어 이름은 DB에 저장되는 값이고, 첫 글자가 방의 성별(m = 남자 방, f = 여자 방)
const ROOMS = { m1: '남자 1호', m2: '남자 2호', m3: '남자 3호', m4: '남자 4호', m5: '남자 5호', f1: '여자 1호', f2: '여자 2호' };
const ROOM_KEYS = Object.keys(ROOMS);
const roomGender = (key) => (key[0] === 'm' ? '남' : '여');
// 저녁 식사 뒤 자유시간에 할 것
const ACTS = { ski: '스키', rest: '휴식' };
const ACT_KEYS = Object.keys(ACTS);

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const showError = (msg) => { $('#error').textContent = msg || ''; };

// 일정표 글 → 화면에 넣을 HTML. 한 줄에 하나씩 적은 글을 읽는다.
//   시간으로 시작하는 줄("10:00 도착", "14:00~16:00 팀 게임")은 일정, 그 밖의 줄("Day 1 · 12/17(목) — 화합과 소통")은 그 아래 일정들의 제목.
//   시간 뒤를 띄우지 않았거나("10:00도착") 시간만 적은 줄도 일정으로 읽는다
//   이미 일정이 있는 날짜 안에서 시간 없는 줄이 나오면, 날짜·Day 모양이 아닌 한("※ 우천 시 실내 진행", "- 준비물: 수건") 새 제목이 아니라 바로 앞 일정의 작은 설명으로 붙인다
const PLAN_LINE = /^((?:[01]?\d|2[0-4]):[0-5]\d)(?:\s*[~\-–—∼～]\s*((?:[01]?\d|2[0-4]):[0-5]\d)?)?\s*(.*)$/;
const PLAN_DATE_LIKE = /\d{1,2}\s*\/\s*\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일|Day\s*\d/i; // 날짜·Day 모양이면 새 날짜 제목으로 봄
// 일정의 종류: 내용에 든 낱말로 그림 표시와 색을 고른다(위에서부터 먼저 맞는 것). 맞는 낱말이 없으면 작은 점만 찍는다
const PLAN_KINDS = [
  ['meal', '🍴', /조식|중식|석식|아침|점심|저녁|식사|만찬|간식|바비큐/],
  ['photo', '📷', /사진|촬영/],
  ['play', '🎉', /레크|게임|장기자랑|이벤트/],
  ['talk', '🎤', /강의|특강|강연|교육|세션|오프닝|클로징|발표|프로그램/],
  ['move', '🚌', /출발|도착|이동|집결|체크인|체크아웃|입실|퇴실/],
  ['rest', '🌿', /자유|휴식|산책|취침/],
];
// 날짜 제목에서 [월, 일]을 읽음("12/17", "12월 17일" 둘 다). 못 읽으면 null
function planDate(title) {
  const m = title.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/) || title.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
// opt.now(Date)를 주면 그 시각 기준으로 오늘 날짜 묶음만 펼치고(다른 날짜는 접음) 지금 할 일(없으면 다음 일정)에 표시를 붙임.
// 오늘이 일정에 없는 날이면 opt 가 없을 때와 똑같이 그림. 진행자 화면 미리보기는 opt 를 주지 않음
function planHtml(text, opt) {
  const now = opt && opt.now instanceof Date ? opt.now : null;
  const days = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(PLAN_LINE);
    const last = days[days.length - 1];
    if (!m) {
      if (last && last.items.length && !PLAN_DATE_LIKE.test(line)) last.items[last.items.length - 1].notes.push(line); // 앞 일정의 작은 설명
      else days.push({ title: line, items: [] });
      continue;
    }
    if (!days.length) days.push({ title: '', items: [] }); // 제목 없이 일정부터 적은 경우
    days[days.length - 1].items.push({ start: m[1].padStart(5, '0'), end: m[2] ? m[2].padStart(5, '0') : '', what: m[3], notes: [] });
  }
  // 제목 줄 "Day 1 · 12/17(목) — 화합과 소통" → 꼬리표 "Day 1" + 날짜 "12/17(목)" + 주제 "화합과 소통". 가운뎃점·줄표가 없으면 통째로 날짜 자리에
  const head = (title) => {
    const [main, ...rest] = title.split(/\s+[—–-]\s+/);
    const parts = main.split(/\s*·\s*/).filter(Boolean);
    const tag = parts.length > 1 ? parts.shift() : '';
    return `<h3 class="plan-head">${tag ? `<span class="plan-tag">${esc(tag)}</span>` : ''}<span class="plan-date">${esc(parts.join(' · '))}</span>${
      rest.length ? `<span class="plan-theme">${esc(rest.join(' — '))}</span>` : ''}</h3>`;
  };
  // 일정 한 줄: 시간(시작 굵게, 끝은 작게) | 그림 표시 | 내용. "오프닝 : 대표 인사" 처럼 쌍점으로 나눈 뒷부분과 덧붙인 줄은 작은 글로 아래에
  const item = (it, mark) => {
    const [kind, icon] = PLAN_KINDS.find((k) => k[2].test(it.what)) || ['etc', ''];
    const cut = it.what.search(/\s+:\s+/);
    const name = cut < 0 ? it.what : it.what.slice(0, cut);
    const more = cut < 0 ? '' : it.what.slice(cut).replace(/^\s+:\s+/, '');
    const small = [more, ...it.notes].filter(Boolean).map((t) => `<small>${esc(t)}</small>`).join('');
    const flag = mark === 'now' ? '<span class="plan-flag">지금</span>' : mark === 'next' ? '<span class="plan-flag">다음</span>' : '';
    return `<li class="k-${kind}${mark ? ` is-${mark}` : ''}"><time><b>${esc(it.start)}</b>${it.end ? `<span>~${esc(it.end)}</span>` : ''}</time>`
      + `<span class="plan-dot" aria-hidden="true">${icon}</span>`
      + `<span class="plan-what"><span class="plan-text">${flag}${esc(name)}</span>${small}</span></li>`;
  };
  // 지금 시각(분)에 해당하는 일정 번호. 끝 시간이 없으면 다음 일정이 시작할 때까지. 해당하는 것이 없으면 다음 일정. 다 지났으면 없음
  const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const marks = (items) => {
    const t = now.getHours() * 60 + now.getMinutes();
    let cur = -1;
    items.forEach((it, i) => {
      const s = minutes(it.start);
      let e = it.end ? minutes(it.end) : i + 1 < items.length ? minutes(items[i + 1].start) : 24 * 60;
      if (e <= s) e += 24 * 60; // 자정을 넘기는 일정
      if (s <= t && t < e) cur = i;
    });
    const at = cur >= 0 ? cur : items.findIndex((it) => minutes(it.start) > t);
    return items.map((_, i) => (i === at ? (cur >= 0 ? 'now' : 'next') : ''));
  };
  const dateOf = days.map((d) => planDate(d.title));
  const isToday = (dt) => !!(now && dt && dt[0] === now.getMonth() + 1 && dt[1] === now.getDate());
  const hasToday = dateOf.some(isToday); // 오늘이 일정에 있는 날일 때만 펼침·표시를 바꿈
  // 날짜마다 접고 펼 수 있음(머리띠를 누름). 제목만 있고 일정이 없거나, 제목 없이 일정만 있는 묶음은 접을 것이 없어 그냥 보여줌
  return days.map((d, i) => {
    const today = hasToday && isToday(dateOf[i]);
    const mk = today ? marks(d.items) : [];
    const list = d.items.length ? `<ol class="plan">${d.items.map((it, j) => item(it, mk[j])).join('')}</ol>` : '';
    return d.title && list ? `
    <details class="plan-day"${!hasToday || today ? ' open' : ''}><summary>${head(d.title)}</summary>${list}</details>` : `
    <div class="plan-day">${d.title ? head(d.title) : ''}${list}</div>`;
  }).join('');
}

// DB 함수 호출. 오류면 한국어 메시지로 throw.
// 20초 안에 답이 없으면 더 기다리지 않고 알린다. 참가자 함수(메뉴 고르기·팀 뽑기)는 같은 요청을 다시 받아도 결과가 같아 다시 눌러도 안전하고,
// 진행자 화면은 저장 뒤 다시 받기만 실패한 경우를 따로 알려 두 번 하지 않게 한다(board.html 의 reload·resync).
// 세 번째 인자 { retry: 2, onRetry(n) }: 사람이 몰려 실패한 경우(DB 시간 초과·잠금 충돌·연결 풀 대기 초과(PGRST003)·HTTP 502/503/504, 통신 끊김)에만 0.5~2초 쉬었다 최대 2번 자동으로 다시 보냄.
//   같은 요청을 다시 보내도 결과가 같은 참가자 함수에만 켠다(진행자 화면의 기존 호출은 인자가 없어 예전 그대로). 20초 시간 초과는 서버가 아직 처리 중일 수 있어 다시 보내지 않음
const RPC_WAIT = 20000;
const RETRY_CODES = ['57014', '55P03', '40001', '40P01', 'PGRST003']; // Postgres: 시간 초과, 잠금을 못 얻음, 동시 처리 충돌, 교착 / PostgREST: 연결 풀 대기 시간 초과
const RETRY_HTTP = [502, 503, 504]; // 게이트웨이·서버가 잠깐 못 받아 준 경우(HTTP 상태)
const NET_FAIL = /failed to fetch|networkerror|network request failed|load failed/i;
function koreanError(msg, code, status) {
  msg = String(msg || '');
  if (/[가-힣]/.test(msg)) return msg;
  if (/fetch|network|load failed/i.test(msg)) return '인터넷 연결을 확인한 뒤 다시 눌러 주세요.'; // 통신이 끊김("Failed to fetch" 등)
  if (RETRY_CODES.includes(code) || RETRY_HTTP.includes(status) || /timeout|timed out|canceling statement|lock|deadlock|serialize/i.test(msg)) return '사람이 몰려 조금 늦어지고 있어요. 잠시 뒤 다시 눌러 주세요.'; // DB 시간 제한
  return '잠시 문제가 생겼어요. 다시 눌러 주세요. 계속되면 진행자에게 알려 주세요.'; // 일시정지된 프로젝트·함수 없음 등
}
async function rpcOnce(fn, args) {
  let timer, timedOut = false;
  const late = new Promise((_, fail) => { timer = setTimeout(() => { timedOut = true; fail(new Error('연결이 느려요. 잠시 뒤 다시 눌러 주세요.')); }, RPC_WAIT); });
  try {
    let res;
    try {
      res = await Promise.race([db.rpc(fn, args), late]);
    } catch (e) { // 20초 시간 초과이거나, 통신이 끊겨 던져진 오류
      if (timedOut) throw e; // 시간 초과는 다시 보내지 않음
      const err = new Error(koreanError(e && e.message));
      err.retryable = NET_FAIL.test(String(e && e.message));
      throw err;
    }
    const { data, error } = res;
    // DB 가 일부러 보내는 안내는 한국어라 그대로 보여 주고, 영어로 온 오류는 사용자가 알아볼 수 있게 바꿈
    if (error) {
      const err = new Error(koreanError(error.message, error.code, res.status));
      err.code = error.code;
      err.retryable = RETRY_CODES.includes(error.code) || RETRY_HTTP.includes(res.status) || NET_FAIL.test(String(error.message || '')); // 통신 실패도 오류 값으로 돌아올 수 있음
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function rpc(fn, args, opt) {
  const retry = Math.max(0, (opt && opt.retry) | 0);
  for (let n = 0; ; n++) {
    try {
      return await rpcOnce(fn, args);
    } catch (e) {
      if (n >= retry || !e.retryable) throw e;
      if (opt.onRetry) opt.onRetry(n + 1);
      await sleep(500 + Math.random() * 1500); // 한꺼번에 다시 몰리지 않게 무작위로
    }
  }
}

// 버튼 핸들러 공통: 오류를 화면 위쪽에 표시
const guard = (fn) => async (...args) => {
  try { showError(''); await fn(...args); } catch (e) { showError(e.message); }
};

// localStorage 는 막혀 있을 수 있으니 항상 try
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
