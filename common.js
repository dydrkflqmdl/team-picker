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
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
const ACTS = { ski: '스키', sauna: '사우나' };
const ACT_KEYS = Object.keys(ACTS);

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const showError = (msg) => { $('#error').textContent = msg || ''; };

// 일정표 글 → 화면에 넣을 HTML. 한 줄에 하나씩 적은 글을 읽는다.
//   시간으로 시작하는 줄("10:00 도착", "14:00~16:00 팀 게임")은 일정, 그 밖의 줄("Day 1 · 12/17(목) — 화합과 소통")은 그 아래 일정들의 제목.
//   시간 뒤를 띄우지 않았거나("10:00도착") 시간만 적은 줄도 일정으로 읽는다
const PLAN_LINE = /^((?:[01]?\d|2[0-4]):[0-5]\d)(?:\s*[~\-–]\s*((?:[01]?\d|2[0-4]):[0-5]\d)?)?\s*(.*)$/;
// 일정의 종류: 내용에 든 낱말로 그림 표시와 색을 고른다(위에서부터 먼저 맞는 것). 맞는 낱말이 없으면 작은 점만 찍는다
const PLAN_KINDS = [
  ['meal', '🍴', /조식|중식|석식|아침|점심|저녁|식사|만찬|간식|바비큐/],
  ['photo', '📷', /사진|촬영/],
  ['play', '🎉', /레크|게임|장기자랑|이벤트/],
  ['talk', '🎤', /강의|특강|강연|교육|세션|오프닝|클로징|발표|프로그램/],
  ['move', '🚌', /출발|도착|이동|집결|체크인|체크아웃|입실|퇴실/],
  ['rest', '🌿', /자유|휴식|산책|취침/],
];
function planHtml(text) {
  const days = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(PLAN_LINE);
    if (!m) { days.push({ title: line, items: [] }); continue; }
    if (!days.length) days.push({ title: '', items: [] }); // 제목 없이 일정부터 적은 경우
    days[days.length - 1].items.push({ start: m[1].padStart(5, '0'), end: m[2] ? m[2].padStart(5, '0') : '', what: m[3] });
  }
  // 제목 줄 "Day 1 · 12/17(목) — 화합과 소통" → 꼬리표 "Day 1" + 날짜 "12/17(목)" + 주제 "화합과 소통". 가운뎃점·줄표가 없으면 통째로 날짜 자리에
  const head = (title) => {
    const [main, ...rest] = title.split(/\s+[—–-]\s+/);
    const parts = main.split(/\s*·\s*/).filter(Boolean);
    const tag = parts.length > 1 ? parts.shift() : '';
    return `<h3 class="plan-head">${tag ? `<span class="plan-tag">${esc(tag)}</span>` : ''}<span class="plan-date">${esc(parts.join(' · '))}</span>${
      rest.length ? `<span class="plan-theme">${esc(rest.join(' — '))}</span>` : ''}</h3>`;
  };
  // 일정 한 줄: 시간(시작 굵게, 끝은 작게) | 그림 표시 | 내용. "오프닝 : 대표 인사" 처럼 쌍점으로 나눈 뒷부분은 작은 글로 아래에
  const item = (it) => {
    const [kind, icon] = PLAN_KINDS.find((k) => k[2].test(it.what)) || ['etc', ''];
    const cut = it.what.search(/\s+:\s+/);
    const name = cut < 0 ? it.what : it.what.slice(0, cut);
    const more = cut < 0 ? '' : it.what.slice(cut).replace(/^\s+:\s+/, '');
    return `<li class="k-${kind}"><time><b>${esc(it.start)}</b>${it.end ? `<span>~${esc(it.end)}</span>` : ''}</time>`
      + `<span class="plan-dot" aria-hidden="true">${icon}</span>`
      + `<span class="plan-what"><span class="plan-text">${esc(name)}</span>${more ? `<small>${esc(more)}</small>` : ''}</span></li>`;
  };
  return days.map((d) => `
    <div class="plan-day">
      ${d.title ? head(d.title) : ''}
      ${d.items.length ? `<ol class="plan">${d.items.map(item).join('')}</ol>` : ''}
    </div>`).join('');
}

// DB 함수 호출. 오류면 한국어 메시지로 throw.
// 20초 안에 답이 없으면 더 기다리지 않고 알린다(모든 함수가 같은 요청을 다시 받아도 결과가 같으므로 다시 눌러도 안전).
const RPC_WAIT = 20000;
async function rpc(fn, args) {
  let timer;
  const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('연결이 느려요. 잠시 뒤 다시 눌러 주세요.')), RPC_WAIT); });
  try {
    const { data, error } = await Promise.race([db.rpc(fn, args), late]);
    // 통신이 끊기면 브라우저가 주는 영어 문구("Failed to fetch" 등) 대신 한국어로
    if (error) throw new Error(/fetch|network|load failed/i.test(error.message) ? '인터넷 연결을 확인한 뒤 다시 눌러 주세요.' : error.message);
    return data;
  } finally {
    clearTimeout(timer);
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
