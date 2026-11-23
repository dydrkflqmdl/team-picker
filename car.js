// 탑승 차량 뽑기(참가자 화면). index.html 의 메인 단추(#goCar)와 차량 화면(#carCard)을 채운다.
// index.html 의 인라인 스크립트보다 먼저 읽히므로, 거기서 만든 것(me·busy·call·screen·fill 등)은 함수가 불릴 때(나중에)만 쓴다.
// 바깥에는 window.Car 하나만 내놓음(이름이 겹쳐 index.html 의 스크립트가 멈추지 않게 전체를 함수로 감쌈).
//   Car.home(left, missed)  메인 단추·남은 것·마감돼서 못 한 것 목록을 채움(paintHome 이 부름)   Car.ensure()  아직 못 받았으면 받음
//   Car.load()      car_state 를 새로 받음                            Car.reset()   로그아웃·로그인 화면에서 비움
//   Car.paint()     차량 화면을 지금 상태로 다시 그림(마감 시각을 넘길 때 index.html 의 syncClosed 가 부름)
// 마감: 점심·조식·자유시간과 같은 마감(index.html 의 choicesClosed() — common.js 의 CHOICE_DEADLINE + 서버가 마감이라고 답한 적)을 그대로 씀.
//   마감 뒤에는 아직 안 뽑은 사람만 막힘(서버 pick_car 가 거절). 이미 뽑은 사람·운전자는 그대로 보고 '그림 보기'도 됨
(function () {
  // 차량 색(차량 목록 순서대로 돌려 씀)
  const COLORS = ['#4f6fd8', '#d9644a', '#2f9e78', '#8b5cf6', '#d99a1a', '#52617a'];
  const colorOf = (st, id) => COLORS[Math.max(0, st.cars.findIndex((c) => c.id === id)) % COLORS.length];

  // 좌석 그림 치수(viewBox 320 폭 기준)
  const W = 320, BODY_X = 20, BODY_W = 280, CAB_X = 36, CAB_W = 248;
  const SEAT_W = 80, SEAT_H = 56, GAP_X = 4, GAP_Y = 8, PER_ROW = 3, FRONT_Y = 112;
  const DRV_X = 52, DRV_W = 52, WHEEL_DX = 24, WHEEL_R = 7; // 운전석: 이름 가운데(왼쪽에서), 이름이 쓸 폭(핸들 오른쪽), 핸들 자리(가운데에서 왼쪽으로)·크기

  // car_state 의 cars[] = {id, name, label, seats(지금 정원 — 자동이면 명단으로 계산된 값), auto, count(탄 손님 수), driver: {dept,name,title}|null}
  let data = null;   // { key, cars, car: id|null(운전자면 운전하는 차량), members: 그 차량 손님 [{dept,name,title}]|null }
  let err = '';      // 못 받은 이유(받아 둔 것이 없을 때만 보여 줌)
  let gen = 0;       // 가장 나중에 보낸 받기만 인정(늦게 온 옛 답이 새 결과를 덮지 않게)

  const state = () => (data && me && data.key === person() ? data : null);
  const carOf = (st) => (st.car ? st.cars.find((c) => c.id === st.car) || { id: st.car, name: st.car, label: '', seats: Math.max(1, (st.members || []).length), driver: null } : null);
  const isMe = (p) => !!p && p.dept === me.dept && p.name === me.name;
  // 내가 이 차량의 운전자인지(운전자는 뽑지 않아도 차량이 정해져 있음)
  const driving = (st) => { const c = carOf(st); return !!(c && isMe(c.driver)); };
  // 탄 손님(운전자 제외). 손님인데 목록을 아직 못 받았으면 나 한 명으로
  const membersOf = (st) => {
    if (Array.isArray(st.members) && st.members.length) return st.members;
    return driving(st) ? [] : [{ dept: me.dept, name: me.name, title: '' }];
  };
  // 같은 차 사람 전부: 운전자(있으면) 맨 앞 + 손님. 운전자에는 drive: true
  const crewOf = (st) => { const c = carOf(st); return [...(c.driver ? [{ ...c.driver, drive: true }] : []), ...membersOf(st)]; };
  // 목적격 조사: 끝 글자에 받침이 있으면 '을', 없으면(한글이 아니어도) '를'
  const obj = (w) => { const c = (w || '').charCodeAt(w.length - 1) - 0xac00; return c >= 0 && c < 11172 && c % 28 ? '을' : '를'; };
  // 보이는 이름: "1호차 · 가온님 차량"(문구가 없으면 이름만)
  const fullName = (c) => (c.label ? `${c.name} · ${c.label}` : c.name);
  // 마감됐는지(index.html 의 choicesClosed 를 그대로 씀. 없으면 마감 아님으로)
  const isClosed = () => typeof choicesClosed === 'function' && choicesClosed();

  // ── 그림 ──
  // 작은 차(위에서 본 모습). color 가 없으면 회색 + 가운데 물음표(뽑기 전)
  function miniCar(color, cls) {
    const c = color || '#9aa1ab';
    return `<svg class="${cls}" viewBox="0 0 40 72" aria-hidden="true" focusable="false">`
      + '<rect x="2" y="12" width="6" height="14" rx="2.5" fill="#2b2f37"/><rect x="32" y="12" width="6" height="14" rx="2.5" fill="#2b2f37"/>'
      + '<rect x="2" y="46" width="6" height="14" rx="2.5" fill="#2b2f37"/><rect x="32" y="46" width="6" height="14" rx="2.5" fill="#2b2f37"/>'
      + `<rect x="6" y="2" width="28" height="68" rx="13" fill="${c}"/>`
      + '<rect x="9" y="4" width="7" height="3" rx="1.5" fill="#fde68a"/><rect x="24" y="4" width="7" height="3" rx="1.5" fill="#fde68a"/>'
      + '<rect x="9" y="65" width="7" height="3" rx="1.5" fill="#f87171"/><rect x="24" y="65" width="7" height="3" rx="1.5" fill="#f87171"/>'
      + '<rect x="10" y="16" width="20" height="9" rx="3" fill="#cfe6f7"/><rect x="10" y="48" width="20" height="7" rx="3" fill="#cfe6f7"/>'
      + '<rect x="10" y="28" width="20" height="17" rx="4" fill="#fff" fill-opacity=".3"/>'
      + (color ? '' : '<text x="20" y="40" text-anchor="middle" font-size="14" font-weight="800" fill="#fff">?</text>')
      + '</svg>';
  }

  // 이름이 좌석에 들어가게 글자 크기를 줄이고, 그래도 넘치면 줄임표.
  // 글자 폭은 화면 글꼴로 실제로 잼(canvas measureText — 화면이 아직 숨겨져 있어도 잴 수 있음).
  // 잴 수 없는 브라우저에서만 어림값(한글·한자 .9, 대문자 .7, 나머지 .58)
  const em = (s) => [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? 0.9 : /[A-Z]/.test(ch) ? 0.7 : ch === ' ' ? 0.3 : 0.58), 0);
  let ctx = null, family = '';
  function textW(s, fs, weight) {
    try {
      if (!ctx) { ctx = document.createElement('canvas').getContext('2d'); family = getComputedStyle(document.body).fontFamily; }
      ctx.font = `${weight} ${fs}px ${family}`;
      const w = ctx.measureText(s).width;
      if (w > 0 || !s) return w;
    } catch { /* 아래 어림값 */ }
    return em(s) * fs;
  }
  function fit(name, width, pad = 8, weight = 700) {
    const inner = width - pad;
    let fs = 14;
    while (fs > 10 && textW(name, fs, weight) > inner) fs -= 0.5;
    let text = name;
    if (textW(text, fs, weight) > inner) {
      const chars = [...text];
      while (chars.length > 1 && textW(chars.join('') + '…', fs, weight) > inner) chars.pop();
      text = chars.join('') + '…';
    }
    return { text, fs };
  }

  // 좌석 자리: 앞줄 = 운전석(왼쪽) + 조수석(오른쪽), 그 뒤는 한 줄에 3명씩 가운데 맞춤으로 줄을 늘려 감. 정원(seats)이 몇이든 줄 수만 늘어남
  function layout(seats) {
    const list = [{ x: CAB_X, y: FRONT_Y, driver: true }];
    if (seats >= 1) list.push({ x: CAB_X + CAB_W - SEAT_W, y: FRONT_Y });
    const rest = Math.max(0, seats - 1);
    const rows = Math.ceil(rest / PER_ROW);
    for (let r = 0; r < rows; r++) {
      const n = Math.min(PER_ROW, rest - r * PER_ROW);
      const width = n * SEAT_W + (n - 1) * GAP_X;
      const x0 = CAB_X + (CAB_W - width) / 2;
      for (let i = 0; i < n; i++) list.push({ x: x0 + i * (SEAT_W + GAP_X), y: FRONT_Y + (r + 1) * (SEAT_H + GAP_Y) });
    }
    return { list, rows: rows + 1 };
  }

  // 큰 그림 한 장: 제목(차량 이름·문구) + 위에서 본 차. 운전석에는 운전자 이름(정해져 있으면),
  // 탄 손님은 car_at 순서대로 조수석 → 뒷줄 왼쪽부터 앉음
  function diagram(st) {
    const car = carOf(st);
    const people = membersOf(st);
    const drv = car.driver, drvMe = isMe(drv);
    const seats = Math.max(car.seats, people.length); // 정원보다 많이 탔어도 그림이 사실과 달라지지 않게
    const { list, rows } = layout(seats);
    const lastBottom = FRONT_Y + (rows - 1) * (SEAT_H + GAP_Y) + SEAT_H;
    const cabBottom = lastBottom + 12;
    const H = cabBottom + 20 + 34;
    const color = colorOf(st, car.id);
    const taken = (i) => people[i - 1]; // list[0] 은 운전석
    let g = '';
    list.forEach((s, i) => {
      const cx = s.x + SEAT_W / 2;
      if (s.driver) {
        g += `<g><title>${esc(drv ? `운전: ${drv.name}${drv.title ? ' ' + drv.title : ''}` : '운전석')}</title>`
          + `<rect class="cs-seat driver${drvMe ? ' me' : ''}" x="${s.x}" y="${s.y}" width="${SEAT_W}" height="${SEAT_H}" rx="12"/>`
          + `<rect class="cs-head" x="${cx - 16}" y="${s.y + 5}" width="32" height="7" rx="3.5"/>`
          + `<circle class="cs-wheel" cx="${cx - WHEEL_DX}" cy="${s.y + 36}" r="${WHEEL_R}"/>`; // 핸들: 칸 안 왼쪽(윗선에 걸치지 않게)
        if (drv) {
          // 핸들 오른쪽 좁은 자리에 "운전"(작게) + 이름(다섯 글자 이름까지 들어감). 더 길면 줄이고, 전체 이름은 아래 같은 차 사람 목록에
          const f = fit(drv.name, DRV_W, 4, drvMe ? 900 : 700);
          g += `<text class="cs-label sm" x="${s.x + DRV_X}" y="${s.y + 25}" dy=".35em">운전</text>`
            + `<text class="cs-name${drvMe ? ' me' : ''}" x="${s.x + DRV_X}" y="${s.y + 42}" dy=".35em" style="font-size:${f.fs}px">${esc(f.text)}</text>`;
          if (drvMe) g += meTag(s);
        } else {
          g += `<text class="cs-label" x="${cx + 10}" y="${s.y + 36}" dy=".35em">운전</text>`;
        }
        g += '</g>';
        return;
      }
      const p = taken(i);
      const mine = p && isMe(p);
      g += `<g><title>${esc(p ? p.name : '빈자리')}</title>`
        + `<rect class="cs-seat${mine ? ' me' : p ? '' : ' empty'}" x="${s.x}" y="${s.y}" width="${SEAT_W}" height="${SEAT_H}" rx="12"/>`
        + `<rect class="cs-head" x="${cx - 16}" y="${s.y + 5}" width="32" height="7" rx="3.5"/>`;
      if (p) {
        const f = fit(p.name, SEAT_W, 8, mine ? 900 : 700);
        g += `<text class="cs-name${mine ? ' me' : ''}" x="${cx}" y="${s.y + 36}" dy=".35em" style="font-size:${f.fs}px">${esc(f.text)}</text>`;
        if (mine) g += meTag(s);
      } else {
        g += `<text class="cs-empty-text" x="${cx}" y="${s.y + 36}" dy=".35em">빈자리</text>`;
      }
      g += '</g>';
    });
    const names = people.map((p) => p.name).join(', ');
    const label = `${fullName(car)}. 운전석${drv ? `(운전 ${drv.name}${drvMe ? ', 나' : ''})` : ''}, 탄 사람 ${people.length}명${names ? `(${names})` : ''}, 빈자리 ${Math.max(0, seats - people.length)}개`;
    const wheelY = [46, H - 92];
    const svg = `<svg class="car-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`
      + wheelY.map((y) => `<rect class="cs-tire" x="6" y="${y}" width="15" height="38" rx="5"/><rect class="cs-tire" x="299" y="${y}" width="15" height="38" rx="5"/>`).join('')
      + `<rect x="${BODY_X}" y="6" width="${BODY_W}" height="${H - 12}" rx="58" fill="${color}"/>`
      + '<rect class="cs-light" x="46" y="18" width="46" height="12" rx="6"/><rect class="cs-light" x="228" y="18" width="46" height="12" rx="6"/>'
      + `<rect class="cs-tail" x="46" y="${H - 30}" width="46" height="12" rx="6"/><rect class="cs-tail" x="228" y="${H - 30}" width="46" height="12" rx="6"/>`
      + '<rect class="cs-mirror" x="10" y="92" width="12" height="9" rx="4"/><rect class="cs-mirror" x="298" y="92" width="12" height="9" rx="4"/>'
      + '<path class="cs-glass" d="M46 92 L60 62 H260 L274 92 Z"/>'
      + `<rect class="cs-cabin" x="${CAB_X}" y="94" width="${CAB_W}" height="${cabBottom - 94}" rx="14"/>`
      + `<path class="cs-glass" d="M46 ${cabBottom} H274 L260 ${cabBottom + 22} H60 Z"/>`
      + g + '</svg>';
    return `<div class="car-title">${esc(car.name)}${car.label ? `<span class="car-label">${esc(car.label)}</span>` : ''}</div>${svg}`;
  }
  // 좌석 오른쪽 위의 "나" 표시
  const meTag = (s) => `<rect class="cs-me-tag" x="${s.x + SEAT_W - 26}" y="${s.y + 4}" width="22" height="15" rx="7.5"/><text class="cs-me-text" x="${s.x + SEAT_W - 15}" y="${s.y + 11.5}" dy=".35em">나</text>`;

  // 메인 단추의 같은 차 사람 이름표(index.html 의 이름표와 같은 모양). 운전자 맨 앞("운전"), 그다음 나("나"), 나머지는 탄 순서
  function crewChips(st) {
    const list = crewOf(st);
    const sorted = [...list.filter((p) => p.drive), ...list.filter((p) => !p.drive && isMe(p)), ...list.filter((p) => !p.drive && !isMe(p))];
    return sorted.map((p, i) => `<span class="mb-chip${isMe(p) ? ' is-me' : ''}">${esc(p.name)}`
      + (p.drive ? ' <span class="mb-drv">운전</span>' : '') + (isMe(p) ? ' <span class="mb-me">나</span>' : '') + '</span>'
      + (i < sorted.length - 1 ? '<span class="sr-only">, </span>' : '')).join('');
  }

  // ── 메인 단추 ──
  // 받은 결과가 있으면 끝냈는지 아닌지로, 아직 못 받았으면(받는 중·못 받음) 색을 칠하지 않은 단추로. 못 받았어도 다른 단추에는 영향이 없음
  // 끝낸 뒤에도(운전자도) 눌려서 지금 그림(같은 차 사람이 늘어난 모습)을 볼 수 있음 — 자유시간의 '바꾸기'처럼 '그림 보기' 표시.
  // index.html 의 HIDDEN_TASKS 에 'Car' 를 넣으면 숨김(남은 것·막대에서도 빠짐)
  // 마감 전 아직 안 뽑았으면 다른 고르기처럼 "11/25(수) 15시까지", 마감 뒤 못 뽑았으면 차분한 회색 "⏰ 마감됐어요 · 진행자에게 말해 주세요"
  // (눌리지 않고, '남은 것' 대신 missed 에 넣음 — index.html 의 점심·조식·자유시간과 같은 처리)
  function home(left, missed = []) {
    const btn = $('#goCar');
    btn.hidden = typeof HIDDEN_TASKS !== 'undefined' && HIDDEN_TASKS.has('Car');
    if (btn.hidden) return;
    const st = state();
    const closed = isClosed();
    const done = !!(st && st.car);
    const lapsed = !!(st && !st.car) && closed; // 못 뽑은 채 마감
    const todo = !!(st && !st.car) && !closed;
    btn.classList.toggle('is-done', done);
    btn.classList.toggle('is-todo', todo);
    btn.classList.toggle('is-closed', lapsed);
    btn.disabled = lapsed;
    fill(btn.querySelector('.mb-title'), done || lapsed ? '🚗 타고 갈 차량' : '🚗 타고 갈 차량 뽑기');
    fill($('#srCar'), done ? '끝났어요.' : lapsed ? '마감됐어요.' : '');
    let html = '', more = '';
    if (done) {
      const car = carOf(st), people = membersOf(st), crew = crewOf(st);
      html = `${miniCar(colorOf(st, car.id), 'mb-car')}<b class="mb-big">${esc(car.name)}</b>`
        + (car.label ? `<span class="sr-only"> · </span><span class="mb-carlabel">${esc(car.label)}</span>` : '')
        + (driving(st) ? '<span class="sr-only"> · </span><span class="mb-driving">운전</span>' : '')
        + '<span class="sr-only"> · </span><span class="mb-edit">그림 보기</span>';
      const note = people.length < car.seats ? '아직 안 뽑은 사람은 뽑으면 나타나요.' : '';
      more = crew.length ? `<span class="mb-people"><span class="mb-plabel">같은 차 사람 ${crew.length}명<span class="sr-only">: </span></span><span class="mb-chips">${crewChips(st)}</span>${note ? `<span class="mb-pnote">${note}</span>` : ''}</span>` : '';
    } else if (lapsed) {
      html = '⏰ 마감됐어요 · 진행자에게 말해 주세요';
    } else if (todo) {
      html = `👉 아직 안 뽑았어요<span class="mb-go">눌러요</span><span class="mb-due">${esc(CHOICE_DEADLINE_SHORT)}까지</span>`;
    } else {
      html = err ? '차량 정보를 못 받았어요. 눌러서 다시 받아요' : '차량 정보를 받는 중…';
    }
    fill($('#stCar'), html);
    fill($('#pvCar'), more);
    if (lapsed) missed.push('차량 뽑기');
    else if (!done) left.push('차량 뽑기');
  }

  // ── 차량 화면 ──
  const REVEAL_FIRST = () => `버튼을 눌러 차량을 뽑으세요. 한 번만 뽑을 수 있어요(${CHOICE_DEADLINE_LABEL}까지).`;
  // 마감 뒤 아직 안 뽑은 사람(lapsed): 뽑기 단추 없이 마감 안내만(조식의 "마감돼서 아직 못 골랐어요"와 같은 모양)
  function paintScreen(landed = false) {
    const st = state();
    const has = !!(st && st.car);
    const lapsed = !!st && !has && isClosed();
    const stage = $('#carStage');
    stage.hidden = !st || lapsed;
    stage.dataset.state = has ? 'done' : 'idle';
    $('#carSub').textContent = has ? (driving(st) ? '운전하는 차량이에요. 뽑지 않아도 돼요.' : '한 번 뽑은 차량은 바꿀 수 없어요.')
      : lapsed ? '마감됐어요.' : '누구와 같은 차를 탈지 완전 랜덤으로 정해져요';
    $('#carBtn').hidden = !st || has || lapsed;
    $('#carHomeBtn').hidden = !(has || !st || lapsed);
    $('#carRetry').hidden = !!st || !err;
    $('#carCrewCard').hidden = !has;
    if (!st) {
      $('#carText').textContent = err || '차량 정보를 불러오는 중…';
      fill($('#carReveal'), '');
      return;
    }
    if (lapsed) {
      $('#carText').innerHTML = `⏰ 마감돼서 아직 못 뽑았어요.<span class="car-result-label">${esc(CHOICE_DEADLINE_LABEL)}에 마감됐어요. 차량은 진행자에게 말해 주세요.</span>`;
      fill($('#carReveal'), '');
      return;
    }
    if (!has) {
      $('#carText').textContent = REVEAL_FIRST();
      fill($('#carReveal'), '');
      return;
    }
    const car = carOf(st), people = membersOf(st), crew = crewOf(st);
    fill($('#carReveal'), diagram(st));
    $('#carText').innerHTML = `<b>${esc(car.name)}</b>${driving(st) ? `${obj(car.name)} 운전해요!` : '에 타요!'}${car.label ? `<span class="car-result-label">${esc(car.label)}</span>` : ''}`;
    $('#carCount').textContent = `지금까지 ${crew.length}명${car.driver ? `(운전 1 · 손님 ${people.length})` : ''}`;
    fill($('#carList'), crew.length
      ? crew.map((p) => `<li${p.drive ? ' class="drv"' : ''}><b>${esc(p.name)}</b>${p.drive ? '<span class="drv-tag">운전</span>' : ''}${isMe(p) ? '<span class="me-tag">나</span>' : ''}<small>${p.title ? esc(p.title) + ' · ' : ''}${esc(p.dept)}</small></li>`).join('')
      : '');
    $('#carNote').hidden = people.length >= car.seats;
    if (landed && !reduced()) $('#carText').animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 1000 });
  }
  // 화면에 들어올 때만 연출 여부를 정함: 그냥 들어오면(이미 차량이 있던 사람·운전자·'그림 보기') 연출 없이 바로(.shown),
  // 방금 뽑았으면(landed) 연출. 그 뒤 car_state 답으로 다시 그려도(paintScreen) 이 표시는 건드리지 않아 연출이 끝까지 돎
  function show(landed = false) {
    who();
    $('#carStage').classList.toggle('shown', !landed);
    paintScreen(landed);
    screen('car');
    load();
  }

  // car_state 받기. 실패해도 오류를 화면 위쪽에 띄우지 않음(다른 단추는 평소처럼 동작해야 하므로 차량 칸에서만 "다시 받는 중" 등으로 알림)
  async function load() {
    if (!me) return;
    const k = person(), g = ++gen;
    try {
      const got = await call('car_state', { p_dept: me.dept, p_name: me.name }, true);
      if (g !== gen || person() !== k) return; // 더 나중에 보낸 받기나 다른 사람의 것이 있음
      if (!got) throw new Error('명단 정보를 확인해 주세요.'); // 명단에 없는 사람(진행자가 지움). 로그인 상태 확인은 기존 30초 확인(resync)이 함
      if (!Array.isArray(got.cars)) throw new Error('차량 정보를 받지 못했어요.');
      data = { key: k, cars: got.cars, car: got.car || null, members: Array.isArray(got.members) ? got.members : null };
      err = '';
    } catch (e) {
      if (g !== gen || person() !== k) return;
      err = '차량 정보를 받지 못했어요. 잠시 뒤 다시 받아 주세요.';
    }
    paintHome();
    if (shown === 'car' && !busy) paintScreen();
  }
  function ensure() { if (!state() && me) load(); }
  function reset() { data = null; err = ''; gen++; }

  // 뽑기: pick_car 로 차량을 받고, 이어서 car_state 로 같은 차 사람까지 받아 둠(둘 다 같은 요청을 다시 보내도 결과가 같음)
  async function pickAndState() {
    const id = await call('pick_car', { p_dept: me.dept, p_name: me.name });
    if (!id || typeof id !== 'string') throw new Error('차량이 정해지지 않았어요. 다시 눌러 주세요.');
    gen++; // 이미 보낸 예전 받기는 "차량 없음"으로 돌아올 수 있으므로 버림
    let st = null;
    try { st = await call('car_state', { p_dept: me.dept, p_name: me.name }, true); } catch { /* 아래에서 알고 있는 것으로 보여 줌 */ }
    return { id, st };
  }
  // 차 열쇠와 차를 흔들다가 결과로 넘어감. 아무리 빨라도 1.7초는 흔들고, 답이 늦으면 올 때까지 계속 흔듦. 실패하면 바로 throw
  async function animate(promise) {
    if (reduced()) return promise;
    $('#carStage').dataset.state = 'drawing';
    const [r] = await Promise.all([promise, sleep(1700)]);
    return r;
  }
  async function pick() {
    if (busy || !me) return;
    if (isClosed()) return paintScreen(); // 시계가 마감을 넘긴 직후: 잠긴 모습으로
    const mine = me;
    const controls = () => all('#carCard .back, #topbar .logout');
    $('#carBtn').disabled = true;
    controls().forEach((el) => { el.disabled = true; });
    $('#carText').textContent = '차 열쇠를 돌리는 중…';
    busy = true;
    try {
      const { id, st } = await animate(pickAndState());
      if (me !== mine) return;
      const k = person();
      if (st && Array.isArray(st.cars) && st.car) {
        data = { key: k, cars: st.cars, car: st.car, members: Array.isArray(st.members) ? st.members : null };
      } else if (state() && state().cars.some((c) => c.id === id)) {
        data = { key: k, cars: state().cars, car: id, members: null }; // 같은 차 사람은 곧 다시 받음
      } else {
        data = null;
        err = '차량은 정해졌어요. 차량 정보를 다시 받아 주세요.';
      }
      show(true);
      setTimeout(() => {
        if (shown === 'car' && state() && state().car && document.activeElement === document.body) $('#carHomeBtn').focus({ preventScroll: true });
      }, 1600);
    } catch (e) {
      if (typeof markClosed === 'function') markClosed(e); // 서버가 마감이라고 거절(휴대폰 시계가 늦은 경우 등) → 아래에서 마감 모습으로 그리고 문구는 guard 가 보여 줌
      paintScreen(); // 실패하면 원래 상태로(마감이면 잠긴 모습)
      showError(e.message);
      await load(); // 답이 늦었을 뿐 차량은 이미 정해졌을 수 있음(같은 사람이 다시 눌러도 DB가 같은 차량을 돌려줌)
      if (me !== mine) return;
      if (state() && state().car) { paintScreen(); return showError(''); }
      if (/명단에 없는/.test(e.message)) {
        await resync(true).catch(() => {}); // 명단에서 빠졌으면 로그인 화면에서 이유를 알려 줌
        if (!me) return;
      }
      throw e;
    } finally {
      busy = false;
      $('#carBtn').disabled = false;
      controls().forEach((el) => { el.disabled = false; });
    }
  }

  // ── 연결: 단추·뽑기·다시 받기 ──
  $('#goCar').addEventListener('click', guard(() => { enter(); show(); }));
  $('#carBtn').addEventListener('click', guard(pick));
  $('#carRetry').addEventListener('click', () => { err = ''; paintScreen(); load(); });

  window.Car = { home, load, ensure, reset, paint: () => paintScreen() };
})();
