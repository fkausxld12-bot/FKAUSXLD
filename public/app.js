'use strict';

/* 꽃 작업장 주문·판매 관리 - 화면 동작 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let state = { products: [], orders: [], history: [], nongra: {} };
let cart = []; // { productId, name, qty, unitPrice }
let toastTimer = null;
let bandInbox = []; // 마지막으로 가져온 밴드 글·댓글
let pendingCommentKey = null; // 주문 폼에 채워 넣은 밴드 댓글
let bandFetchedAt = null; // 서버가 마지막으로 밴드를 확인한 시각
let prevUnprocessed = null; // 새 댓글 알림용 이전 개수

const CHANNEL_NAME = { nongra: '농라', store: '스토어', field: '현장' };
const STATUS_NAME = { new: '신규', paid: '입금확인', ready: '발송대기', shipped: '발송완료', canceled: '취소' };
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
  el.className = 'toast no-print' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ------------------------------------------------------------ 탭 */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + tab.dataset.tab));
  });
});

/* ------------------------------------------------------------ 그리기 */

function render() {
  renderSummary();
  renderOrders();
  renderProductGrid();
  renderCart();
  renderStock();
  renderHistory();
  renderInvoicePick();
  renderBandStatus();
}

function isToday(iso) {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.toDateString() === new Date().toDateString();
}

function renderSummary() {
  const active = state.orders.filter((o) => o.status !== 'canceled');
  const newNongra = active.filter((o) => o.channel === 'nongra' && o.status === 'new').length;
  const newStore = active.filter((o) => o.channel === 'store' && o.status === 'new').length;
  const ready = active.filter((o) => o.status !== 'shipped').length;
  const todaySales = active
    .filter((o) => isToday(o.createdAt))
    .reduce((s, o) => s + o.items.reduce((a, it) => a + it.price, 0), 0);

  $('#cntNongra').textContent = fmt(newNongra);
  $('#cntStore').textContent = fmt(newStore);
  $('#cntReady').textContent = fmt(ready);
  $('#sumToday').textContent = fmt(todaySales);

  setBadge('#badgeNew', newNongra + newStore);
  setBadge('#badgeReady', active.filter((o) => o.status === 'ready' || o.status === 'paid' || o.status === 'new')
    .filter((o) => o.channel !== 'field').length);
}

function setBadge(sel, n) {
  const el = $(sel);
  el.textContent = n;
  el.classList.toggle('hidden', n === 0);
}

/* ---------- 주문 목록 ---------- */

function orderMatchesFilter(order, filter) {
  switch (filter) {
    case 'all': return true;
    case 'active': return order.status !== 'shipped' && order.status !== 'canceled';
    case 'shipped': return order.status === 'shipped';
    case 'unprinted':
      return order.channel !== 'field' && order.status !== 'canceled' && !order.printedAt;
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

    const total = order.items.reduce((s, it) => s + it.price, 0);
    const top = document.createElement('div');
    top.className = 'order-top';
    const printedChip = order.channel === 'field' || order.status === 'canceled' ? ''
      : (order.printedAt
        ? '<span class="chip printed">송장 ✓</span>'
        : '<span class="chip unprinted">송장 미출력</span>');
    top.innerHTML = `
      <span class="chip ${order.channel}">${CHANNEL_NAME[order.channel] || order.channel}</span>
      <span class="chip status-${order.status}">${STATUS_NAME[order.status] || order.status}</span>
      ${printedChip}
      <span class="buyer">${escapeHtml(order.buyer || '(이름 없음)')}</span>
      <span class="no">#${order.no} · ${timeText(order.createdAt)}</span>
      <span class="total">${won(total)}</span>`;

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
      memo.textContent = '메모: ' + order.memo;
      li.appendChild(memo);
    }

    const actions = document.createElement('div');
    actions.className = 'order-actions';
    if (order.status !== 'shipped' && order.status !== 'canceled') {
      const nextMap = { new: ['paid', '입금확인'], paid: ['ready', '발송대기'], ready: ['shipped', '발송완료'] };
      const next = nextMap[order.status];
      if (next) {
        actions.appendChild(toolBtn(`→ ${next[1]}`, () =>
          act(() => api(`/api/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: next[0] }) }),
            `#${order.no} ${next[1]} 처리`)));
      }
      actions.appendChild(toolBtn('취소', () =>
        confirm(`주문 #${order.no}을(를) 취소할까요? (재고가 복구됩니다)`) &&
        act(() => api(`/api/orders/${order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'canceled' }) }),
          '취소했습니다. 재고를 복구했습니다.'), true));
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

function timeText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return isToday(iso) ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/* ---------- 현장 판매 ---------- */

function renderProductGrid() {
  const grid = $('#productGrid');
  grid.innerHTML = '';
  $('#emptyProducts').classList.toggle('hidden', state.products.length > 0);

  for (const p of state.products) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'product-btn' + (p.stock <= 0 ? ' out' : '');
    b.innerHTML = `
      <span class="p-name">${escapeHtml(p.name)}</span>
      <span class="p-price">${won(p.price)}</span>
      <span class="p-stock">재고 ${fmt(p.stock)}개</span>`;
    b.addEventListener('click', () => addToCart(p));
    grid.appendChild(b);
  }
}

function cartQty(productId) {
  const line = cart.find((c) => c.productId === productId);
  return line ? line.qty : 0;
}

function addToCart(product) {
  if (product.stock - cartQty(product.id) <= 0) {
    return toast(`"${product.name}" 재고가 없습니다.`, true);
  }
  const line = cart.find((c) => c.productId === product.id);
  if (line) line.qty += 1;
  else cart.push({ productId: product.id, name: product.name, qty: 1, unitPrice: product.price });
  renderCart();
}

function changeCartQty(line, delta) {
  const product = state.products.find((p) => p.id === line.productId);
  if (delta > 0 && product && product.stock - cartQty(line.productId) <= 0) {
    return toast(`"${line.name}" 재고가 없습니다.`, true);
  }
  line.qty += delta;
  if (line.qty <= 0) cart = cart.filter((c) => c !== line);
  renderCart();
}

function cartTotal() {
  return cart.reduce((s, c) => s + c.qty * c.unitPrice, 0);
}

function renderCart() {
  const list = $('#cartList');
  list.innerHTML = '';
  $('#emptyCart').classList.toggle('hidden', cart.length > 0);

  for (const line of cart) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'c-name';
    name.innerHTML = `${escapeHtml(line.name)}<span class="c-sub">개당 ${won(line.unitPrice)}</span>`;

    const minus = stepBtn('−', 'step', () => changeCartQty(line, -1));
    const qty = document.createElement('span');
    qty.className = 'c-qty';
    qty.textContent = line.qty;
    const plus = stepBtn('＋', 'step plus', () => changeCartQty(line, +1));

    const price = document.createElement('span');
    price.className = 'c-price';
    price.textContent = won(line.qty * line.unitPrice);

    li.append(name, minus, qty, plus, price);
    list.appendChild(li);
  }

  $('#cartTotal').textContent = won(cartTotal());
  updateChange();
  $('#checkout').disabled = cart.length === 0;
}

function stepBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function receivedValue() {
  return Number(String($('#received').value).replace(/[^\d]/g, '')) || 0;
}

function updateChange() {
  const total = cartTotal();
  const received = receivedValue();
  const change = received - total;
  const row = $('#cartChange').parentElement;
  row.classList.toggle('minus', received > 0 && change < 0);
  $('#cartChange').textContent = received > 0
    ? (change >= 0 ? won(change) : `${won(-change)} 부족`)
    : '0원';
}

$('#received').addEventListener('input', updateChange);

$$('.quick-pay button').forEach((b) => {
  b.addEventListener('click', () => {
    const input = $('#received');
    if (b.dataset.pay === 'exact') input.value = fmt(cartTotal());
    else input.value = fmt(receivedValue() + Number(b.dataset.pay));
    updateChange();
  });
});

$('#clearCart').addEventListener('click', () => {
  cart = [];
  $('#received').value = '';
  renderCart();
});

$('#checkout').addEventListener('click', async () => {
  if (!cart.length) return;
  const total = cartTotal();
  const received = receivedValue();
  if (received > 0 && received < total) {
    if (!confirm(`받은 돈이 ${won(total - received)} 모자랍니다. 그래도 판매 완료할까요?`)) return;
  }
  const result = await act(
    () => api('/api/field-sale', {
      method: 'POST',
      body: JSON.stringify({
        items: cart.map((c) => ({ productId: c.productId, name: c.name, qty: c.qty, price: c.qty * c.unitPrice })),
        received,
      }),
    }),
  );
  if (result) {
    cart = [];
    $('#received').value = '';
    renderCart();
    const changeText = received > 0 ? ` · 거스름돈 ${won(Math.max(0, result.change))}` : '';
    toast(`판매 완료 ${won(result.total)}${changeText} (재고 차감됨)`);
  }
});

/* ---------- 재고 ---------- */

function renderStock() {
  const list = $('#stockList');
  list.innerHTML = '';
  $('#emptyStock').classList.toggle('hidden', state.products.length > 0);

  for (const p of state.products) {
    const li = document.createElement('li');
    li.className = 'item';

    const info = document.createElement('div');
    info.className = 'item-info';
    info.innerHTML = `
      <div class="item-name">${escapeHtml(p.name)}</div>
      <div class="item-sub">개당 ${won(p.price)}</div>`;

    const minus = stepBtn('−', 'step', () =>
      act(() => api(`/api/products/${p.id}/adjust`, { method: 'POST', body: JSON.stringify({ delta: -1 }) })));
    const stock = document.createElement('div');
    stock.className = 'stock-n' + (p.stock <= 2 ? ' low' : '');
    stock.innerHTML = `${fmt(p.stock)}<small>남음</small>`;
    const plus = stepBtn('＋', 'step plus', () =>
      act(() => api(`/api/products/${p.id}/adjust`, { method: 'POST', body: JSON.stringify({ delta: +1 }) })));

    const edit = toolBtn('수정', () => editProduct(p));
    const del = toolBtn('삭제', () =>
      confirm(`"${p.name}" 품목을 삭제할까요?`) &&
      act(() => api(`/api/products/${p.id}`, { method: 'DELETE' }), '삭제했습니다.'), true);

    li.append(info, minus, stock, plus, edit, del);
    list.appendChild(li);
  }
}

function editProduct(p) {
  const name = prompt('품목명', p.name);
  if (name === null) return;
  const price = prompt('개당 가격(원)', p.price);
  if (price === null) return;
  const stock = prompt('재고 수량(개)', p.stock);
  if (stock === null) return;
  act(() => api(`/api/products/${p.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, price, stock }),
  }), '수정했습니다.');
}

function renderHistory() {
  const list = $('#historyList');
  list.innerHTML = '';
  const visible = state.history.slice(0, 40);
  $('#emptyHistory').classList.toggle('hidden', visible.length > 0);
  for (const h of visible) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = h.text;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = timeText(h.at);
    li.append(text, when);
    list.appendChild(li);
  }
}

/* ---------- 송장 출력 ---------- */

function shippableOrders() {
  return state.orders.filter((o) => o.channel !== 'field' && o.status !== 'shipped' && o.status !== 'canceled');
}

function renderInvoicePick() {
  const list = $('#invoicePick');
  const checkedBefore = new Set(
    $$('#invoicePick input:checked').map((c) => c.dataset.id),
  );
  list.innerHTML = '';
  const orders = shippableOrders();
  $('#emptyInvoice').classList.toggle('hidden', orders.length > 0);

  for (const order of orders) {
    const li = document.createElement('li');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.id = order.id;
    // 처음에는 송장을 아직 안 뽑은 주문만 체크해 둡니다.
    check.checked = checkedBefore.size === 0 ? !order.printedAt : checkedBefore.has(order.id);

    const printedChip = order.printedAt
      ? '<span class="chip printed">송장 ✓</span>'
      : '<span class="chip unprinted">송장 미출력</span>';
    const info = document.createElement('div');
    info.className = 'inv-info';
    info.innerHTML = `
      <div><b>${escapeHtml(order.buyer || '(이름 없음)')}</b>
        <span class="chip ${order.channel}">${CHANNEL_NAME[order.channel]}</span>
        <span class="chip status-${order.status}">${STATUS_NAME[order.status]}</span>
        ${printedChip}</div>
      <div class="inv-sub">${escapeHtml([order.phone, order.address].filter(Boolean).join(' | ') || '주소 없음')}</div>
      <div class="inv-sub">${escapeHtml(order.items.map((it) => `${it.name} ${it.qty}개`).join(' · '))}</div>`;

    li.append(check, info);
    list.appendChild(li);
  }
}

$('#invoiceSelectAll').addEventListener('click', () => {
  const checks = $$('#invoicePick input[type="checkbox"]');
  const allChecked = checks.every((c) => c.checked);
  checks.forEach((c) => { c.checked = !allChecked; });
});

$('#printInvoices').addEventListener('click', async () => {
  const ids = $$('#invoicePick input:checked').map((c) => c.dataset.id);
  if (!ids.length) return toast('출력할 주문을 선택해 주세요.', true);

  const orders = state.orders.filter((o) => ids.includes(o.id));
  const area = $('#printArea');
  area.innerHTML = orders.map((o) => `
    <div class="label">
      <div class="l-head"><span>${CHANNEL_NAME[o.channel]} 주문 #${o.no}</span><span>${new Date(o.createdAt).toLocaleDateString('ko-KR')}</span></div>
      <div class="l-to">받는 분: ${escapeHtml(o.buyer || '')}</div>
      <div class="l-phone">${escapeHtml(o.phone || '')}</div>
      <div class="l-addr">${escapeHtml(o.address || '')}</div>
      <div class="l-items">${escapeHtml(o.items.map((it) => `${it.name} ${it.qty}개`).join(', '))}</div>
      ${o.memo ? `<div class="l-memo">메모: ${escapeHtml(o.memo)}</div>` : ''}
    </div>`).join('');

  window.print();

  // 출력한 주문에 "송장 출력됨" 표시를 남깁니다.
  await act(() => api('/api/orders/printed', { method: 'POST', body: JSON.stringify({ ids }) }));

  if ($('#markShipped').checked) {
    await act(
      () => api('/api/orders/ship', { method: 'POST', body: JSON.stringify({ ids }) }),
      (r) => `${r.shipped}건 송장 출력 + 발송 완료 처리했습니다.`,
    );
  } else {
    toast(`${ids.length}건 송장 출력됨으로 표시했습니다.`);
  }
});

/* ---------- 주문 등록 폼 ---------- */

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
      channel: $('#ofChannel').value,
      buyer: $('#ofBuyer').value,
      phone: $('#ofPhone').value,
      address: $('#ofAddress').value,
      memo: $('#ofMemo').value,
      itemsText,
      commentKey: pendingCommentKey, // 농라 댓글에서 온 주문이면 중복 방지 표시
    }),
  }));
  if (result) {
    if (pendingCommentKey) {
      const c = findInboxComment(pendingCommentKey);
      if (c) c.processed = true;
      pendingCommentKey = null;
      renderBandInbox();
    }
    ['#ofBuyer', '#ofPhone', '#ofAddress', '#ofItems', '#ofMemo'].forEach((s) => { $(s).value = ''; });
    $('#orderForm').classList.add('hidden');
    toast(`주문 #${result.order.no} 등록 완료 (재고 차감됨)`);
  }
});

$('#orderFilter').addEventListener('change', renderOrders);

/* ---------- 농라(밴드) 연동 ---------- */

function findInboxComment(commentKey) {
  return bandInbox.find((p) => p.postKey === commentKey) || null;
}

function renderBandStatus() {
  const b = state.nongra || {};
  const status = $('#bandStatus');
  if (!b.configured) {
    status.textContent = '아직 연동 전입니다. 판매글 주소를 붙여넣고 저장해 주세요.';
  } else {
    const when = b.fetchedAt ? `마지막 확인 ${timeText(b.fetchedAt)}` : '첫 확인 중…';
    const login = b.hasLogin ? (b.loggedIn ? ' · 로그인됨(비밀댓글 표시)' : ' · 로그인 안 됨') : '';
    status.textContent = `연동 중 · 3분마다 자동 확인 · ${when}${login}`
      + (b.error ? ` · ⚠ ${b.error}` : '');
  }
  $('#bandInboxTitle').textContent = b.configured ? '주문서 (자동 확인 중)' : '주문서';

  // 배지는 서버가 세어준 미처리 댓글 수를 그대로 씁니다. (3초마다 자동 갱신)
  setBadge('#badgeBand', b.unprocessed || 0);

  // 새 댓글이 늘어나면 소리와 함께 알려줍니다.
  if (prevUnprocessed !== null && (b.unprocessed || 0) > prevUnprocessed) {
    toast(`🌸 농라에 새 주문서 ${b.unprocessed - prevUnprocessed}건! 농라 탭을 확인하세요.`);
    beep();
  }
  prevUnprocessed = b.unprocessed || 0;
  document.title = (b.unprocessed ? `(${b.unprocessed}) ` : '') + '꽃 작업장 주문·판매 관리';

  // 서버가 새로 가져온 내용이 있으면 목록도 자동으로 갱신합니다.
  if (b.configured && b.fetchedAt && b.fetchedAt !== bandFetchedAt) {
    bandFetchedAt = b.fetchedAt;
    loadBandInbox();
  }
}

async function loadBandInbox() {
  try {
    const result = await api('/api/nongra/inbox');
    bandInbox = result.inbox || [];
    renderBandInbox();
  } catch {
    // 연동 전이면 조용히 넘어갑니다.
  }
}

// 새 주문 댓글 알림음 (스피커가 없거나 차단되어도 앱은 정상 동작)
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

function renderBandInbox() {
  const box = $('#bandInbox');
  box.innerHTML = '';
  $('#emptyBand').classList.toggle('hidden', bandInbox.length > 0);

  for (const post of bandInbox) {
    const row = document.createElement('div');
    row.className = 'band-comment' + (post.processed ? ' done' : '');

    const text = document.createElement('div');
    text.className = 'band-comment-text';
    const summary = post.secret
      ? '🔒 비밀글이라 내용을 볼 수 없습니다. 설정에서 농라 아이디로 로그인해 주세요.'
      : post.items.map((it) => `${it.name} ${it.qty}개`).join(' · ');
    const total = post.secret ? 0 : post.items.reduce((s, it) => s + it.amount, 0);
    text.innerHTML = `<b>${escapeHtml(post.buyer || post.author || '주문서')}</b>
      ${escapeHtml(post.title)}
      <span class="band-snippet">${escapeHtml(summary)}${total ? ` · 합계 ${won(total)}` : ''}</span>
      <span class="when">${post.createdAt || ''}${post.processed ? ' · 처리됨' : ''}</span>`;
    row.appendChild(text);

    if (!post.processed && !post.secret) {
      const actions = document.createElement('div');
      actions.className = 'row-gap';
      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.className = 'primary';
      importBtn.textContent = '주문 등록';
      importBtn.addEventListener('click', () => importBandComment(post));
      actions.append(importBtn, toolBtn('무시', () => skipBandComment(post)));
      row.appendChild(actions);
    }
    box.appendChild(row);
  }
}

// 주문서 내용을 주문 폼에 채우고 주문 탭으로 이동합니다.
function importBandComment(post) {
  pendingCommentKey = post.postKey;
  $('#ofChannel').value = 'nongra';
  $('#ofBuyer').value = post.buyer || post.author || '';
  $('#ofPhone').value = post.phone || '';
  $('#ofAddress').value = post.address || '';
  $('#ofItems').value = post.itemsText || '';
  $('#ofMemo').value = `농라 주문서 #${post.wrId}`;
  $('#orderForm').classList.remove('hidden');
  $$('.tab').find((t) => t.dataset.tab === 'home').click();
  $('#ofPhone').focus();
  toast('주문서 내용을 채웠습니다. 확인하고 등록만 누르세요.');
}

function skipBandComment(post) {
  act(async () => {
    await api('/api/nongra/skip', { method: 'POST', body: JSON.stringify({ commentKey: post.postKey }) });
    post.processed = true;
    renderBandInbox();
  });
}

$('#toggleBandSetup').addEventListener('click', () => $('#bandSetup').classList.toggle('hidden'));

$('#saveNongra').addEventListener('click', async () => {
  const url = $('#nongraUrl').value.trim();
  const mbId = $('#nongraId').value.trim();
  if (!url && !mbId) return toast('판매글 주소를 붙여넣어 주세요.', true);
  const body = {};
  if (url) body.url = url;
  if (mbId) {
    body.mbId = mbId;
    body.mbPw = $('#nongraPw').value;
  }
  const result = await act(
    () => api('/api/nongra/settings', { method: 'POST', body: JSON.stringify(body) }),
    '연동 완료! 판매글 댓글을 가져왔습니다.',
  );
  if (result) {
    $('#nongraUrl').value = '';
    $('#nongraPw').value = '';
    $('#bandSetup').classList.add('hidden');
    loadBandInbox();
  }
});

$('#bandRefresh').addEventListener('click', async () => {
  const btn = $('#bandRefresh');
  btn.disabled = true;
  btn.textContent = '가져오는 중…';
  const result = await act(() => api('/api/nongra/refresh', { method: 'POST', body: '{}' }));
  btn.disabled = false;
  btn.textContent = '↻ 지금 바로 확인';
  if (!result) return;
  bandInbox = result.inbox || [];
  bandFetchedAt = result.fetchedAt || bandFetchedAt;
  renderBandInbox();
  const pending = bandInbox.filter((p) => !p.processed).length;
  toast(pending ? `처리 안 된 주문서가 ${pending}건 있습니다.` : '새로 처리할 주문서가 없습니다.');
});

/* ---------- 재고 등록 폼 ---------- */

$('#toggleStockForm').addEventListener('click', () => {
  $('#stockForm').classList.toggle('hidden');
  if (!$('#stockForm').classList.contains('hidden')) $('#stockText').focus();
});
$('#cancelStockForm').addEventListener('click', () => $('#stockForm').classList.add('hidden'));

$('#stockAdd').addEventListener('click', async () => {
  const text = $('#stockText').value.trim();
  if (!text) return toast('내용을 입력해 주세요.', true);
  const result = await act(() => api('/api/products/bulk', { method: 'POST', body: JSON.stringify({ text }) }));
  if (result) {
    $('#stockText').value = '';
    $('#stockForm').classList.add('hidden');
    const msg = [`${result.added}개 등록`];
    if (result.merged) msg.push(`${result.merged}개 재고 합침`);
    if (result.skipped.length) msg.push(`${result.skipped.length}줄 못 읽음`);
    toast(msg.join(', '));
  }
});

$('#resetAll').addEventListener('click', () => {
  if (!confirm('품목·주문·기록을 전부 비울까요? 되돌릴 수 없습니다.')) return;
  act(() => api('/api/reset-all', { method: 'POST', body: '{}' }), '전부 비웠습니다.');
});

/* ------------------------------------------------------------ 시작 */

$('#accessHint').textContent = `접속 주소: ${location.host}`;
refresh();
setInterval(refresh, 3000); // 여러 기기에서 열어도 3초마다 서로 맞춰집니다.
