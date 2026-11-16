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

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const showError = (msg) => { $('#error').textContent = msg || ''; };

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
