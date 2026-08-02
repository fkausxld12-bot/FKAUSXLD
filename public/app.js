'use strict';

/* 꽃 작업장 주문 관리 - 화면 동작
 * 농라F 주문서는 서버가 3분마다 자동으로 긁어와 주문 목록에 등록합니다.
 * 이 화면은 3초마다 서버 상태를 읽어 모든 기기에서 같은 내용을 보여줍니다. */

const $ = (sel) => document.querySelector(sel);

let state = { orders: [], nongra: {}, store: {}, invoices: {} };
let toastTimer = null;
let prevNewCount = null; // 새 주문 알림용

const CHANNEL_NAME = { nongra: '농라', store: '스토어', field: '현장', sms: '문자' };
const STATUS_NAME = { new: '신규', paid: '입금확인', ready: '준비중', shipped: '완료', canceled: '취소' };
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
const won = (n) => fmt(n) + '원';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------ 통신 */

async function api(url, options) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

async function refresh() {
  try {
    state = await api('/api/state');
    setConnected(true);
    render();
  } catch {
    setConnected(false);
  }
}

function setConnected(ok) {
  $('#dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('#connText').textContent = ok ? '연결됨' : '연결 끊김';
}

async function act(fn, successMessage) {
  try {
    const result = await fn();
    await refresh();
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    return result;
  } catch (err) {
    toast(err.message, true);
    refresh();
    return null;
  }
}

function toast(message, bad) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// 새 주문 알림음
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch {
    /* 무시 */
  }
}

/* ------------------------------------------------------------ 그리기 */

function isToday(iso) {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.toDateString() === new Date().toDateString();
}

function timeText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return isToday(iso) ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function orderTotal(order) {
  return order.items.reduce((s, it) => s + it.price, 0);
}

function render() {
  renderSummary();
  renderSalesDays();
  renderNongraStatus();
  renderStoreStatus();
  renderQty();
  renderOrders();
  renderSaleGrid();
}

// 날짜별 매출 표 (발송글 기준 판매일)
function renderSalesDays() {
  const list = $('#salesDayList');
  list.innerHTML = '';
  const rows = state.salesSummary || [];
  $('#emptySalesDay').classList.toggle('hidden', rows.length > 0);

  // 설정된 경계(시작 시각)들을 보여줍니다. 이상하면 되돌리기로 고칠 수 있게.
  const bounds = state.salesDays || [];
  const boundsEl = $('#salesDayBounds');
  if (boundsEl) {
    boundsEl.textContent = bounds.length
      ? '판매일 시작 기록: ' + bounds.map((b) => `${labelText(b.label)}은 ${timeText(b.at)}부터`).join(' · ')
      : '';
    boundsEl.classList.toggle('hidden', !bounds.length);
  }

  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'item';
    const isCurrent = r.label === state.currentLabel;
    li.innerHTML = `
      <div class="item-info"><div class="item-name">${labelText(r.label)}${isCurrent ? ' <span class="chip status-ready">진행 중</span>' : ''}</div></div>
      <div class="stock-n">${fmt(r.count)}<small>주문</small></div>
      <div class="stock-n">${fmt(r.qty)}<small>수량</small></div>
      <div class="stock-n" style="min-width:90px">${fmt(r.amount)}<small>매출(원)</small></div>`;
    list.appendChild(li);
  }
}

$('#newSalesDay').addEventListener('click', () => {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const def = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const label = prompt('① 새 판매일 날짜 (예: 2026-08-03)\n이 날짜 매출로 잡힙니다.', def);
  if (label === null) return;

  const now = new Date();
  const defTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const at = prompt(
    '② 시작 시각 - 이 시각 이후 주문부터 위 날짜 매출이 됩니다.\n'
    + '   지금부터면 그대로 확인만 누르세요.\n'
    + '   지난 시각으로 고치려면: 18:00 (오늘) 또는 2026-08-02 18:00',
    defTime,
  );
  if (at === null) return;

  act(
    () => api('/api/salesday', { method: 'POST', body: JSON.stringify({ label: label.trim(), at: at.trim() }) }),
    (r) => `${labelText(r.currentLabel)} 판매일 시작! 지정한 시각 이후 주문이 이 날짜 매출로 잡힙니다.`,
  );
});

$('#undoSalesDay').addEventListener('click', () => {
  if (!confirm('마지막 판매일 시작을 취소할까요?')) return;
  act(() => api('/api/salesday/undo', { method: 'POST', body: '{}' }), '되돌렸습니다.');
});

function renderStoreStatus() {
  const s = state.store || {};
  const el = $('#storeStatus');
  if (!s.configured) {
    el.textContent = '아직 연동 전입니다. [설정]에서 애플리케이션 ID/시크릿을 저장하면 결제된 주문이 자동으로 들어옵니다.';
  } else if (!s.ready) {
    el.textContent = '⚠ 연동 부품이 설치되지 않았습니다. 시작하기.bat을 다시 실행해 주세요.';
  } else {
    const parts = ['연동 중 · 5분마다 결제된 주문을 자동으로 가져옵니다'];
    if (s.fetchedAt) parts.push(`마지막 확인 ${timeText(s.fetchedAt)}`);
    if (s.error) parts.push(`⚠ ${s.error}`);
    el.textContent = parts.join(' · ');
  }
}

// 배송비·포장 같은 항목은 꽃 품목이 아니므로 집계·가격 학습에서 뺍니다.
function isShippingItem(name) {
  return /배송|택배|퀵|포장/.test(name);
}

// 주문서에 나온 품목들로부터 개당 가격을 자동으로 배웁니다. (최신 주문 우선)
function learnedProducts() {
  const map = new Map(); // name → { unit, count }
  for (const o of state.orders) { // orders는 최신순
    if (o.status === 'canceled') continue;
    for (const it of o.items) {
      if (isShippingItem(it.name)) continue;
      const existing = map.get(it.name);
      const unit = it.qty > 0 && it.price > 0 ? Math.round(it.price / it.qty) : 0;
      if (existing) {
        existing.count += it.qty;
        if (!existing.unit && unit) existing.unit = unit;
      } else {
        map.set(it.name, { unit, count: it.qty });
      }
    }
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, unit: v.unit, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

// '2026-08-03' → '8/3'
function labelText(label) {
  if (!label || label.length < 10) return label || '';
  return `${Number(label.slice(5, 7))}/${Number(label.slice(8, 10))}`;
}

function renderSummary() {
  const active = state.orders.filter((o) => o.status !== 'canceled');
  const newNongra = active.filter((o) => o.channel === 'nongra' && o.status === 'new').length;
  const newStore = active.filter((o) => o.channel === 'store' && o.status === 'new').length;

  // 이번 장(현재 판매일) 기준 주문·매출
  const cur = (state.salesSummary || []).find((r) => r.label === state.currentLabel)
    || { count: 0, amount: 0 };
  $('#labelCntToday').textContent = `이번 장(${labelText(state.currentLabel)}) 주문`;
  $('#labelSumToday').textContent = `이번 장(${labelText(state.currentLabel)}) 매출`;

  $('#cntNongra').textContent = fmt(newNongra);
  $('#cntStore').textContent = fmt(newStore);
  $('#cntToday').textContent = fmt(cur.count);
  $('#sumToday').textContent = fmt(cur.amount);

  // 새 주문이 늘어나면 알림음과 함께 알려줍니다.
  const newCount = newNongra + newStore;
  if (prevNewCount !== null && newCount > prevNewCount) {
    toast(`🌸 새 주문 ${newCount - prevNewCount}건 들어왔습니다!`);
    beep();
  }
  prevNewCount = newCount;
  document.title = (newCount ? `(${newCount}) ` : '') + '꽃 작업장 주문 관리';
}

function renderNongraStatus() {
  const n = state.nongra || {};
  const el = $('#nongraStatus');
  if (state.version) $('#connText').textContent = `연결됨 · ${state.version}`;

  // 농라F 판매글 수정 바로가기
  const editLink = $('#openEdit');
  if (n.editUrl) {
    editLink.href = n.editUrl;
    editLink.classList.remove('hidden');
  } else {
    editLink.classList.add('hidden');
  }
  if (!n.configured) {
    el.textContent = '아직 연동 전입니다. [설정]을 눌러 농라F 주문서 게시판 주소를 저장해 주세요.';
    return;
  }
  const parts = ['연동 중 · 3분마다 자동으로 주문서를 가져옵니다'];
  if (n.fetchedAt) parts.push(`마지막 확인 ${timeText(n.fetchedAt)}`);
  if (n.hasLogin) parts.push(n.loggedIn ? '로그인됨' : '로그인 안 됨');
  if (n.secretCount) parts.push(`🔒 비밀글 주문서 ${n.secretCount}건 - 아이디/비번 저장하면 자동 등록됩니다`);
  if (n.error) parts.push(`⚠ ${n.error}`);
  el.textContent = parts.join(' · ');
}

// 품목별 주문 수량 자동 집계 (취소·배송비 제외)
function renderQty() {
  const totals = new Map(); // name → { all, today }
  for (const o of state.orders) {
    if (o.status === 'canceled') continue;
    for (const it of o.items) {
      if (isShippingItem(it.name)) continue;
      const t = totals.get(it.name) || { all: 0, today: 0 };
      t.all += it.qty;
      if (isToday(o.createdAt)) t.today += it.qty;
      totals.set(it.name, t);
    }
  }

  const list = $('#qtyList');
  list.innerHTML = '';
  $('#emptyQty').classList.toggle('hidden', totals.size > 0);

  const sorted = [...totals.entries()].sort((a, b) => b[1].all - a[1].all);
  for (const [name, t] of sorted) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="item-info"><div class="item-name">${escapeHtml(name)}</div></div>
      <div class="stock-n">${fmt(t.today)}<small>오늘</small></div>
      <div class="stock-n">${fmt(t.all)}<small>전체</small></div>`;
    list.appendChild(li);
  }
}

function orderMatchesFilter(order, filter) {
  switch (filter) {
    case 'all': return true;
    case 'active': return order.status !== 'shipped' && order.status !== 'canceled';
    case 'shipped': return order.status === 'shipped';
    default: return order.channel === filter;
  }
}

function renderOrders() {
  const filter = $('#orderFilter').value;
  const list = $('#orderList');
  list.innerHTML = '';
  const visible = state.orders.filter((o) => orderMatchesFilter(o, filter));
  $('#emptyOrders').classList.toggle('hidden', visible.length > 0);

  for (const order of visible.slice(0, 100)) {
    const li = document.createElement('li');
    li.className = 'order';

    const top = document.createElement('div');
    top.className = 'order-top';
    top.innerHTML = `
      <span class="chip ${order.channel}">${CHANNEL_NAME[order.channel] || order.channel}</span>
      <span class="chip status-${order.status}">${STATUS_NAME[order.status] || order.status}</span>
      <span class="buyer">${escapeHtml(order.buyer || '(이름 없음)')}</span>
      <span class="no">#${order.no} · ${timeText(order.createdAt)}</span>
      <span class="total">${won(orderTotal(order))}</span>`;

    const itemsLine = document.createElement('div');
    itemsLine.className = 'order-items';
    itemsLine.textContent = order.items.map((it) => `${it.name} ${it.qty}개`).join(' · ');

    li.append(top, itemsLine);

    if (order.address || order.phone) {
      const addr = document.createElement('div');
      addr.className = 'order-addr';
      addr.textContent = [order.phone, order.address].filter(Boolean).join(' | ');
      li.appendChild(addr);
    }
    if (order.memo) {
      const memo = document.createElement('div');
      memo.className = 'order-addr';
      memo.textContent = order.memo;
      li.appendChild(memo);
    }

    const actions = document.createElement('div');
    actions.className = 'order-actions';

    // 주소가 있는 주문은 송장 등록 버튼 (이미 등록했으면 "다시"로 표시)
    const invoiced = (state.invoices || {})[order.id];
    if (order.address && order.status !== 'canceled') {
      const invBtn = toolBtn(invoiced ? '📦 송장 다시' : '📦 송장', () => registerInvoice(order, Boolean(invoiced)));
      if (!invoiced) invBtn.className = 'primary';
      actions.appendChild(invBtn);
    }

    if (order.status !== 'shipped' && order.status !== 'canceled') {
      actions.appendChild(toolBtn('✓ 완료', () =>
        act(() => api(`/api/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'shipped' }) }),
          `#${order.no} 완료 처리`)));
    }
    // 현장 판매는 실수했을 때 언제든 취소(수량 복구) 가능
    if (order.status !== 'canceled' && (order.status !== 'shipped' || order.channel === 'field')) {
      actions.appendChild(toolBtn('취소', () =>
        confirm(`주문 #${order.no}을(를) 취소할까요? 수량이 다시 더해집니다.`) &&
        act(() => api(`/api/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'canceled' }) }),
          '취소했습니다. 수량이 복구됐습니다.'), true));
    }
    actions.appendChild(toolBtn('삭제', () =>
      confirm(`주문 #${order.no} 기록을 삭제할까요?`) &&
      act(() => api(`/api/orders/${order.id}`, { method: 'DELETE' }), '삭제했습니다.'), true));
    li.appendChild(actions);

    list.appendChild(li);
  }
}

function toolBtn(label, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost' + (danger ? ' danger' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ------------------------------------------------------------ 현장 판매 */

let saleCart = []; // { name, qty, unit }

// 농라F 판매 페이지의 상품 목록이 있으면 그대로 보여주고, 없으면 주문에서 배운 목록 사용
function saleProducts() {
  const site = ((state.nongra || {}).sales || {}).products || [];
  if (site.length) {
    return site.map((p) => ({
      name: p.name,
      unit: p.price,
      stock: p.stock,
      progress: p.progress,
      sold: p.sold,
      fromSite: true,
    }));
  }
  return learnedProducts().slice(0, 20).map((p) => ({ name: p.name, unit: p.unit, fromSite: false }));
}

function saleQtyOf(name) {
  const line = saleCart.find((c) => c.name === name);
  return line ? line.qty : 0;
}

function changeSaleQty(name, unit, delta, maxStock) {
  let line = saleCart.find((c) => c.name === name);
  const next = (line ? line.qty : 0) + delta;
  if (next < 0) return;
  if (maxStock !== undefined && next > maxStock) {
    return toast(`재고가 ${maxStock}개뿐입니다.`, true);
  }
  if (!unit && delta > 0 && !line) {
    const input = prompt(`"${name}" 개당 가격(원)을 입력해 주세요.`, '');
    if (input === null) return;
    unit = Number(String(input).replace(/[^\d]/g, '')) || 0;
    if (!unit) return toast('가격을 확인해 주세요.', true);
  }
  if (!line && next > 0) {
    line = { name, qty: 0, unit };
    saleCart.push(line);
  }
  if (line) {
    line.qty = next;
    if (line.qty === 0) saleCart = saleCart.filter((c) => c !== line);
  }
  renderSaleGrid();
}

function addToSale(name, unit) {
  changeSaleQty(name, unit, +1);
}

// 농라F 페이지와 같은 모양: 상품명·가격 | [재고/진행/판매] | − 수량 +
function renderSaleGrid() {
  const list = $('#saleList');
  list.innerHTML = '';
  const products = saleProducts();
  $('#emptySale').classList.toggle('hidden', products.length > 0);

  // 사이트에 없는 직접 입력 품목도 표시되도록 합칩니다.
  const extra = saleCart.filter((c) => !products.some((p) => p.name === c.name))
    .map((c) => ({ name: c.name, unit: c.unit, fromSite: false }));

  for (const p of [...products, ...extra]) {
    const qty = saleQtyOf(p.name);
    const soldOut = p.fromSite && p.stock === 0;

    const li = document.createElement('li');
    li.className = 'item' + (soldOut ? ' soldout' : '');

    const info = document.createElement('div');
    info.className = 'item-info';
    const sub = p.fromSite
      ? `${won(p.unit)} · 재고:${fmt(p.stock)} 진행:${fmt(p.progress)} 판매:${fmt(p.sold)}`
      : (p.unit ? won(p.unit) : '가격 직접 입력');
    info.innerHTML = `
      <div class="item-name">${escapeHtml(p.name)}${soldOut ? ' <span class="chip soldout-chip">품절</span>' : ''}</div>
      <div class="item-sub">${escapeHtml(sub)}</div>`;

    const minus = stepBtn('−', 'step', () => changeSaleQty(p.name, p.unit, -1));
    const count = document.createElement('span');
    count.className = 'c-qty';
    count.textContent = qty;
    const plus = stepBtn('＋', 'step plus', () =>
      changeSaleQty(p.name, p.unit, +1, p.fromSite ? p.stock : undefined));
    plus.disabled = soldOut;

    li.append(info, minus, count, plus);
    list.appendChild(li);
  }

  const total = saleCart.reduce((s, c) => s + c.qty * c.unit, 0);
  const smsFee = total > 0 && total < 100000 ? 4000 : 0; // 10만원 이상 무료배송
  $('#saleTotal').textContent = won(total);
  $('#smsTotal').textContent = total > 0
    ? `${won(total + smsFee)}${smsFee ? ` (배송비 ${won(smsFee)})` : ' (무료배송)'}`
    : '0원';
  $('#saleSubmit').disabled = saleCart.length === 0;
  $('#smsSubmit').disabled = saleCart.length === 0;
}

function stepBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

$('#customAdd').addEventListener('click', () => {
  const name = $('#customName').value.trim();
  const unit = Number(String($('#customPrice').value).replace(/[^\d]/g, '')) || 0;
  if (!name) return toast('품목명을 입력해 주세요.', true);
  if (!unit) return toast('개당 가격을 입력해 주세요.', true);
  addToSale(name, unit);
  $('#customName').value = '';
  $('#customPrice').value = '';
});

$('#clearSale').addEventListener('click', () => {
  saleCart = [];
  renderSaleGrid();
});

$('#saleSubmit').addEventListener('click', async () => {
  if (!saleCart.length) return;
  const total = saleCart.reduce((s, c) => s + c.qty * c.unit, 0);
  const result = await act(() => api('/api/field-sale', {
    method: 'POST',
    body: JSON.stringify({
      items: saleCart.map((c) => ({ name: c.name, qty: c.qty, price: c.qty * c.unit })),
    }),
  }));
  if (result) {
    saleCart = [];
    renderSaleGrid();
    toast(`현장 판매 ${won(total)} 등록! 농라F 재고도 [✏️ 수정 열기]에서 줄여 주세요.`);
  }
});

/* ---------- 문자 주문 (현장판매 담기 그대로 사용) ---------- */

$('#smsSubmit').addEventListener('click', async () => {
  if (!saleCart.length) return;

  const buyer = prompt('① 손님 이름');
  if (buyer === null || !buyer.trim()) return;
  const phone = prompt('② 전화번호', '010-');
  if (phone === null) return;
  const address = prompt('③ 배송 주소');
  if (address === null) return;

  // 입금 계좌 문구는 한 번만 물어보고 저장됩니다.
  if (!state.smsAccount) {
    const account = prompt('입금 계좌 문구를 한 번만 설정해 주세요.\n(안내 문자에 들어갑니다. 예: 농협 000-0000-0000-00 명정원예)');
    if (account && account.trim()) {
      await api('/api/sms-account', { method: 'POST', body: JSON.stringify({ account: account.trim() }) }).catch(() => {});
    }
  }

  const result = await act(() => api('/api/sms-order', {
    method: 'POST',
    body: JSON.stringify({
      buyer: buyer.trim(),
      phone: phone.trim(),
      address: address.trim(),
      items: saleCart.map((c) => ({ name: c.name, qty: c.qty, price: c.qty * c.unit })),
    }),
  }));
  if (!result) return;

  saleCart = [];
  renderSaleGrid();

  // 안내 문구 표시 + 자동 복사
  $('#smsMsgText').value = result.message;
  $('#smsMsgBox').classList.remove('hidden');
  try {
    await navigator.clipboard.writeText(result.message);
    toast(`문자 주문 #${result.order.no} 등록! 안내 문구가 복사됐습니다 - 문자에 붙여넣으세요.`);
  } catch {
    toast(`문자 주문 #${result.order.no} 등록! 아래 문구를 복사해서 보내세요.`);
  }
});

$('#copySmsMsg').addEventListener('click', async () => {
  const text = $('#smsMsgText').value;
  try {
    await navigator.clipboard.writeText(text);
    toast('복사됐습니다! 문자에 붙여넣으세요.');
  } catch {
    $('#smsMsgText').select();
    document.execCommand('copy');
    toast('복사됐습니다!');
  }
});

$('#closeSmsMsg').addEventListener('click', () => $('#smsMsgBox').classList.add('hidden'));

/* ---------- 송장 도우미 (롯데 ALPS) ---------- */

$('#alpsOpen').addEventListener('click', async () => {
  const btn = $('#alpsOpen');
  btn.disabled = true;
  btn.textContent = '여는 중…';
  const r = await act(() => api('/api/alps/open', { method: 'POST', body: '{}' }));
  btn.disabled = false;
  btn.textContent = '🖥 송장 창 열기';
  if (r) {
    $('#alpsStatus').textContent = `${r.message} 로그인 후 [건별주문접수] 화면을 열어 두세요.`;
    toast('송장 창을 열었습니다. 그 창에서 로그인해 주세요.');
  }
});

$('#alpsScan').addEventListener('click', async () => {
  try {
    const r = await api('/api/alps/scan');
    const lines = r.fields.map((f) => `[${f.구역 || '-'}] ${f.라벨 || '-'} → id:${f.id || '(없음)'}${f.값 ? ` = ${f.값}` : ''}`);
    $('#alpsStatus').textContent = `화면에서 찾은 칸 ${r.fields.length}개 (아래)`;
    alert('송장 화면의 입력칸:\n\n' + lines.join('\n'));
  } catch (err) {
    toast(err.message, true);
  }
});

$('#alpsCheck').addEventListener('click', async () => {
  const btn = $('#alpsCheck');
  btn.disabled = true;
  btn.textContent = '확인 중…';
  try {
    const s = await api('/api/alps/status');
    const parts = [s.message];
    if (s.shipper) parts.push(`송하인: ${s.shipper}`);
    else if (s.form) parts.push('⚠ 송하인 칸을 확인하지 못했습니다');
    if (s.missing && s.missing.length) parts.push(`못 찾은 칸: ${s.missing.join(', ')}`);
    $('#alpsStatus').textContent = parts.join(' · ');
    toast(s.form ? '송장 화면에 연결됐습니다.' : s.message, !s.form);
  } catch (err) {
    $('#alpsStatus').textContent = err.message;
    toast(err.message, true);
  }
  btn.disabled = false;
  btn.textContent = '상태 확인';
});

// 주문 하나를 송장 폼에 채우고, 확인 후 저장까지
async function registerInvoice(order, force) {
  if (!order.address) return toast('주소가 없는 주문입니다.', true);

  const fill = await act(() => api('/api/alps/fill', {
    method: 'POST',
    body: JSON.stringify({ orderId: order.id, force: Boolean(force) }),
  }));
  if (!fill) return undefined;

  const lines = [
    `#${order.no} ${order.buyer} 님 송장을 채웠습니다.`,
    ...Object.entries(fill.filled || {}).map(([, v]) => `· ${v}`),
  ];
  if (fill.warnings && fill.warnings.length) {
    lines.push('', '확인해 주세요:', ...fill.warnings.map((w) => `- ${w}`));
  }
  lines.push('', '브라우저 화면을 확인하셨나요? 저장할까요?');

  if (!confirm(lines.join('\n'))) {
    return toast('채우기만 했습니다. 화면에서 직접 저장하셔도 됩니다.');
  }

  const saved = await act(() => api('/api/alps/save', {
    method: 'POST',
    body: JSON.stringify({ orderId: order.id }),
  }));
  if (!saved) return undefined;
  return toast(saved.verified
    ? `송장 저장 완료! #${order.no} 발송 완료로 바꿨습니다.`
    : '저장을 눌렀지만 확인이 안 됐습니다. 브라우저 화면에서 확인해 주세요.', !saved.verified);
}

/* ------------------------------------------------------------ 농라F 연동 */

$('#toggleSetup').addEventListener('click', () => $('#setup').classList.toggle('hidden'));
$('#cancelSetup').addEventListener('click', () => $('#setup').classList.add('hidden'));

$('#saveNongra').addEventListener('click', async () => {
  const url = $('#nongraUrl').value.trim();
  const mbId = $('#nongraId').value.trim();
  if (!url && !mbId && !$('#nongraEditUrl').value.trim()) {
    return toast('주문서 게시판 주소를 붙여넣어 주세요.', true);
  }
  const body = {};
  if (url) body.url = url;
  const editUrl = $('#nongraEditUrl').value.trim();
  if (editUrl) body.editUrl = editUrl;
  if (mbId) {
    body.mbId = mbId;
    body.mbPw = $('#nongraPw').value;
  }
  const result = await act(
    () => api('/api/nongra/settings', { method: 'POST', body: JSON.stringify(body) }),
    '연동 완료! 주문서를 자동으로 가져옵니다.',
  );
  if (result) {
    $('#nongraUrl').value = '';
    $('#nongraPw').value = '';
    $('#nongraEditUrl').value = '';
    $('#setup').classList.add('hidden');
  }
});

$('#runDiag').addEventListener('click', async () => {
  const out = $('#diagOut');
  out.classList.remove('hidden');
  out.textContent = '진단 중… (몇 초 걸립니다)';
  try {
    const d = await api('/api/nongra/diag');
    let text = `프로그램 버전: ${state.version || '?'}\n로그인: ${d.loggedIn ? '됨' : '안 됨'}\n`;
    text += `게시판 목록 응답: ${d.listStatus} (${fmt(d.listSize)}바이트)\n`;
    text += `발견한 글 번호: ${d.foundPostIds.join(', ') || '없음 ← 주소가 맞는지 확인'}\n`;
    if (d.orderPage) {
      text += `\n===== 주문배송 페이지 =====\n주소: ${d.orderPage.url}\n`;
      if (d.orderPage.error) {
        text += `오류: ${d.orderPage.error}\n`;
      } else {
        text += `응답: ${fmt(d.orderPage.bytes)}바이트 · 읽은 주문: ${d.orderPage.orders}건\n`;
        if (d.orderPage.productLinks && d.orderPage.productLinks.length) {
          text += `상품 관련 메뉴 링크:\n${d.orderPage.productLinks.map((l) => `  ${l}`).join('\n')}\n`;
        }
        if (d.orderPage.sample && d.orderPage.sample.length) text += `주문 예시: ${d.orderPage.sample.join(' | ')}\n`;
        text += `내용 미리보기:\n${d.orderPage.textPreview}\n`;
      }
    } else {
      text += '\n(주문배송 페이지를 아직 찾지 못했습니다)\n';
    }
    if (d.productAdmin) {
      text += '\n===== 판매상품 관리 페이지 분석 (재고 자동수정 준비) =====\n';
      if (d.productAdmin.error) {
        text += `오류: ${d.productAdmin.error}\n`;
      } else {
        text += `주소: ${d.productAdmin.url}\n크기: ${fmt(d.productAdmin.bytes)}바이트 · 전송 주소: ${d.productAdmin.action}\n`;
        text += `입력 항목: ${(d.productAdmin.fields || []).join(', ') || '없음'}\n`;
        text += `"재고" 주변 화면 글자:\n${d.productAdmin.textAroundStock}\n`;
        if (d.productAdmin.rawAroundStock) text += `"재고" 주변 원본 코드:\n${d.productAdmin.rawAroundStock}\n`;
      }
    } else {
      text += '\n(판매상품 관리 페이지를 아직 찾지 못했습니다 - 몇 분 뒤 다시 진단해 보세요)\n';
    }
    if (d.alps) {
      text += '\n===== 롯데택배 파트너(ALPS) 분석 (송장 자동등록 준비) =====\n';
      if (d.alps.error) {
        text += `오류: ${d.alps.error}\n`;
      } else {
        text += `응답: ${d.alps.status} (${fmt(d.alps.bytes)}바이트) · 폼: ${d.alps.formAction}\n`;
        if (d.alps.inputs && d.alps.inputs.length) text += `입력칸: ${d.alps.inputs.join(', ')}\n`;
        if (d.alps.apiEndpoints && d.alps.apiEndpoints.length) {
          text += `발견한 API 주소들:\n${d.alps.apiEndpoints.map((a) => `  ${a}`).join('\n')}\n`;
        }
      }
    }
    if (d.editForm) {
      text += '\n===== 판매글 수정 폼 분석 (읽기만, 재고 자동수정 준비용) =====\n';
      if (d.editForm.error) {
        text += `오류: ${d.editForm.error}\n`;
      } else {
        text += `주소: ${d.editForm.url}\n응답: ${d.editForm.status} (${fmt(d.editForm.bytes)}바이트)\n`;
        text += `전송 주소(action): ${d.editForm.action}\n`;
        text += `입력 항목들: ${(d.editForm.fields || []).join(', ') || '없음'}\n`;
        if (d.editForm.productRows && d.editForm.productRows.length) {
          text += `상품 관련 칸:\n${d.editForm.productRows.map((r) => `  ${r}`).join('\n')}\n`;
        }
        if (d.editForm.productAround) {
          text += `상품명 주변 원본 코드 (재고 차감 준비):\n${d.editForm.productAround}\n`;
        }
      }
    }
    for (const p of d.posts) {
      text += `\n───── 글 #${p.wrId} ─────\n`;
      if (p.error) {
        text += `오류: ${p.error}\n`;
        continue;
      }
      text += `응답: ${p.status} (${fmt(p.bytes)}바이트) · iframe: ${p.frames || 0}개 · 제목: ${p.title}\n`;
      if (p.finalUrl) text += `실제 주소: ${p.finalUrl}\n`;
      text += `상품표: ${p.widgetProducts}개 · 주문내역: ${p.siteOrders}건 · 본문품목: ${p.bodyItemsFound}개 · 비밀글: ${p.secret ? '예' : '아니오'}\n`;
      if (p.widgetSample && p.widgetSample.length) text += `상품 예시: ${p.widgetSample.join(' | ')}\n`;
      if (p.orderSample && p.orderSample.length) text += `주문 예시: ${p.orderSample.join(' | ')}\n`;
      if (p.stockSpots && p.stockSpots.length) {
        text += `"재고" 글자 주변 원본 코드 (상품표 형식 확인용):\n`;
        p.stockSpots.forEach((s, i) => { text += `[${i + 1}] ${s}\n`; });
      } else if (!p.error) {
        text += '(이 페이지 원본에 "재고"라는 글자가 없습니다)\n';
      }
      text += `페이지 내용 미리보기:\n${p.textPreview}\n`;
    }
    text += '\n※ 이 화면을 캡처해서 보내주시면 사이트에 맞게 조정해 드릴 수 있습니다.';
    out.textContent = text;
  } catch (err) {
    out.textContent = '진단 실패: ' + err.message;
  }
});

$('#nongraNow').addEventListener('click', async () => {
  const btn = $('#nongraNow');
  btn.disabled = true;
  btn.textContent = '확인 중…';
  await act(() => api('/api/nongra/refresh', { method: 'POST', body: '{}' }), '방금 확인했습니다.');
  btn.disabled = false;
  btn.textContent = '↻ 지금 확인';
});

/* ------------------------------------------------------------ 스토어 연동 */

$('#toggleStoreSetup').addEventListener('click', () => $('#storeSetup').classList.toggle('hidden'));
$('#cancelStoreSetup').addEventListener('click', () => $('#storeSetup').classList.add('hidden'));

$('#saveStore').addEventListener('click', async () => {
  const clientId = $('#storeId').value.trim();
  const clientSecret = $('#storeSecret').value.trim();
  if (!clientId || !clientSecret) return toast('애플리케이션 ID와 시크릿을 모두 붙여넣어 주세요.', true);
  const result = await act(
    () => api('/api/store/settings', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) }),
    '스토어 연동 완료! 결제된 주문을 자동으로 가져옵니다.',
  );
  if (result) {
    $('#storeId').value = '';
    $('#storeSecret').value = '';
    $('#storeSetup').classList.add('hidden');
  }
});

$('#storeNow').addEventListener('click', async () => {
  const btn = $('#storeNow');
  btn.disabled = true;
  btn.textContent = '확인 중…';
  await act(() => api('/api/store/refresh', { method: 'POST', body: '{}' }), '방금 확인했습니다.');
  btn.disabled = false;
  btn.textContent = '↻ 지금 확인';
});

/* ------------------------------------------------------------ 스토어 주문 등록 */

$('#toggleOrderForm').addEventListener('click', () => {
  $('#orderForm').classList.toggle('hidden');
  if (!$('#orderForm').classList.contains('hidden')) $('#ofBuyer').focus();
});
$('#cancelOrderForm').addEventListener('click', () => $('#orderForm').classList.add('hidden'));

$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const itemsText = $('#ofItems').value.trim();
  if (!itemsText) return toast('품목을 입력해 주세요.', true);

  const result = await act(() => api('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      channel: 'store',
      buyer: $('#ofBuyer').value,
      phone: $('#ofPhone').value,
      address: $('#ofAddress').value,
      itemsText,
    }),
  }));
  if (result) {
    ['#ofBuyer', '#ofPhone', '#ofAddress', '#ofItems'].forEach((s) => { $(s).value = ''; });
    $('#orderForm').classList.add('hidden');
    toast(`주문 #${result.order.no} 등록 완료! 수량·매출에 반영됐습니다.`);
  }
});

$('#orderFilter').addEventListener('change', renderOrders);

$('#resetAll').addEventListener('click', () => {
  if (!confirm('주문 기록을 전부 비울까요? 되돌릴 수 없습니다.\n(농라F 연동 설정은 유지됩니다)')) return;
  act(() => api('/api/reset-all', { method: 'POST', body: '{}' }), '전부 비웠습니다.');
});

/* ------------------------------------------------------------ 시작 */

$('#accessHint').textContent = `접속 주소: ${location.host} (같은 와이파이 휴대폰에서도 접속 가능)`;
refresh();
setInterval(refresh, 3000); // 어느 기기에서 봐도 3초 안에 같은 내용으로 맞춰집니다.
