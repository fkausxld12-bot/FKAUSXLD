'use strict';

/* 꽃 작업장 주문 관리 - 화면 동작
 * 농라F 주문서는 서버가 3분마다 자동으로 긁어와 주문 목록에 등록합니다.
 * 이 화면은 3초마다 서버 상태를 읽어 모든 기기에서 같은 내용을 보여줍니다. */

const $ = (sel) => document.querySelector(sel);

let state = { orders: [], nongra: {} };
let toastTimer = null;
let prevNewCount = null; // 새 주문 알림용

const CHANNEL_NAME = { nongra: '농라', store: '스토어', field: '현장' };
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
  renderNongraStatus();
  renderQty();
  renderOrders();
  renderSaleGrid();
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

function renderSummary() {
  const active = state.orders.filter((o) => o.status !== 'canceled');
  const newNongra = active.filter((o) => o.channel === 'nongra' && o.status === 'new').length;
  const newStore = active.filter((o) => o.channel === 'store' && o.status === 'new').length;
  const today = active.filter((o) => isToday(o.createdAt));

  $('#cntNongra').textContent = fmt(newNongra);
  $('#cntStore').textContent = fmt(newStore);
  $('#cntToday').textContent = fmt(today.length);
  $('#sumToday').textContent = fmt(today.reduce((s, o) => s + orderTotal(o), 0));

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
    if (order.status !== 'shipped' && order.status !== 'canceled') {
      actions.appendChild(toolBtn('✓ 완료', () =>
        act(() => api(`/api/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'shipped' }) }),
          `#${order.no} 완료 처리`)));
      actions.appendChild(toolBtn('취소', () =>
        confirm(`주문 #${order.no}을(를) 취소할까요?`) &&
        act(() => api(`/api/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'canceled' }) }),
          '취소했습니다.'), true));
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

function renderSaleGrid() {
  const grid = $('#saleGrid');
  grid.innerHTML = '';
  for (const p of learnedProducts().slice(0, 16)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'product-btn';
    b.innerHTML = `
      <span class="p-name">${escapeHtml(p.name)}</span>
      <span class="p-price">${p.unit ? won(p.unit) : '가격 직접 입력'}</span>`;
    b.addEventListener('click', () => addToSale(p.name, p.unit));
    grid.appendChild(b);
  }
}

function addToSale(name, unit) {
  if (!unit) {
    const input = prompt(`"${name}" 개당 가격(원)을 입력해 주세요.`, '');
    if (input === null) return;
    unit = Number(String(input).replace(/[^\d]/g, '')) || 0;
    if (!unit) return toast('가격을 확인해 주세요.', true);
  }
  const line = saleCart.find((c) => c.name === name);
  if (line) line.qty += 1;
  else saleCart.push({ name, qty: 1, unit });
  renderSaleCart();
}

function renderSaleCart() {
  const list = $('#saleCart');
  list.innerHTML = '';

  for (const line of saleCart) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'c-name';
    name.innerHTML = `${escapeHtml(line.name)}<span class="c-sub">개당 ${won(line.unit)}</span>`;

    const minus = stepBtn('−', 'step', () => {
      line.qty -= 1;
      if (line.qty <= 0) saleCart = saleCart.filter((c) => c !== line);
      renderSaleCart();
    });
    const qty = document.createElement('span');
    qty.className = 'c-qty';
    qty.textContent = line.qty;
    const plus = stepBtn('＋', 'step plus', () => {
      line.qty += 1;
      renderSaleCart();
    });

    const price = document.createElement('span');
    price.className = 'c-price';
    price.textContent = won(line.qty * line.unit);

    li.append(name, minus, qty, plus, price);
    list.appendChild(li);
  }

  const total = saleCart.reduce((s, c) => s + c.qty * c.unit, 0);
  $('#saleTotal').textContent = won(total);
  $('#saleSubmit').disabled = saleCart.length === 0;
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
  renderSaleCart();
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
    renderSaleCart();
    toast(`현장 판매 ${won(total)} 등록! 수량에 바로 반영됐습니다.`);
  }
});

/* ------------------------------------------------------------ 농라F 연동 */

$('#toggleSetup').addEventListener('click', () => $('#setup').classList.toggle('hidden'));
$('#cancelSetup').addEventListener('click', () => $('#setup').classList.add('hidden'));

$('#saveNongra').addEventListener('click', async () => {
  const url = $('#nongraUrl').value.trim();
  const mbId = $('#nongraId').value.trim();
  if (!url && !mbId) return toast('주문서 게시판 주소를 붙여넣어 주세요.', true);
  const body = {};
  if (url) body.url = url;
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
    $('#setup').classList.add('hidden');
  }
});

$('#runDiag').addEventListener('click', async () => {
  const out = $('#diagOut');
  out.classList.remove('hidden');
  out.textContent = '진단 중… (몇 초 걸립니다)';
  try {
    const d = await api('/api/nongra/diag');
    let text = `로그인: ${d.loggedIn ? '됨' : '안 됨'}\n`;
    text += `게시판 목록 응답: ${d.listStatus} (${fmt(d.listSize)}바이트)\n`;
    text += `발견한 글 번호: ${d.foundPostIds.join(', ') || '없음 ← 주소가 맞는지 확인'}\n`;
    for (const p of d.posts) {
      text += `\n───── 글 #${p.wrId} ─────\n`;
      if (p.error) {
        text += `오류: ${p.error}\n`;
        continue;
      }
      text += `제목: ${p.title}\n`;
      text += `비밀글: ${p.secret ? '예' : '아니오'} · 본문 찾음: ${p.bodyFound ? '예' : '아니오'} · 읽은 품목: ${p.itemsFound}개\n`;
      if (p.items && p.items.length) {
        text += `품목: ${p.items.map((i) => `${i.name} ${i.qty}개`).join(', ')}\n`;
      }
      text += `본문 미리보기:\n${p.bodyPreview}\n`;
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
    toast(`스토어 주문 #${result.order.no} 등록 완료`);
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
