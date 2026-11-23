// 관리자 페이지(board.html)의 "탑승 차량" 칸. board.html 의 스크립트 다음에 불러와서
// 그쪽의 $ · esc · rpc · code(관리자 비밀번호) 를 그대로 쓴다. 기존 칸의 동작은 건드리지 않는다.
(() => {
  const card = $('#carCard');
  if (!card) return;
  const view = $('#carView'), msgEl = $('#carMsg'), editBox = $('#carEdit'), rowsEl = $('#carEditRows');

  // 모양: 객실표(.room)와 같은 상자를 차량 폭에 맞게, 고치는 줄
  const css = document.createElement('style');
  css.textContent = `
    .cars { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .car-full { margin-left: 6px; padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); font-size: 12px; font-weight: 600; }
    .cars .room ol { list-style: none; margin: 0; padding: 0; }
    .cars .room ol li { display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; padding: 3px 0; }
    .cars .room ol li .n { flex: none; min-width: 1.4em; color: var(--muted); font-size: 13px; }
    .cars .room ol li select.car-sel { margin-left: auto; }
    select.car-sel { display: inline-block; width: auto; max-width: 100%; margin: 0 0 0 6px; padding: 3px 6px; font-size: 13px; border-radius: 6px; }
    .car-yet .chip select.car-sel { margin-left: 6px; }
    .car-yet.picking .chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
    .car-yet.picking .chip { display: flex; align-items: center; gap: 6px; border-radius: 12px; padding: 6px 8px 6px 12px; }
    .car-yet.picking .chip select.car-sel { margin-left: auto; }
    .car-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
    .car-row input { margin: 0; padding: 8px 10px; font-size: 14px; }
    .car-row input.car-name { flex: 1 1 180px; max-width: 280px; }
    .car-row input.car-label { flex: 1 1 160px; max-width: 240px; }
    .car-row input.car-seats { flex: none; width: 72px; }
    .car-row select.car-driver { width: auto; max-width: 100%; margin: 0; padding: 8px 10px; font-size: 14px; }
    .car-row .car-drv-warn { flex-basis: 100%; margin: -2px 0 0; color: var(--danger); font-size: 13px; }
    .cars .room .car-lbl { display: block; color: var(--muted); font-size: 13px; font-weight: 600; }
    .cars .room .car-drv { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 4px; margin: -2px 0 6px; font-size: 14px; }
    .cars .room .car-drv b { margin-right: 4px; }
    .cars .room .car-drv.none { color: var(--muted); font-size: 13px; }
    .car-drv-tag { margin-left: auto; padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); font-size: 12px; font-weight: 700; }
    .car-row label { display: flex; gap: 6px; align-items: center; margin: 0; font-size: 13px; color: var(--muted); }
    #carMsg.err { color: var(--danger); }
    #carEdit { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
    @media (max-width: 700px) {
      select.car-sel { font-size: 16px; padding: 8px 10px; min-height: 40px; }
      .car-row input, #carCopyBox { font-size: 16px; }
      .cars .room ol li { align-items: center; }
      /* 차량 목록 고치기: 칸이 여러 줄로 접히므로 차량마다 구분선·여백을 두어 어느 칸이 어느 차량인지 보이게 */
      .car-row { margin: 0; padding: 12px 0; border-bottom: 1px solid var(--line); }
      .car-row:first-child { padding-top: 0; }
      .car-row input.car-name, .car-row input.car-label { flex-basis: 100%; max-width: none; }
    }`;
  document.head.appendChild(css);

  let data = null;      // { cars, people } 마지막으로 받은 것
  let sig = '';         // 마지막으로 그린 내용(같으면 다시 그리지 않음)
  let seq = 0;          // 늦게 온 예전 답을 버리기 위한 번호
  let loading = false;
  let editing = false;  // 차량 목록을 고치는 중 — 새로 받아도 입력칸은 건드리지 않음
  let notified = '';    // 마지막으로 board.html 에 알린 차량 자료(차량 목록·사람별 차량). 바뀌었을 때만 'carboard' 를 보냄
  const ko = (a, b) => String(a).localeCompare(String(b), 'ko');
  // 참가자 마감(common.js 의 CHOICE_DEADLINE — 점심·아침 메뉴·자유시간과 같은 시각)이 지났는지. 지나면 비운 사람은 스스로 다시 뽑지 못함(서버 pick_car 가 거절)
  const closed = () => typeof CHOICE_DEADLINE === 'number' && Date.now() >= CHOICE_DEADLINE;

  const say = (text, bad) => { msgEl.textContent = text || ''; msgEl.classList.toggle('err', !!bad); };
  const person = (p) => `${esc(p.name)} <span class="hint">${p.title ? esc(p.title) + ' · ' : ''}${esc(p.dept)}</span>`;

  // 보이는 차량 이름: "1호차 · 가온님 차량"(문구가 없으면 이름만)
  const fullName = (c) => (c.label ? `${c.name} · ${c.label}` : c.name);
  // 운전자: 없으면 null, 명단에 있으면 그 사람, 명단에서 지워졌으면 { missing: true, id }
  const driverOf = (c) => (c.driver == null ? null : data.people.find((p) => p.id === c.driver) || { missing: true, id: c.driver });
  // 운전자로 지정된 사람 id(명단에 있는 사람만)
  const driverIds = () => new Set(data.cars.map((c) => c.driver).filter((id) => id != null && data.people.some((p) => p.id === id)));

  // 차량마다 탄 손님(뽑은 차례) · 아직 안 뽑은 사람(운전자 제외) · 목록에 없는 차량에 든 사람
  function groups() {
    const cars = data.cars, ids = new Set(cars.map((c) => c.id)), drv = driverIds();
    const riders = (id) => data.people.filter((p) => p.car === id)
      .sort((a, b) => (Date.parse(a.car_at) || 0) - (Date.parse(b.car_at) || 0) || a.id - b.id);
    const list = cars.map((c) => ({ ...c, riders: riders(c.id), drv: driverOf(c) }));
    const lost = data.people.filter((p) => p.car && !ids.has(p.car));
    const yet = data.people.filter((p) => !p.car && !drv.has(p.id)).sort((a, b) => ko(a.dept, b.dept) || ko(a.name, b.name));
    return { list, lost, yet, drivers: drv.size };
  }

  // 사람마다 고르는 칸: 빈칸 = 차량 비우기(마감 전에는 "다시 뽑게 하기", 마감 뒤에는 스스로 다시 못 뽑으므로 그냥 "차량 비우기"). 운전자는 고르는 칸 대신 "운전자"(차량 목록 고치기에서 바꿈)
  const pick = (p) => (driverIds().has(p.id) ? '<span class="car-drv-tag" title="운전자는 차량 목록 고치기에서 바꿔요">운전자</span>' : `<select class="car-sel" data-id="${p.id}" aria-label="${esc(p.name)} 님 탑승 차량">`
    + `<option value="">${p.car ? (closed() ? '차량 비우기' : '차량 비우기(다시 뽑게 하기)') : '차량 없음'}</option>`
    + data.cars.map((c) => `<option value="${esc(c.id)}"${p.car === c.id ? ' selected' : ''}>${esc(fullName(c))}</option>`).join('')
    + '</select>');

  function render() {
    if (!data) return;
    const move = $('#carMove').checked;
    const { list, lost, yet, drivers } = groups();
    const drawn = data.people.filter((p) => p.car).length;
    // 제목 줄(칸을 접어 두어도 보임): 차량이 정해진 사람(뽑은 손님 + 운전자) / 명단 인원, 탑승 인원이 어긋났으면 덧붙임
    const bad = warn(list, yet);
    $('#carCount').textContent = `${drawn + drivers}/${data.people.length}명 정해짐${bad ? ' · ⚠ 인원 어긋남' : ''}`;
    const drvLine = (c) => {
      const d = c.drv;
      if (!d) return '<p class="car-drv none">운전: 정하지 않음</p>';
      if (d.missing) return '<p class="car-drv"><b>운전:</b><span class="warn">명단에 없는 사람(지워짐)</span> <span class="hint">차량 목록 고치기에서 다시 골라 주세요</span></p>';
      // 직접 옮기기 중에는 고르는 칸 대신 "운전자"(운전자는 차량 목록 고치기에서 바꿈)
      return `<p class="car-drv"><b>운전:</b>${esc(d.name)} <span class="hint">${d.title ? esc(d.title) + ' · ' : ''}${esc(d.dept)}</span>${move ? ' <span class="car-drv-tag" title="운전자는 차량 목록 고치기에서 바꿔요">운전자</span>' : ''}</p>`;
    };
    const box = (c) => {
      const full = c.riders.length >= c.seats;
      return `<div class="room"><h3><span>${esc(c.name)}${full ? '<span class="car-full">꽉 참</span>' : ''}${c.label ? `<span class="car-lbl">${esc(c.label)}</span>` : ''}</span><span>${c.riders.length}/${c.seats}명${c.auto ? '(자동)' : ''}</span></h3>
        ${drvLine(c)}<ol>${c.riders.map((p, i) => `<li><span class="n">${i + 1}</span><span>${person(p)}</span>${move ? pick(p) : ''}</li>`).join('') || '<li class="empty">아직 없어요</li>'}</ol></div>`;
    };
    let html = list.map(box).join('');
    if (lost.length) html += `<div class="room"><h3><span>목록에 없는 차량</span><span>${lost.length}명</span></h3>
      <ol>${lost.map((p, i) => `<li><span class="n">${i + 1}</span><span>${person(p)} <span class="warn">${esc(p.car)}</span></span>${move ? pick(p) : ''}</li>`).join('')}</ol></div>`;
    html += `<div class="menu-group none car-yet${move ? ' picking' : ''}"><p>아직 안 뽑은 사람 <b>${yet.length}</b>명</p>
      <div class="chips">${yet.map((p) => `<span class="chip">${person(p)}${move ? pick(p) : ''}</span>`).join('') || '<span class="empty">모두 뽑았어요</span>'}</div>${drivers ? `<p class="hint">운전자 ${drivers}명은 뽑지 않아도 차량이 정해져 있어 여기에 없어요.</p>` : ''}</div>`;
    if (html === sig) return;
    // 고르는 칸을 잡고 있는 동안(열린 목록 포함)은 다시 그리지 않고, 칸에서 나올 때 맞춤
    const at = document.activeElement;
    if (at && at.matches('select.car-sel') && view.contains(at)) return;
    sig = html;
    view.innerHTML = html;
  }

  // 탑승 인원 점검(팀 칸의 인원 경고와 같은 모양 .teamwarn): 정원보다 많이 탄 차량이 있거나,
  // 모두 정해졌는데(안 뽑은 사람 0) 자동 정원 차량끼리 탄 인원 차이가 2명 이상이면 알림. 뽑는 중 정상 범위면 알리지 않음. 알렸으면 true
  function warn(list, yet) {
    const el = $('#carWarn');
    if (!el) return false;
    const over = list.filter((c) => c.riders.length > c.seats);
    const autos = list.filter((c) => c.auto);
    const n = autos.map((c) => c.riders.length);
    const spread = !yet.length && autos.length >= 2 && Math.max(...n) - Math.min(...n) >= 2;
    const html = (over.length || spread)
      ? `탑승 인원이 어긋났어요. 안 온 사람이 명단에 남아 있는지 확인하고, <b>직접 옮기기</b>로 인원이 많은 차량의 한 명을 적은 차량으로 옮기세요.<small>지금 ${list.map((c) => `${esc(c.name)} ${c.riders.length}명`).join(' · ')}`
        + ` (정원 ${list.map((c) => `${c.seats}명${c.auto ? '(자동)' : ''}`).join(' · ')}).${over.length ? ` 정원보다 많이 탄 차량: ${over.map((c) => esc(c.name)).join(' · ')}.` : ''}</small>`
      : '';
    el.hidden = !html;
    if (el.innerHTML !== html) el.innerHTML = html;
    return !!html;
  }

  // 받기에 성공하면 true(다른 이유로 건너뛰거나 실패하면 false)
  async function load(force) {
    if (typeof code === 'undefined' || !code || loading && !force) return false;
    const mine = ++seq;
    loading = true;
    try {
      const d = await rpc('board_cars', { p_code: code });
      if (mine !== seq) return false;
      data = { cars: (d && d.cars) || [], people: (d && d.people) || [] };
      if (msgEl.dataset.load) { say(''); delete msgEl.dataset.load; }
      render();
      // 한눈에 보기·분류 단추가 차량을 쓰므로, 차량 자료가 바뀌었을 때만 board.html 에 알림(같은 내용이면 그쪽 표를 다시 그리지 않음)
      const now = JSON.stringify([data.cars, data.people.map((p) => [p.id, p.car || ''])]);
      if (now !== notified) { notified = now; document.dispatchEvent(new Event('carboard')); }
      return true;
    } catch (e) {
      if (mine !== seq || e.message.includes('비밀번호')) return false; // 비밀번호는 기존 화면이 처리
      if (card.open) { say(e.message, true); msgEl.dataset.load = '1'; } // 칸을 열어 둔 때만 알림
      return false;
    } finally {
      if (mine === seq) loading = false;
    }
  }

  // 저장 같은 일을 하고 다시 받음. 실패하면 문구를 메시지 줄에 그대로 보이고 고르는 칸을 저장된 값으로 되돌림
  async function act(fn, ok) {
    say('');
    delete msgEl.dataset.load;
    try { await fn(); } catch (e) { say(e.message, true); sig = ''; render(); return false; }
    await load(true);
    if (ok) say(typeof ok === 'function' ? ok() : ok);
    return true;
  }

  view.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches('select.car-sel')) return;
    const p = data.people.find((x) => x.id === Number(el.dataset.id));
    el.disabled = true;
    act(() => rpc('admin_set_car', { p_code: code, p_id: Number(el.dataset.id), p_car: el.value || null }),
      () => { const c = data.cars.find((x) => x.id === el.value); return p ? (c ? `${p.name} 님을 ${fullName(c)}에 넣었어요.` : (closed() ? `${p.name} 님의 차량을 비웠어요. 마감이 지나 스스로 다시 뽑지 못해요. 여기서 직접 넣어 주세요.` : `${p.name} 님의 차량을 비웠어요. 다시 뽑을 수 있어요.`)) : ''; })
      .finally(() => { el.disabled = false; });
  });
  view.addEventListener('focusout', (e) => { if (e.target.matches('select.car-sel')) setTimeout(render); });
  $('#carMove').addEventListener('change', () => { sig = ''; render(); });

  // 차량 모두 비우기는 board.html 맨 아래 초기화 칸의 '탑승 차량 초기화'(전체 초기화에도 들어 있음)가 admin_clear_cars 로 함 — 확인 문구의 인원은 아래 carBoard.riders()

  // 차량별 탑승자 복사
  let copyTimer;
  $('#carCopy').addEventListener('click', async () => {
    clearTimeout(copyTimer);
    if (!data || !data.people.length) { say('복사할 내용이 없어요. 명단이 비어 있어요.', true); return; }
    const { list, lost, yet } = groups();
    const names = (a) => a.map((p) => p.name).join(', ') || '없음';
    const drvText = (d) => (!d ? '' : d.missing ? '운전 명단에 없음 · ' : `운전 ${d.name} · `);
    const text = [...list.map((c) => `${fullName(c)}(${drvText(c.drv)}${c.riders.length}/${c.seats}): ${names(c.riders)}`),
      ...(lost.length ? [`목록에 없는 차량(${lost.length}): ${names(lost)}`] : []),
      ...(yet.length ? [`아직 안 뽑음(${yet.length}): ${names(yet)}`] : [])].join('\n');
    const box = $('#carCopyBox');
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
    box.value = text;
    if (ok) {
      box.hidden = true;
      say('복사했어요.');
      copyTimer = setTimeout(() => say(''), 6000);
      return;
    }
    box.hidden = false;
    box.focus();
    box.select();
    try { ok = document.execCommand('copy'); } catch {}
    say(ok ? '복사했어요.' : '복사가 막혀 있어요. 아래 글을 눌러 선택한 뒤 직접 복사해 주세요.', !ok);
  });

  // 차량 목록 고치기: 줄마다 이름·정원·빼기. 새 차량의 id 는 c1, c2… 중 안 쓰는 것
  const allIds = new Set();
  function newId() {
    let n = 1;
    while (allIds.has('c' + n)) n++;
    allIds.add('c' + n);
    return 'c' + n;
  }
  // 운전자 고르는 칸: 없음 + 명단 전원(부서·이름 순). 지금 운전자가 명단에서 지워졌으면 그 사실을 맨 위에 보여 줌(그대로 저장하면 DB가 거절)
  function driverSelect(cur) {
    const drv = new Map(data.cars.filter((c) => c.driver != null).map((c) => [c.driver, c]));
    const people = [...data.people].sort((a, b) => ko(a.dept, b.dept) || ko(a.name, b.name));
    const missing = cur != null && !data.people.some((p) => p.id === cur);
    const car = (p) => (p.car ? data.cars.find((c) => c.id === p.car) : null);
    return '<select class="car-driver" aria-label="운전자">'
      + `<option value="">운전자 없음</option>`
      + (missing ? `<option value="${esc(cur)}" selected>명단에 없는 운전자(지워짐) — 다시 골라 주세요</option>` : '')
      + people.map((p) => {
        const other = drv.get(p.id), rides = car(p);
        const note = rides ? ` (${rides.name} 손님)` : other && other.driver !== cur ? ` (지금 ${other.name} 운전)` : '';
        return `<option value="${p.id}"${p.id === cur ? ' selected' : ''}>${esc(p.dept)} · ${esc(p.name)}${esc(note)}</option>`;
      }).join('')
      + '</select>';
  }
  function addRow(c) {
    const r = document.createElement('div');
    r.className = 'car-row';
    r.dataset.id = c.id;
    const missing = c.driver != null && !data.people.some((p) => p.id === c.driver);
    r.innerHTML = `<input class="car-name" maxlength="30" autocomplete="off" placeholder="차량 이름(예: 1호차)" aria-label="차량 이름" value="${esc(c.name)}" />`
      + `<input class="car-label" maxlength="30" autocomplete="off" placeholder="문구(예: ○○님 차량)" aria-label="문구" value="${esc(c.label || '')}" />`
      + `<label>정원 <input class="car-seats" type="number" inputmode="numeric" min="1" max="99" placeholder="자동" aria-label="정원(비우면 자동)" value="${c.auto || c.seats == null ? '' : esc(c.seats)}" />명</label>`
      + `<label>운전자 ${driverSelect(c.driver)}</label>`
      + '<button type="button" class="sm danger car-del">빼기</button>'
      + (missing ? '<p class="car-drv-warn">운전자가 명단에서 지워졌어요. 다른 사람을 고르거나 \'운전자 없음\'으로 바꿔 저장해 주세요.</p>' : '');
    rowsEl.appendChild(r);
    return r;
  }
  $('#carEditBtn').addEventListener('click', () => {
    if (!data) { say('차량 정보를 아직 받지 못했어요. 잠시 뒤 다시 눌러 주세요.', true); return; }
    say('');
    editing = true;
    allIds.clear();
    data.cars.forEach((c) => allIds.add(c.id));
    rowsEl.innerHTML = '';
    data.cars.forEach(addRow);
    editBox.hidden = false;
    $('#carEditBtn').hidden = true;
    rowsEl.querySelector('input')?.focus();
  });
  const closeEdit = () => { editing = false; editBox.hidden = true; $('#carEditBtn').hidden = false; rowsEl.innerHTML = ''; };
  $('#carCancel').addEventListener('click', () => { closeEdit(); say(''); });
  $('#carAdd').addEventListener('click', () => {
    const r = addRow({ id: newId(), name: '', label: '', seats: null, auto: true, driver: null });
    r.querySelector('input').focus();
  });
  rowsEl.addEventListener('click', (e) => { if (e.target.matches('.car-del')) e.target.closest('.car-row').remove(); });
  const saveBtn = $('#carSave');
  saveBtn.addEventListener('click', async () => {
    // 정원 칸에 숫자가 아닌 글자(예: "4명")를 넣으면 브라우저가 값을 빈칸으로 넘겨 조용히 '자동'이 되므로, 저장을 막고 알림
    const bad = [...rowsEl.querySelectorAll('.car-seats')].find((el) => el.validity && el.validity.badInput);
    if (bad) {
      const name = bad.closest('.car-row').querySelector('.car-name').value.trim();
      say(`${name ? `"${name}" 의 ` : ''}정원에는 숫자만 적어 주세요(예: 4). 자동으로 두려면 칸을 비워 주세요.`, true);
      bad.focus();
      return;
    }
    // 정원 칸이 비면 seats 를 빼서 자동(반씩), 운전자가 '없음'이면 driver 를 뺌
    const cars = [...rowsEl.querySelectorAll('.car-row')].map((r) => {
      const seats = r.querySelector('.car-seats').value.trim(), drv = r.querySelector('.car-driver').value;
      return {
        id: r.dataset.id, name: r.querySelector('.car-name').value.trim(), label: r.querySelector('.car-label').value.trim(),
        ...(seats === '' ? {} : { seats: Number(seats) }), ...(drv === '' ? {} : { driver: Number(drv) }),
      };
    });
    saveBtn.disabled = true;
    say('');
    try {
      await rpc('admin_set_cars', { p_code: code, p_cars: cars });
    } catch (e) { say(e.message, true); saveBtn.disabled = false; return; } // 입력은 그대로 두고 이유만 보임
    saveBtn.disabled = false;
    closeEdit();
    await load(true);
    say('차량 목록을 저장했어요.');
  });

  // 새로 받기: 기존 5초 새로고침에 맞춰 5초마다. 칸을 접어 두어도 똑같이(접힌 제목 줄의 "N/M명 정해짐"과 맨 위 차량 타일이 늘 맞게)
  const auto = () => {
    if (document.hidden || $('#boardView').hidden || typeof code === 'undefined' || !code) return;
    load(false);
  };
  setInterval(auto, 5000);
  card.addEventListener('toggle', () => { if (card.open) load(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) auto(); });
  setTimeout(auto, 800); // 처음 한 번(board.html 의 첫 새로고침 뒤)

  // board.html 이 쓰는 것(있을 때만 씀 — 이 파일을 못 받아도 board.html 은 그대로 동작)
  //   refresh()      지금 차량 정보를 받음(되돌릴 수 없는 일 전 백업 직전)
  //   carText(id)    백업 CSV 의 탑승 차량 칸: 손님이면 차량 이름, 운전자면 "1호차(운전)", 없으면 ''
  //   removeNote(id) 명단에서 지울 때 확인 문구에 덧붙일 말(운전자·손님이면)
  //   riders()       초기화 확인 문구에 넣을 탑승 차량이 정해진 손님 수(운전자 제외). 새로 받아서 세고, 못 받으면 null
  //   ready() · carKey(id) · carKeys() · carName(key) · isDriver(id)   한눈에 보기·분류 단추용(받아 둔 자료만 읽음, 새로 받지 않음).
  //                  자료를 아직 못 받았으면 ready() 는 false, carKey 는 '', carKeys 는 []. 차량 자료가 바뀌면 document 에 'carboard' 이벤트
  const drivingCar = (id) => (data ? data.cars.find((c) => c.driver === id) : null);
  // 백업 직전 받기가 실패했으면 백업의 차량 칸은 비움(예전 값을 지금 것처럼 적지 않게)
  let backupFresh = true;
  window.carBoard = {
    // 지금 차량 정보를 받음(되돌릴 수 없는 일 전 백업 직전). 성공하면 true, 실패하면 false(그때 carText 는 빈칸)
    async refresh() { backupFresh = await load(true); return backupFresh; },
    ready() { return !!data; },
    // 그 사람의 차량 id: 운전자면 운전하는 차량, 손님이면 뽑은 차량(목록에 없는 차량이어도 그 값), 없으면 ''
    carKey(id) {
      if (!data) return '';
      const d = drivingCar(id);
      if (d) return d.id;
      const p = data.people.find((x) => x.id === id);
      return p && p.car ? p.car : '';
    },
    // 분류 단추에 보일 차량 id들: 차량 목록 순서 + 목록에 없는데 누가 든 차량
    carKeys() {
      if (!data) return [];
      const ids = data.cars.map((c) => c.id);
      return [...ids, ...new Set(data.people.map((p) => p.car).filter((c) => c && !ids.includes(c)))];
    },
    carName(key) { const c = data && data.cars.find((x) => x.id === key); return c ? c.name : key; },
    isDriver(id) { return !!drivingCar(id); },
    async riders() { return (await load(true)) && data ? data.people.filter((p) => p.car).length : null; },
    carText(id) {
      if (!data || !backupFresh) return '';
      const d = drivingCar(id);
      if (d) return `${fullName(d)}(운전)`;
      const p = data.people.find((x) => x.id === id), c = p && p.car ? data.cars.find((x) => x.id === p.car) : null;
      return c ? fullName(c) : p && p.car ? p.car : '';
    },
    // 명단에서 지우기 직전: 새로 받아서 판단(받기에 실패하면 가진 값으로)
    async removeNote(id) {
      await load(true);
      if (!data) return '';
      const d = drivingCar(id);
      if (d) return `\n${d.name} 운전자예요. 지우면 그 차량은 운전자 없음이 돼요(탑승 차량 → 차량 목록 고치기에서 다시 골라 주세요).`;
      const p = data.people.find((x) => x.id === id), c = p && p.car ? data.cars.find((x) => x.id === p.car) : null;
      return c ? `\n${c.name}에 타 있어서, 지우면 그 차량 인원이 1명 줄어요.` : '';
    },
  };
})();
