// 참가자 화면(index.html)과 진행자 화면(board.html)이 같이 쓰는 설정·도구

// Supabase: 대시보드 → Project Settings → API. 공개용(publishable) 키만 넣는다. secret/service_role 키는 절대 금지.
const SUPABASE_URL = 'https://qvplrrhxlrzqvnqfpfsu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_qC654tfLhn9u0OrPk2xtqA_7zIMTeCO';
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const TEAMS = { red: '빨강', blue: '파랑', yellow: '노랑', green: '초록' };
const TEAM_KEYS = Object.keys(TEAMS);

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const showError = (msg) => { $('#error').textContent = msg || ''; };

// DB 함수 호출. 오류면 한국어 메시지로 throw
async function rpc(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
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
