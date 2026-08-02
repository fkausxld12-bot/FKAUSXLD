'use strict';

/**
 * 꽃 작업장 주문/판매 관리 서버
 *  - 채널별(농라/스토어/현장) 주문 관리
 *  - 현장 판매 계산기 + 재고 자동 차감
 *  - 발송 대기 주문 송장 일괄 출력
 *
 * Node 내장 모듈만 사용합니다. (npm install 불필요)
 * 작업장 컴퓨터에서 `node server.js`로 실행해 두면
 * 같은 와이파이의 휴대폰/다른 PC에서도 접속됩니다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_VERSION = 'v20'; // 화면에 표시되어 어떤 버전인지 바로 알 수 있습니다.

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// 데이터는 프로그램 폴더가 아니라 사용자 홈에 저장합니다.
// → 프로그램을 새로 내려받아도 주문 기록과 연동 설정(키)이 그대로 유지됩니다.
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.flower-workshop');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const OLD_DB_FILE = path.join(__dirname, 'data', 'db.json');

// 예전 버전(프로그램 폴더 안 data/)을 쓰던 경우 한 번만 옮겨옵니다.
try {
  if (!fs.existsSync(DB_FILE) && fs.existsSync(OLD_DB_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(OLD_DB_FILE, DB_FILE);
    console.log('  이전 데이터를 새 저장 위치로 옮겼습니다:', DATA_DIR);
  }
} catch {
  /* 옮기기 실패 시 새로 시작 */
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const CHANNELS = ['nongra', 'store', 'field']; // 농라 / 스토어 / 현장
const STATUSES = ['new', 'paid', 'ready', 'shipped', 'canceled'];

/* ---------------------------------------------------------------- 저장소 */

const emptyDb = () => ({
  products: [], // { id, name, price, stock }
  orders: [], // { id, no, channel, buyer, phone, address, memo, items, status, createdAt, shippedAt, printedAt }
  history: [], // 재고 변동/판매 기록
  orderSeq: 0,
  // 농라(farmer4989.com 그누보드 게시판) 연동 설정
  nongra: {
    base: '', // 예: https://farmer4989.com/gnuboard5
    boTable: '', // 게시판 코드 (예: ymh14141)
    wrId: 0, // 고정 글 번호 (followLatest=false일 때만 사용)
    followLatest: true, // 항상 게시판의 최신 글을 추적
    short: false, // 짧은 주소(/게시판코드/글번호) 형식 사이트인지
    orderPageUrl: '', // 판매자용 주문배송 페이지 (자동 발견)
    lastTopWrId: 0, // 마지막으로 본 최신 글 번호 (새 판매글 감지용)
    mbId: '', // 사이트 로그인 아이디 (비밀댓글 보기용, 선택)
    mbPw: '',
    processed: {}, // 처리한 댓글 key → 주문 id 또는 'skipped'
  },
  // 판매일(장) 경계: 새 발송글 기준으로 매출 날짜를 나눕니다.
  salesDays: [], // [{ id, at, label: 'YYYY-MM-DD' }]
  // 스마트스토어(네이버 커머스 API) 연동 설정
  store: {
    clientId: '', // 애플리케이션 ID
    clientSecret: '', // 애플리케이션 시크릿
    lastSync: '', // 마지막으로 확인한 시각
    processed: {}, // productOrderId → 주문 id
  },
  updatedAt: new Date().toISOString(),
});

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const base = emptyDb();
    return {
      ...base,
      ...raw,
      products: Array.isArray(raw.products) ? raw.products : [],
      orders: Array.isArray(raw.orders) ? raw.orders : [],
      history: Array.isArray(raw.history) ? raw.history : [],
      orderSeq: Number(raw.orderSeq) || 0,
      salesDays: Array.isArray(raw.salesDays) ? raw.salesDays : [],
      nongra: {
        ...base.nongra,
        ...(raw.nongra || {}),
        // 이전 밴드 연동 버전에서 넘어온 처리 기록도 이어받습니다.
        processed: { ...((raw.band || {}).processed || {}), ...((raw.nongra || {}).processed || {}) },
      },
      store: { ...base.store, ...(raw.store || {}) },
    };
  } catch {
    return emptyDb();
  }
}

let db = loadDb();
let seq = Date.now();
const nextId = () => String(seq++);

function save() {
  db.updatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE); // 중간에 꺼져도 파일이 깨지지 않도록 교체 방식으로 저장
}

/* ---------------------------------------------------------------- 도우미 */

function num(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/[,\s원개]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function intAtLeast(value, min, fallback) {
  return Math.max(min, Math.floor(num(value, fallback)));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function findProduct(id) {
  return db.products.find((p) => p.id === id);
}

function findOrder(id) {
  return db.orders.find((o) => o.id === id);
}

function findProductByName(name) {
  const key = String(name).replace(/\s+/g, '');
  return db.products.find((p) => p.name.replace(/\s+/g, '') === key);
}

/**
 * "유스커스(3개) 9,000원" / "장미)자나(sp)(1개) 6,000원" / "해바라기 2개 14000"
 * 형태의 한 줄을 { name, qty, amount }로 해석합니다.
 */
function parseLine(raw) {
  const line = String(raw).replace(/\s+/g, ' ').trim();
  if (!line) return null;

  let amount = 0;
  let rest = line;
  const amountMatch = rest.match(/([\d,]+)\s*원?\s*$/);
  if (amountMatch && /\d/.test(amountMatch[1])) {
    amount = num(amountMatch[1]);
    rest = rest.slice(0, amountMatch.index).trim();
  }

  // 품목명에도 괄호가 있으므로 맨 끝의 "(N개)"/"N개"만 수량으로 봅니다.
  let qty = 1;
  const qtyMatch = rest.match(/\(?\s*(\d+)\s*개\s*\)?\s*$/);
  if (qtyMatch) {
    qty = intAtLeast(qtyMatch[1], 1, 1);
    rest = rest.slice(0, qtyMatch.index).trim();
  }

  const name = rest.replace(/[-·•\s]+$/, '').trim();
  if (!name) return null;
  return { name, qty, amount: Math.max(0, amount) };
}

function logHistory(type, text, extra = {}) {
  db.history.unshift({ id: nextId(), type, text, at: new Date().toISOString(), ...extra });
  if (db.history.length > 800) db.history.length = 800;
}

/** 재고를 차감(또는 복구)합니다. allowNegative=false면 부족할 때 에러. */
function adjustStock(items, direction, { allowMissing = true } = {}) {
  // 먼저 전부 검사하고 나서 반영합니다. (일부만 차감되는 일 방지)
  const plan = [];
  for (const it of items) {
    const product = it.productId ? findProduct(it.productId) : findProductByName(it.name);
    if (!product) {
      if (allowMissing) continue; // 재고 목록에 없는 품목은 그냥 넘어갑니다.
      throw httpError(400, `재고 목록에 없는 품목: ${it.name}`);
    }
    const change = direction * it.qty;
    if (product.stock - change < 0) {
      throw httpError(400, `"${product.name}" 재고가 부족합니다. (남은 수량 ${product.stock}개)`);
    }
    plan.push({ product, change });
  }
  for (const { product, change } of plan) product.stock -= change;
  return plan;
}

function normalizeOrderItems(rawItems) {
  const items = [];
  for (const it of rawItems || []) {
    const name = String(it.name || '').trim();
    if (!name) continue;
    const product = it.productId ? findProduct(it.productId) : findProductByName(name);
    const qty = intAtLeast(it.qty, 1, 1);
    let price = Math.max(0, num(it.price, 0)); // 해당 품목의 총액
    if (!price && product) price = product.price * qty; // 금액이 없으면 재고 목록의 개당가로 계산
    items.push({
      productId: product ? product.id : null,
      name,
      qty,
      price,
    });
  }
  return items;
}

function orderTotal(order) {
  return order.items.reduce((s, it) => s + it.price, 0);
}

/* ------------------------------------------------- 판매일(장) 기준 매출 */

function dateLabel(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 새 판매일 경계를 추가합니다. (새 발송글을 올린 시각 기준)
function addSalesDay(label, at, why) {
  const clean = String(label || '').trim() || dateLabel(new Date(Date.now() + 24 * 60 * 60 * 1000));
  db.salesDays.push({ id: nextId(), at: at || new Date().toISOString(), label: clean });
  db.salesDays.sort((a, b) => new Date(a.at) - new Date(b.at));
  if (db.salesDays.length > 60) db.salesDays.splice(0, db.salesDays.length - 60);
  logHistory('sale', `새 판매일 시작: ${clean}${why ? ` (${why})` : ''}`);
  save();
}

// "08월 03일" 같은 한국식 날짜를 판매일 라벨로 바꿉니다. (연말→연초 넘어감 처리)
function labelFromKoreanDate(mm, dd) {
  const now = new Date();
  let year = now.getFullYear();
  const cand = new Date(year, mm - 1, dd);
  if (cand.getTime() < now.getTime() - 180 * 24 * 3600 * 1000) year += 1;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function dateFromText(text) {
  const m = String(text || '').match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  return m ? labelFromKoreanDate(Number(m[1]), Number(m[2])) : '';
}

// 주문이 속하는 판매일: 주문 시각 이전의 마지막 경계 라벨, 없으면 달력 날짜
function salesDayLabelOf(createdAt) {
  const t = new Date(createdAt).getTime();
  let label = null;
  for (const b of db.salesDays) {
    if (new Date(b.at).getTime() <= t) label = b.label;
    else break;
  }
  return label || dateLabel(new Date(createdAt));
}

function currentSalesLabel() {
  return db.salesDays.length
    ? db.salesDays[db.salesDays.length - 1].label
    : dateLabel(new Date());
}

// 판매일별 주문 건수·수량·매출(배송비 제외 물품 금액) 집계
function salesSummary() {
  const map = new Map();
  for (const o of db.orders) {
    if (o.status === 'canceled') continue;
    const label = salesDayLabelOf(o.createdAt);
    const row = map.get(label) || { label, count: 0, qty: 0, amount: 0 };
    row.count += 1;
    for (const it of o.items) {
      row.amount += it.price;
      if (!/배송|택배|퀵|포장/.test(it.name)) row.qty += it.qty;
    }
    map.set(label, row);
  }
  return [...map.values()].sort((a, b) => b.label.localeCompare(a.label)).slice(0, 14);
}

/* ---------------------------------------------------------------- 라우팅 */

const routes = {
  'GET /api/state': () => ({
    products: db.products,
    orders: db.orders,
    history: db.history,
    nongra: {
      ...nongraPublic(), // 비밀번호는 내보내지 않습니다.
      unprocessed: nongraUnprocessedCount(),
      secretCount: nongraCache.inbox.filter((p) => p.secret && !db.nongra.processed[postKeyOf(p)]).length,
      fetchedAt: nongraCache.fetchedAt,
      error: nongraCache.error,
      loggedIn: nongraCache.loggedIn,
      sales: nongraCache.sales, // 판매 페이지 상품·재고·판매 현황
      orderedTotal: nongraCache.sales.products.reduce((s, p) => s + p.sold + p.progress, 0),
      // 판매글 수정 페이지 바로가기 (현장판매 후 재고를 손으로 줄일 때)
      editUrl: db.nongra.wrId && db.nongra.base && !db.nongra.short
        ? `${db.nongra.base}/bbs/write.php?bo_table=${encodeURIComponent(db.nongra.boTable)}&w=u&wr_id=${db.nongra.wrId}`
        : '',
    },
    store: storePublic(),
    salesDays: db.salesDays.slice(-5),
    currentLabel: currentSalesLabel(),
    salesSummary: salesSummary(),
    version: APP_VERSION,
    updatedAt: db.updatedAt,
  }),

  // 새 판매일 시작 (새 발송글을 올린 직후)
  'POST /api/salesday': (body) => {
    addSalesDay(body.label, body.at, '직접 시작');
    return { currentLabel: currentSalesLabel() };
  },

  // 실수로 눌렀을 때 마지막 판매일 경계 취소
  'POST /api/salesday/undo': () => {
    if (!db.salesDays.length) throw httpError(400, '되돌릴 판매일이 없습니다.');
    const removed = db.salesDays.pop();
    logHistory('sale', `판매일 취소: ${removed.label}`);
    return { currentLabel: currentSalesLabel() };
  },

  /* ---------- 재고(품목) ---------- */

  'POST /api/products': (body) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, '품목명이 필요합니다.');
    if (findProductByName(name)) throw httpError(400, '이미 있는 품목입니다.');
    const product = {
      id: nextId(),
      name,
      price: Math.max(0, num(body.price, 0)), // 개당 가격
      stock: intAtLeast(body.stock, 0, 0),
      createdAt: new Date().toISOString(),
    };
    db.products.push(product);
    return { product };
  },

  // "장미)자나(sp) 10개 60,000원" 같은 목록을 통째로 등록 (금액은 전체 금액으로 보고 개당가로 환산)
  'POST /api/products/bulk': (body) => {
    const lines = String(body.text || '').split(/\r?\n/);
    let added = 0;
    let merged = 0;
    const skipped = [];
    for (const line of lines) {
      if (!line.trim() || /^주문\s*목록$/.test(line.trim())) continue;
      const parsed = parseLine(line);
      if (!parsed) {
        skipped.push(line.trim());
        continue;
      }
      const existing = findProductByName(parsed.name);
      if (existing) {
        existing.stock += parsed.qty; // 같은 품목이면 재고를 더합니다.
        if (parsed.amount && parsed.qty) existing.price = Math.round(parsed.amount / parsed.qty);
        merged += 1;
      } else {
        db.products.push({
          id: nextId(),
          name: parsed.name,
          price: parsed.qty ? Math.round(parsed.amount / parsed.qty) : parsed.amount,
          stock: parsed.qty,
          createdAt: new Date().toISOString(),
        });
        added += 1;
      }
    }
    if (!added && !merged && !skipped.length) throw httpError(400, '등록할 내용이 없습니다.');
    logHistory('stock', `품목 목록 등록 (${added + merged}건)`);
    return { added, merged, skipped };
  },

  'PATCH /api/products/:id': (body, { id }) => {
    const product = findProduct(id);
    if (!product) throw httpError(404, '품목을 찾을 수 없습니다.');
    if (body.name !== undefined) product.name = String(body.name).trim() || product.name;
    if (body.price !== undefined) product.price = Math.max(0, num(body.price, product.price));
    if (body.stock !== undefined) {
      const before = product.stock;
      product.stock = intAtLeast(body.stock, 0, product.stock);
      if (product.stock !== before) {
        logHistory('stock', `${product.name} 재고 ${before} → ${product.stock}개 (직접 수정)`);
      }
    }
    return { product };
  },

  // 재고 빠르게 +1 / -1
  'POST /api/products/:id/adjust': (body, { id }) => {
    const product = findProduct(id);
    if (!product) throw httpError(404, '품목을 찾을 수 없습니다.');
    const delta = Math.floor(num(body.delta, 0));
    if (!delta) throw httpError(400, '수량을 확인해 주세요.');
    if (product.stock + delta < 0) throw httpError(400, '이미 0개입니다.');
    product.stock += delta;
    logHistory('stock', `${product.name} 재고 ${delta > 0 ? '+' : ''}${delta}개 (직접 조정)`);
    return { product };
  },

  'DELETE /api/products/:id': (_body, { id }) => {
    const before = db.products.length;
    db.products = db.products.filter((p) => p.id !== id);
    if (db.products.length === before) throw httpError(404, '품목을 찾을 수 없습니다.');
    return { ok: true };
  },

  /* ---------- 주문 (농라/스토어) ---------- */

  'POST /api/orders': (body) => {
    const channel = CHANNELS.includes(body.channel) ? body.channel : 'nongra';
    const items = body.itemsText
      ? String(body.itemsText).split(/\r?\n/).map(parseLine).filter(Boolean)
          .map((p) => ({ name: p.name, qty: p.qty, price: p.amount }))
      : body.items;
    const normalized = normalizeOrderItems(items);
    if (!normalized.length) throw httpError(400, '주문 품목이 필요합니다.');

    adjustStock(normalized, +1); // 주문이 잡히면 재고에서 미리 뺍니다.

    db.orderSeq += 1;
    const order = {
      id: nextId(),
      no: db.orderSeq,
      channel,
      buyer: String(body.buyer || '').trim(),
      phone: String(body.phone || '').trim(),
      address: String(body.address || '').trim(),
      memo: String(body.memo || '').trim(),
      items: normalized,
      status: STATUSES.includes(body.status) ? body.status : 'new',
      createdAt: new Date().toISOString(),
      shippedAt: null,
      printedAt: null,
    };
    db.orders.unshift(order);

    // 농라 댓글에서 가져온 주문이면 해당 댓글을 처리됨으로 표시 (중복 방지)
    if (body.commentKey) {
      db.nongra.processed[String(body.commentKey)] = order.id;
    }

    logHistory('order', `주문 #${order.no} 등록 (${channelName(channel)}) - 재고 차감`);
    return { order };
  },

  'PATCH /api/orders/:id': (body, { id }) => {
    const order = findOrder(id);
    if (!order) throw httpError(404, '주문을 찾을 수 없습니다.');
    for (const key of ['buyer', 'phone', 'address', 'memo']) {
      if (body[key] !== undefined) order[key] = String(body[key]).trim();
    }
    if (body.status !== undefined) setStatus(order, body.status);
    return { order };
  },

  'POST /api/orders/:id/status': (body, { id }) => {
    const order = findOrder(id);
    if (!order) throw httpError(404, '주문을 찾을 수 없습니다.');
    setStatus(order, body.status);
    return { order };
  },

  // 송장 출력 완료 표시 (여러 건 한 번에)
  'POST /api/orders/printed': (body) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    let printed = 0;
    for (const id of ids) {
      const order = findOrder(id);
      if (order && order.status !== 'canceled') {
        order.printedAt = new Date().toISOString();
        printed += 1;
      }
    }
    if (printed) logHistory('order', `송장 ${printed}건 출력`);
    return { printed };
  },

  // 여러 주문을 한 번에 발송 완료 처리 (송장 출력 후)
  'POST /api/orders/ship': (body) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    let shipped = 0;
    for (const id of ids) {
      const order = findOrder(id);
      if (order && order.status !== 'shipped' && order.status !== 'canceled') {
        setStatus(order, 'shipped');
        shipped += 1;
      }
    }
    if (!shipped) throw httpError(400, '발송 처리할 주문이 없습니다.');
    return { shipped };
  },

  'DELETE /api/orders/:id': (_body, { id }) => {
    const order = findOrder(id);
    if (!order) throw httpError(404, '주문을 찾을 수 없습니다.');
    if (order.status !== 'canceled') {
      adjustStock(order.items, -1); // 삭제하면 재고를 되돌립니다.
    }
    db.orders = db.orders.filter((o) => o.id !== id);
    logHistory('order', `주문 #${order.no} 삭제 - 재고 복구`);
    return { ok: true };
  },

  /* ---------- 농라(farmer4989 게시판) 연동 ---------- */

  'POST /api/nongra/settings': async (body) => {
    if (body.url !== undefined && String(body.url).trim()) {
      const parsed = parseNongraUrl(body.url);
      db.nongra.base = parsed.base;
      db.nongra.boTable = parsed.boTable;
      db.nongra.wrId = parsed.wrId;
      db.nongra.short = parsed.short;
      db.nongra.followLatest = body.followLatest !== undefined ? Boolean(body.followLatest) : true;
      nongraCache.inbox = [];
      nongraCache.fetchedAt = null;
      nongraCache.cookies = {};
      nongraCache.loggedIn = false;
    }
    if (body.followLatest !== undefined) db.nongra.followLatest = Boolean(body.followLatest);
    if (body.mbId !== undefined) {
      db.nongra.mbId = String(body.mbId).trim();
      db.nongra.mbPw = String(body.mbPw || '').trim();
      nongraCache.cookies = {};
      nongraCache.loggedIn = false;
    }
    // 설정이 바뀌면 바로 한 번 가져와서 화면에 보여줍니다.
    // 짧은 주소면 실제 사이트 경로부터 알아냅니다. (로그인·목록 주소 보정)
    if (db.nongra.short) await discoverGnuPath();
    if (db.nongra.base && db.nongra.boTable) await pollNongra(true);
    if (nongraCache.error) throw httpError(502, `저장은 했지만 가져오기 실패: ${nongraCache.error}`);
    return { nongra: nongraPublic() };
  },

  // 자동으로 모아둔 농라 글·댓글 (서버가 3분마다 갱신)
  'GET /api/nongra/inbox': () => {
    if (!db.nongra.base) throw httpError(400, '농라 게시글 주소를 먼저 저장해 주세요.');
    return {
      inbox: nongraInboxWithFlags(),
      fetchedAt: nongraCache.fetchedAt,
      error: nongraCache.error,
    };
  },

  // 지금 바로 다시 가져오기
  'POST /api/nongra/refresh': async () => {
    if (!db.nongra.base) throw httpError(400, '농라 게시글 주소를 먼저 저장해 주세요.');
    await pollNongra(true);
    if (nongraCache.error) throw httpError(502, nongraCache.error);
    return {
      inbox: nongraInboxWithFlags(),
      fetchedAt: nongraCache.fetchedAt,
    };
  },

  // 연동 진단: 서버가 게시판에서 무엇을 보고 있는지 그대로 보여줍니다.
  'GET /api/nongra/diag': async () => {
    const n = db.nongra;
    if (!n.base || !n.boTable) throw httpError(400, '먼저 연동 설정을 저장해 주세요.');
    if (n.mbId && !nongraCache.loggedIn) await nongraLogin().catch(() => {});

    const listRes = await nongraFetch(nongraListUrl());
    const listHtml = await listRes.text();
    const wrIds = parseWrIds(listHtml, n.boTable);

    // 설정한 판매 페이지를 맨 먼저, 그다음 최신 글 2개를 진단합니다.
    const targets = [];
    if (n.wrId) targets.push(n.wrId);
    for (const id of wrIds) {
      if (!targets.includes(id) && targets.length < 3) targets.push(id);
    }

    const posts = [];
    for (const wrId of targets) {
      try {
        const { res, html, frames } = await nongraFetchPage(nongraPostUrl(wrId));
        discoverOrderPage(html, res.url || nongraPostUrl(wrId));
        const widget = parseSalesWidget(html);
        const siteOrders = parseSiteOrders(html);
        const p = parseOrderPost(html, wrId);
        const fullText = stripTags(
          html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''),
        );

        // "재고"라는 글자가 원본 코드 어디에, 어떤 모양으로 있는지 그대로 보여줍니다.
        const stockSpots = [];
        let idx = -1;
        while (stockSpots.length < 2 && (idx = html.indexOf('재고', idx + 1)) >= 0) {
          stockSpots.push(html.slice(Math.max(0, idx - 120), idx + 280).replace(/\s+/g, ' '));
        }
        // 실시간 재고를 그리는 스크립트 앞부분 (AJAX 주소 확인용)
        const showIdx = html.indexOf('stock_show1');
        if (showIdx >= 0) {
          stockSpots.push('[스크립트] ' + html.slice(Math.max(0, showIdx - 700), showIdx + 100).replace(/\s+/g, ' '));
        }

        posts.push({
          wrId,
          status: res.status,
          bytes: html.length,
          frames,
          finalUrl: res.url || '',
          title: p.title,
          secret: p.secret,
          widgetProducts: widget.length,
          widgetSample: widget.slice(0, 3).map((w) => `${w.name} ${w.price}원 재고:${w.stock} 판매:${w.sold}`),
          siteOrders: siteOrders.length,
          orderSample: siteOrders.slice(0, 2).map((o) => `${o.orderNo} ${o.buyer} ${o.items.map((i) => `${i.name} ${i.qty}개`).join(',')}`),
          bodyItemsFound: p.items.length,
          stockSpots,
          textPreview: fullText.slice(0, 400) || '(내용 없음)',
        });
      } catch (err) {
        posts.push({ wrId, error: err.message });
      }
    }
    // 판매글 수정 폼 분석 (읽기만 합니다 - 아무것도 바꾸지 않음)
    // → 현장판매 시 재고를 자동으로 줄이는 기능을 만들기 위한 구조 확인용
    let editForm = null;
    if (n.wrId) {
      try {
        const editUrl = `${n.base}/bbs/write.php?bo_table=${encodeURIComponent(n.boTable)}&w=u&wr_id=${n.wrId}`;
        const res = await nongraFetch(editUrl);
        const html = await res.text();
        const formM = html.match(/<form[^>]*action=["']([^"']+)["'][^>]*>/i);
        const fields = [];
        const fre = /<(input|select|textarea)\b[^>]*name=["']([^"']+)["'][^>]*>/gi;
        let fm;
        while ((fm = fre.exec(html)) && fields.length < 60) {
          const tag = fm[0];
          const valueM = tag.match(/value=["']([^"']{0,40})/);
          fields.push(`${fm[2]}${valueM && valueM[1] ? `=${valueM[1]}` : ''}`);
        }
        editForm = {
          url: editUrl,
          status: res.status,
          bytes: html.length,
          action: formM ? formM[1] : '(폼을 찾지 못함)',
          fields,
        };
      } catch (err) {
        editForm = { error: err.message };
      }
    }

    // 주문배송 페이지가 발견됐으면 그 페이지도 진단합니다.
    let orderPage = null;
    if (db.nongra.orderPageUrl) {
      try {
        const { html: oh } = await nongraFetchPage(db.nongra.orderPageUrl);
        const found = parseSiteOrders(oh);
        const otext = stripTags(
          oh.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''),
        );
        // 주문 형식 확인용: 첫 날짜가 나오는 부분부터 보여줍니다.
        const dateM = otext.match(/\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}/);
        orderPage = {
          url: db.nongra.orderPageUrl,
          bytes: oh.length,
          orders: found.length,
          sample: found.slice(0, 2).map((o) => `${o.orderNo} ${o.buyer} ${o.items.map((i) => `${i.name} ${i.qty}개`).join(',')}`),
          textPreview: dateM
            ? otext.slice(Math.max(0, dateM.index - 100), dateM.index + 700)
            : otext.slice(0, 500) + '\n(날짜 형식의 주문을 찾지 못했습니다)',
        };
      } catch (err) {
        orderPage = { url: db.nongra.orderPageUrl, error: err.message };
      }
    }

    return {
      loggedIn: nongraCache.loggedIn,
      listStatus: listRes.status,
      listSize: listHtml.length,
      foundPostIds: wrIds,
      orderPage,
      editForm,
      posts,
    };
  },

  // 댓글을 주문으로 만들지 않고 처리됨으로만 표시
  'POST /api/nongra/skip': (body) => {
    const key = String(body.commentKey || '').trim();
    if (!key) throw httpError(400, '댓글 정보가 없습니다.');
    db.nongra.processed[key] = db.nongra.processed[key] || 'skipped';
    return { ok: true };
  },

  /* ---------- 현장 판매 계산기 ---------- */

  'POST /api/field-sale': (body) => {
    const items = normalizeOrderItems(body.items);
    if (!items.length) throw httpError(400, '판매할 품목을 담아 주세요.');

    adjustStock(items, +1); // 재고 자동 차감

    db.orderSeq += 1;
    const order = {
      id: nextId(),
      no: db.orderSeq,
      channel: 'field',
      buyer: String(body.buyer || '현장 손님').trim(),
      phone: '',
      address: '',
      memo: String(body.memo || '').trim(),
      items,
      status: 'shipped', // 현장 판매는 그 자리에서 끝
      createdAt: new Date().toISOString(),
      shippedAt: new Date().toISOString(),
      printedAt: null,
    };
    db.orders.unshift(order);

    const total = orderTotal(order);
    const received = Math.max(0, num(body.received, 0));
    logHistory('sale', `현장 판매 ${total.toLocaleString('ko-KR')}원 (${items.map((i) => `${i.name} ${i.qty}`).join(', ')})`, { orderId: order.id });
    return { order, total, received, change: received ? received - total : 0 };
  },

  /* ---------- 초기화 ---------- */

  'POST /api/reset-orders': () => {
    db.orders = [];
    db.history = [];
    db.orderSeq = 0;
    return { ok: true };
  },

  'POST /api/reset-all': () => {
    const nongra = { ...db.nongra, processed: {} }; // 연동 설정은 남겨둡니다.
    db = emptyDb();
    db.nongra = nongra;
    return { ok: true };
  },
};

function setStatus(order, status) {
  if (!STATUSES.includes(status)) throw httpError(400, '알 수 없는 상태입니다.');
  if (order.status === status) return;

  // 취소로 바꾸면 재고 복구, 취소를 되돌리면 다시 차감
  if (status === 'canceled' && order.status !== 'canceled') {
    adjustStock(order.items, -1);
    logHistory('order', `주문 #${order.no} 취소 - 재고 복구`);
  } else if (order.status === 'canceled' && status !== 'canceled') {
    adjustStock(order.items, +1);
    logHistory('order', `주문 #${order.no} 취소 해제 - 재고 차감`);
  }

  order.status = status;
  order.shippedAt = status === 'shipped' ? new Date().toISOString() : order.shippedAt;
  if (status === 'shipped') logHistory('order', `주문 #${order.no} 발송 완료`);
}

function channelName(channel) {
  return { nongra: '농라', store: '스토어', field: '현장' }[channel] || channel;
}

/* ------------------------------------------------- 농라(그누보드) 연동 */

// 비밀번호는 화면으로 다시 보내지 않습니다.
function nongraPublic() {
  const n = db.nongra;
  return {
    configured: Boolean(n.base && n.boTable),
    base: n.base,
    boTable: n.boTable,
    wrId: n.wrId,
    followLatest: n.followLatest,
    hasLogin: Boolean(n.mbId),
  };
}

// 붙여넣은 게시글/게시판 주소에서 사이트 주소·게시판 코드·글 번호를 뽑아냅니다.
// 두 형식을 모두 지원: farmer4989.com/ymh14141/49 (짧은 주소),
//                     .../bbs/board.php?bo_table=ymh14141&wr_id=49
function parseNongraUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw httpError(400, '주소가 올바르지 않습니다. 게시글 주소를 그대로 붙여넣어 주세요.');
  }

  const boTableParam = url.searchParams.get('bo_table');
  if (boTableParam) {
    const wrId = Number(url.searchParams.get('wr_id')) || 0;
    const basePath = url.pathname.replace(/\/bbs\/[^/]*$/, '');
    return { base: url.origin + basePath, boTable: boTableParam, wrId, short: false };
  }

  // 짧은 주소: /게시판코드/글번호
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg.length >= 1 && /^[A-Za-z0-9_]+$/.test(seg[0])) {
    return {
      base: url.origin,
      boTable: seg[0],
      wrId: seg[1] && /^\d+$/.test(seg[1]) ? Number(seg[1]) : 0,
      short: true,
    };
  }
  throw httpError(400, '게시판 주소를 알아보지 못했습니다. 주문서 페이지 주소를 그대로 붙여넣어 주세요.');
}

function nongraListUrl() {
  const n = db.nongra;
  return n.short
    ? `${n.base}/${n.boTable}`
    : `${n.base}/bbs/board.php?bo_table=${encodeURIComponent(n.boTable)}`;
}

function nongraPostUrl(wrId) {
  const n = db.nongra;
  return n.short
    ? `${n.base}/${n.boTable}/${wrId}`
    : `${n.base}/bbs/board.php?bo_table=${encodeURIComponent(n.boTable)}&wr_id=${wrId}`;
}

// 자동으로 가져온 농라 글·댓글 캐시. 화면은 이 캐시를 읽어갑니다.
const nongraCache = {
  inbox: [], // 주문서 글 후보들
  sales: { wrId: 0, products: [], fetchedAt: null }, // 판매 페이지의 상품·재고·판매 현황
  fetchedAt: null,
  error: '',
  polling: false,
  cookies: {}, // 로그인 세션 쿠키
  loggedIn: false,
};

// 판매 페이지에서 읽은 상품 현황을 반영하고, 판매 수량이 늘면 기록을 남깁니다.
function applySalesWidget(wrId, widget) {
  const prevMap = new Map(nongraCache.sales.products.map((p) => [p.name, p]));
  for (const p of widget) {
    const old = prevMap.get(p.name);
    if (old) {
      const diff = (p.sold + p.progress) - (old.sold + old.progress);
      if (diff > 0) {
        logHistory('sale', `농라F: ${p.name} ${diff}개 주문됨 (남은 재고 ${p.stock}개)`);
      }
    }
    if (p.stock === 0 && (!old || old.stock > 0)) {
      logHistory('stock', `농라F: ${p.name} 품절`);
    }
  }
  nongraCache.sales = { wrId, products: widget, fetchedAt: new Date().toISOString() };
}

const NONGRA_POLL_MS = 3 * 60 * 1000; // 3분마다 자동 확인

function nongraCookieHeader() {
  return Object.entries(nongraCache.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function nongraStoreCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const line of list) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) nongraCache.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

async function nongraFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      // 짧은 주소가 실제 글 주소로 이동(redirect)하는 사이트를 따라갑니다.
      redirect: 'follow',
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Cookie: nongraCookieHeader(),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw httpError(502, '농라 사이트에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
  nongraStoreCookies(res);
  return res;
}

// 페이지 안의 모든 링크(주소+글자)를 뽑습니다. "주문배송" 메뉴를 찾는 데 씁니다.
function findLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 400) {
    out.push({ href: m[1], text: stripTags(m[2]).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// 페이지에서 판매자용 "주문배송/주문내역" 메뉴 주소를 찾아 기억해 둡니다.
function discoverOrderPage(html, baseUrl) {
  if (db.nongra.orderPageUrl) return;
  const link = findLinks(html).find((l) => /주문배송|주문내역|주문관리/.test(l.text));
  if (!link) return;
  try {
    const abs = new URL(link.href, baseUrl);
    if (abs.host === new URL(db.nongra.base).host) {
      db.nongra.orderPageUrl = abs.toString();
      logHistory('order', `농라F 주문배송 페이지 발견: ${abs.pathname}`);
      save();
    }
  } catch {
    /* 잘못된 링크는 무시 */
  }
}

/**
 * 페이지를 가져오고, 내용이 iframe(페이지 속 별도 페이지) 안에 있는 스킨이면
 * 같은 사이트의 iframe 내용까지 합쳐서 돌려줍니다.
 */
async function nongraFetchPage(url) {
  const res = await nongraFetch(url);
  let html = await res.text();

  const frameSrcs = [];
  const re = /<i?frame[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && frameSrcs.length < 3) {
    const src = m[1];
    if (/^(javascript:|about:|data:)/i.test(src)) continue;
    try {
      const abs = new URL(src, res.url || url);
      const siteHost = new URL(db.nongra.base).host;
      if (abs.host === siteHost) frameSrcs.push(abs.toString());
    } catch {
      /* 잘못된 주소는 무시 */
    }
  }
  for (const src of frameSrcs) {
    try {
      const fres = await nongraFetch(src);
      html += `\n<!-- iframe: ${src} -->\n${await fres.text()}`;
    } catch {
      /* iframe 하나 실패해도 계속 */
    }
  }
  return { res, html, frames: frameSrcs.length };
}

/**
 * 짧은 주소(farmer4989.com/게시판/글)를 붙여넣은 경우, 글 페이지 안의 링크에서
 * 실제 그누보드 경로(/gnuboard5 등)를 알아내 로그인·목록 주소를 바로잡습니다.
 */
async function discoverGnuPath() {
  const n = db.nongra;
  if (!n.short || !n.base || !n.boTable) return false;
  try {
    const url = `${n.base}/${n.boTable}${n.wrId ? `/${n.wrId}` : ''}`;
    const res = await nongraFetch(url);
    const html = await res.text();
    const m = html.match(/["'](\/[^"'<>]{0,60}?)\/bbs\/(?:login_check|board|write)\.php/)
      || html.match(/["'](\/[^"'<>]{0,60}?)\/skin\/board\//);
    if (!m) return false;
    n.base = new URL(n.base).origin + m[1];
    n.short = false;
    nongraCache.cookies = {};
    nongraCache.loggedIn = false;
    logHistory('order', `농라F 실제 경로 자동 감지: ${m[1]}`);
    save();
    return true;
  } catch {
    return false;
  }
}

// 그누보드 로그인 (비밀댓글 확인용)
async function nongraLogin() {
  const n = db.nongra;
  if (!n.mbId || !n.mbPw) return false;
  const body = new URLSearchParams({
    mb_id: n.mbId,
    mb_password: n.mbPw,
    url: n.base + '/',
  });
  const res = await nongraFetch(`${n.base}/bbs/login_check.php`, {
    method: 'POST',
    redirect: 'manual', // 로그인은 302 응답 자체로 성공을 판단합니다.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // 성공하면 302로 되돌려보내고, 실패하면 안내 페이지(200)가 옵니다.
  nongraCache.loggedIn = res.status >= 300 && res.status < 400;
  return nongraCache.loggedIn;
}

function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    // 문단·표의 줄(행)이 끝나면 줄바꿈으로 취급해야 품목이 줄 단위로 읽힙니다.
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// 게시판 목록 페이지에서 글 번호들을 최신순으로 찾습니다.
// 두 링크 형식 모두 지원: board.php?bo_table=X&wr_id=N, /X/N (짧은 주소)
function parseWrIds(html, boTable, limit = 15) {
  const ids = new Set();
  const patterns = [
    new RegExp(`bo_table=${boTable}(?:&(?:amp;)?[^"'\\s]*)?&(?:amp;)?wr_id=(\\d+)`, 'g'),
    new RegExp(`href="[^"]*/${boTable}/(\\d+)`, 'g'),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) ids.add(Number(m[1]));
  }
  return [...ids].sort((a, b) => b - a).slice(0, limit);
}

// 주문서 본문에서 "받는분: 홍길동" 같은 항목을 찾습니다.
function pickField(lines, labels) {
  for (const line of lines) {
    const m = line.match(new RegExp(`^\\s*(?:${labels})\\s*[:：]?\\s*(.+)$`));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

// 그누보드5 글(주문서) 페이지에서 제목·작성자·품목 수량을 뽑아냅니다.
function parseOrderPost(html, wrId) {
  // 비밀글이면 비밀번호 입력 폼이 뜹니다.
  if (/name="wr_password"|비밀글\s*기능으로|비밀글\s*입니다/.test(html) && !/id="bo_v_con"/.test(html)) {
    return { wrId, secret: true, title: `비밀글 #${wrId}`, author: '', items: [], itemsText: '' };
  }

  const titleMatch = html.match(/<span[^>]*class="[^"]*bo_v_tit[^"]*"[^>]*>([\s\S]*?)<\/span>/)
    || html.match(/<h1[^>]*id="bo_v_title"[^>]*>([\s\S]*?)<\/h1>/)
    || html.match(/<title>([\s\S]*?)<\/title>/);
  const title = titleMatch ? stripTags(titleMatch[1]) : `글 ${wrId}`;

  // 글 상단(댓글 이전) 영역에서 작성자를 찾습니다.
  const beforeComments = html.split(/<section[^>]*id="bo_vc"/)[0];
  const authorMatch = beforeComments.match(/class="[^"]*sv_member[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/)
    || beforeComments.match(/class="[^"]*sv_guest[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/);
  const author = authorMatch ? stripTags(authorMatch[1]) : '';

  const timeMatch = beforeComments.match(/datetime="([^"]+)"/)
    || beforeComments.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)
    || beforeComments.match(/(\d{2}-\d{2} \d{2}:\d{2})/);

  // 본문: 그누보드 스킨마다 조금씩 달라 여러 방법으로 찾습니다.
  const bodyMatch = html.match(/<!--\s*본문 내용 시작[\s\S]*?-->([\s\S]*?)<!--\s*[}\s]*본문 내용 끝/)
    || html.match(/id="bo_v_con"[^>]*>([\s\S]*?)(?:<!--|<\/section|<section|id="bo_v_sns"|id="bo_vc")/)
    || html.match(/<section[^>]*id="bo_v_atc"[^>]*>([\s\S]*?)<\/section>/)
    || html.match(/class="[^"]*view[-_]?content[^"]*"[^>]*>([\s\S]*?)<\/section/);
  const bodyText = bodyMatch ? stripTags(bodyMatch[1]) : '';
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);

  // 품목 줄: "유스커스(3개) 9,000원" 형식을 전부 수집
  // 합계/받는분/연락처/주소 같은 안내 줄과 전화번호 줄은 품목이 아닙니다.
  const NOT_ITEM = /^(합계|총|배송비|주문\s*목록|입금|받는\s*분|받는사람|성함|이름|주문자|연락처|전화|휴대폰|폰|주소|배송지|배송|요청|메모)/;
  const PHONE = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/;
  const items = [];
  const itemLines = [];
  for (const line of lines) {
    if (NOT_ITEM.test(line) || PHONE.test(line)) continue;
    const parsed = parseLine(line);
    if (parsed && /\d\s*개/.test(line)) {
      items.push(parsed);
      itemLines.push(line);
    }
  }

  return {
    wrId,
    secret: false,
    title,
    author,
    createdAt: timeMatch ? timeMatch[1] : null,
    buyer: pickField(lines, '받는\\s*분|받는사람|성함|이름|주문자|입금자') || author,
    phone: pickField(lines, '연락처|전화번호|휴대폰|전화|폰')
      || (bodyText.match(/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/) || [''])[0],
    address: pickField(lines, '주소|배송지|배송\\s*주소'),
    items,
    itemsText: itemLines.join('\n'),
    debugBody: bodyText.slice(0, 500), // 진단 화면용
  };
}

/**
 * 판매 페이지의 상품 선택표를 읽습니다.
 * "장미)원탑(sp) [재고:10 진행:0 판매:6] 8,000원" 형태의 줄을
 * { name, price, stock, progress, sold }로 만듭니다.
 */
function parseSalesWidget(html) {
  const text = stripTags(
    String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''),
  );
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const products = [];
  let pending = null; // 이름·가격이 먼저 나오고 다음 줄에 [재고...]가 오는 스킨 대응

  for (const line of lines) {
    const counts = line.match(/재고\s*[:：]?\s*(\d+)[^\d]{0,12}진행\s*[:：]?\s*(\d+)[^\d]{0,12}판매\s*[:：]?\s*(\d+)/);
    if (!counts) {
      // 다음 줄에 [재고...]가 오는 스킨을 위해 이 줄을 후보로 기억해 둡니다.
      const np = line.match(/^(.+?)\s*([\d,]{3,})\s*원\s*$/);
      if (np && !/합계|배송|총|주문/.test(np[1])) {
        pending = { name: np[1].trim(), price: num(np[2]) };
      } else if (line.length <= 60 && !/^[−\-+\d\s,원개]+$/.test(line)
        && !/상품\s*선택|주문수량|합계|배송|영수증/.test(line)) {
        pending = { name: line, price: 0 }; // 상품명만 있는 줄
      } else {
        pending = null;
      }
      continue;
    }

    const priceMatch = line.match(/([\d,]{3,})\s*원/);
    const cut = Math.min(counts.index, priceMatch ? priceMatch.index : Infinity);
    let name = line.slice(0, cut).replace(/[[\]|·\-–—+\d\s]+$/, '').trim();
    let price = priceMatch ? num(priceMatch[1]) : 0;
    if (!name && pending) {
      name = pending.name;
      price = price || pending.price;
    }
    pending = null;
    if (!name || /상품\s*선택|주문수량|합계/.test(name)) continue;

    products.push({
      name,
      price,
      stock: Number(counts[1]),
      progress: Number(counts[2]),
      sold: Number(counts[3]),
    });
  }
  return products;
}

/**
 * 판매 페이지 아래의 주문 목록을 읽습니다. 화면 형식:
 *   26-08-02 18:16 [i] 25244070 [영수증] 입금완료
 *   임현경 (멜리싸) 01053964460
 *   [임현경] 경기 고양시 ... 영어학원
 *   국화)아르거스 (1 개)
 *   장미)비포썬셋(sp) (1 개)
 *   22,000 원
 */
function parseSiteOrders(html) {
  const text = stripTags(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<option(?![^>]*selected)[^>]*>[\s\S]*?<\/option>/gi, ''),
  );
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const entries = [];
  let cur = null;
  let preamble = []; // 주문 카드 상단(날짜 줄 위)에 나오는 총액·운송장 정보
  const pushCur = () => {
    if (cur) entries.push(cur);
    cur = null;
  };

  for (const line of lines) {
    // "26-08-02 19:02" 형태의 날짜 줄이 주문의 시작입니다. ("일시 :" 줄은 제외)
    const start = !/일시/.test(line) && line.match(/(\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (start) {
      pushCur();
      // 카드 상단 정보: 운송장 번호가 실제로 있으면 발송완료입니다.
      // ("택배발송" 같은 상태 후보 단어는 모든 카드에 있으므로 근거로 쓰지 않습니다)
      const shipped = preamble.some((l) => /invno|tracking|운송장\s*[:번]/.test(l))
        || preamble.some((l) => /^\d{10,13}$/.test(l));
      let preTotal = 0;
      for (const l of preamble) {
        const t = l.match(/^([\d,]{4,})\s*원\s*$/);
        if (t) preTotal = num(t[1]);
      }
      cur = {
        orderNo: (line.match(/\b(\d{6,})\b/) || [])[1] || '',
        date: start[1],
        time: start[2],
        dateFull: '',
        status: shipped ? '택배발송' : '',
        buyer: '',
        phone: '',
        address: '',
        items: [],
        total: preTotal,
        shipping: 0,
        payTotal: 0,
      };
      preamble = [];
      continue;
    }
    if (!cur) {
      preamble.push(line);
      continue;
    }

    // 주문번호가 자기 줄에 따로 있는 형식
    if (!cur.orderNo) {
      const om = line.match(/^(\d{6,})$/);
      if (om) {
        cur.orderNo = om[1];
        continue;
      }
    }

    // "일시 : 2026-08-02 19:02:12" 가 나오면 이 주문 카드는 끝
    const timeM = line.match(/일시\s*:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (timeM) {
      cur.dateFull = timeM[1];
      cur.time = timeM[2];
      pushCur();
      continue;
    }

    const shipM = line.match(/택배요금\s*:\s*([\d,]+)/);
    if (shipM) {
      cur.shipping = num(shipM[1]);
      continue;
    }
    const payM = line.match(/총결제요금\s*:\s*([\d,]+)/);
    if (payM) {
      cur.payTotal = num(payM[1]);
      continue;
    }
    if (/운송장|invno|tracking/.test(line)) {
      cur.status = '택배발송';
      continue;
    }

    const phoneM = line.match(/(01[016789])[-\s.]?(\d{3,4})[-\s.]?(\d{4})/);
    if (phoneM && !cur.phone) {
      cur.phone = `${phoneM[1]}-${phoneM[2]}-${phoneM[3]}`;
      const before = line.slice(0, phoneM.index).trim();
      if (before && !cur.buyer) cur.buyer = before;
      continue;
    }

    const addrM = line.match(/^\[([^\]]+)\]\s*(.+)/);
    if (addrM && !cur.address && !/영수증/.test(addrM[1])) {
      cur.address = addrM[2].trim();
      if (!cur.buyer) cur.buyer = addrM[1];
      continue;
    }

    if (/재고\s*[:：]|진행\s*[:：]/.test(line)) continue; // 상품 선택표 줄은 제외

    const parsed = parseLine(line);
    if (parsed && /\d\s*개/.test(line)) {
      cur.items.push(parsed);
      continue;
    }

    const totalM = line.match(/^([\d,]{4,})\s*원\s*$/);
    if (totalM) cur.total = num(totalM[1]);
  }
  pushCur();
  return entries.filter((e) => e.orderNo && e.items.length);
}

const SITE_STATUS_MAP = {
  주문완료: 'new', 입금대기: 'new', 입금완료: 'paid', 결제완료: 'paid', 상품준비중: 'paid',
  택배발송: 'shipped', 발송완료: 'shipped', 배송완료: 'shipped', 구매확정: 'shipped',
  주문취소: 'canceled', 취소: 'canceled',
};
const STATUS_RANK = { new: 0, paid: 1, ready: 2, shipped: 3 };

// 읽어온 사이트 주문을 등록/동기화합니다. (주문번호 기준 중복 방지)
function applySiteOrders(entries) {
  let changed = false;
  const unitPriceOf = (name) => {
    const key = String(name).replace(/\s+/g, '');
    const p = nongraCache.sales.products.find((x) => x.name.replace(/\s+/g, '') === key);
    return p ? p.price : 0;
  };

  for (const e of entries) {
    const key = `o${e.orderNo}`;
    const items = e.items.map((it) => ({
      productId: null,
      name: it.name,
      qty: it.qty,
      price: it.amount || unitPriceOf(it.name) * it.qty,
    }));
    // 배송비를 뺀 물품 금액: 총결제요금 - 택배요금 (없으면 표시된 총액 - 택배요금)
    const goodsTotal = Math.max(0, (e.payTotal || e.total || 0) - (e.shipping || 0));
    // 품목별 가격을 모르면 물품 합계를 첫 품목에 담아 총액을 보존합니다.
    if (items.length && items.every((i) => !i.price) && goodsTotal) items[0].price = goodsTotal;

    const siteStatus = SITE_STATUS_MAP[e.status] || 'new';
    const createdAt = (() => {
      const d = e.dateFull
        ? new Date(`${e.dateFull}T${e.time}:00`)
        : new Date(`20${e.date}T${e.time}:00`);
      return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    })();

    const existingId = db.nongra.processed[key];
    if (!existingId) {
      db.orderSeq += 1;
      const order = {
        id: nextId(),
        no: db.orderSeq,
        channel: 'nongra',
        buyer: e.buyer,
        phone: e.phone,
        address: e.address,
        memo: `농라F 주문 ${e.orderNo}`,
        items,
        status: siteStatus,
        createdAt,
        shippedAt: siteStatus === 'shipped' ? createdAt : null,
        printedAt: null,
      };
      db.orders.unshift(order);
      db.nongra.processed[key] = order.id;
      logHistory('order', `농라F 주문 ${e.orderNo} 자동 등록 → 주문 #${order.no} (${e.buyer})`);
      changed = true;
      continue;
    }

    const order = findOrder(existingId);
    if (!order) continue;

    const sig = (list) => JSON.stringify(list.map((i) => [i.name, i.qty]));
    let touched = false;
    if (sig(order.items) !== sig(items)) {
      order.items = items;
      touched = true;
    } else if (order.items.every((i) => !i.price) && items.some((i) => i.price)) {
      // 처음에 가격을 전혀 몰랐던 주문은 상품표를 알게 된 뒤 가격을 채워 넣습니다.
      order.items = items;
      touched = true;
    }
    if (siteStatus === 'canceled' && order.status !== 'canceled') {
      order.status = 'canceled';
      touched = true;
    } else if (order.status !== 'canceled'
      && (STATUS_RANK[siteStatus] ?? 0) > (STATUS_RANK[order.status] ?? 0)) {
      order.status = siteStatus; // 사이트에서 입금완료/발송완료로 바뀌면 따라갑니다.
      if (siteStatus === 'shipped') order.shippedAt = new Date().toISOString();
      touched = true;
    }
    if (touched) {
      logHistory('order', `농라F 주문 ${e.orderNo} 변경 감지 → 주문 #${order.no} 동기화`);
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

/**
 * farmer4989 전용 상품 파서.
 * 재고가 HTML 주석 속에 있고(<!-- 재고 : 16 개 -->) 가격은 바로 다음
 * <div class="fr won">8,000원</div>에, 상품명은 그 앞 텍스트에 있습니다.
 */
function parseNongraProducts(html) {
  const products = [];

  // 방식 1 (정확): 숨은 입력값에 상품명·번호·총수량이 들어 있습니다.
  // <input ... attr-cont='장미)원탑(sp)' ... data-idx1="1988817" data-idx2="16">
  const reInput = /attr-cont=['"]([^'"]+)['"][\s\S]{0,250}?data-idx1="(\d+)"[^>]*data-idx2="(\d+)"/g;
  let m;
  while ((m = reInput.exec(html))) {
    const name = m[1].trim();
    const optionId = m[2];
    const totalQty = Number(m[3]);
    if (!name || products.some((p) => p.name === name)) continue;
    // 가격은 수량 버튼의 quantity(-1, 번호, 가격) 호출에서 얻습니다.
    const priceM = html.match(new RegExp(`quantity\\(-?1,\\s*${optionId},\\s*(\\d+)`));
    products.push({
      name,
      price: priceM ? Number(priceM[1]) : 0,
      stock: totalQty,
      progress: 0,
      sold: 0,
      approx: true, // 실시간 조회 전까지는 대략치
      optionId,
      totalParam: totalQty, // 실시간 조회의 total 인자
    });
  }
  if (products.length >= 2) return products;

  // 방식 2 (예비): 주석 속 재고 + fr won 가격 + 직전 텍스트 상품명
  products.length = 0;
  const re = /재고\s*:\s*(\d+)\s*개[\s\S]{0,120}?class="fr won">([\d,]+)원</g;
  while ((m = re.exec(html))) {
    const stock = Number(m[1]);
    const price = num(m[2]);
    const before = html.slice(Math.max(0, m.index - 500), m.index);
    const texts = [...before.matchAll(/>([^<>\n]{2,40})</g)]
      .map((x) => x[1].trim())
      .filter((t) => t
        && !/^[\d,.\s원개%]+$/.test(t)
        && !/재고|용량|수량|원$|선택|합계|배송|주문|판매중|품절/.test(t)
        && !/^[-–—>]+$/.test(t));
    const name = texts.length ? texts[texts.length - 1] : '';
    if (!name || products.some((p) => p.name === name)) continue;
    const after = html.slice(m.index, m.index + 500);
    const idm = after.match(/quantity\(-?1,\s*(\d+)/);
    products.push({
      name, price, stock, progress: 0, sold: 0, approx: true,
      optionId: idm ? idm[1] : '',
      totalParam: stock,
    });
  }
  return products;
}

/**
 * 사이트가 화면에 [재고/진행/판매]를 그릴 때 쓰는 실시간 조회 주소를
 * 그대로 호출해 정확한 숫자로 바꿉니다. 응답 형식: "판매_재고_진행"
 */
async function enrichLiveCounts(widget, wrId) {
  const n = db.nongra;
  const cntUrl = `${n.base}/skin/board/basic/view_gonggoo.cnt.php`;
  for (const p of widget) {
    if (!p.optionId) continue;
    try {
      const res = await nongraFetch(
        `${cntUrl}?total=${p.totalParam || p.stock || 1}&idx=${p.optionId}&wr_id=${wrId}&bo_table=${encodeURIComponent(n.boTable)}`,
      );
      const parts = (await res.text()).trim().split('_').map((x) => parseInt(x, 10));
      if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
        p.sold = parts[0]; // 사용(판매)
        p.stock = parts[1]; // 재고
        p.progress = parts[2]; // 진행중
        p.approx = false;
      }
    } catch {
      /* 실패하면 주석 속 재고 값 유지 */
    }
  }
}

async function pollNongra(force = false) {
  const n = db.nongra;
  if (!n.base || !n.boTable || nongraCache.polling) return;
  nongraCache.polling = true;
  try {
    // 짧은 주소 상태로 남아 있으면 실제 경로부터 알아냅니다.
    if (n.short) await discoverGnuPath();

    // 로그인 정보가 있고 아직 세션이 없으면 로그인부터
    if (n.mbId && !nongraCache.loggedIn) await nongraLogin().catch(() => {});

    // 게시판 목록에서 최신 주문서 글 번호들을 가져옵니다.
    let listRes = await nongraFetch(nongraListUrl());
    if (listRes.status === 404 && n.short && await discoverGnuPath()) {
      if (n.mbId) await nongraLogin().catch(() => {});
      listRes = await nongraFetch(nongraListUrl()); // 경로 보정 후 재시도
    }
    const listHtml = await listRes.text();
    const wrIds = parseWrIds(listHtml, n.boTable);

    // 게시판에 새 판매글이 올라오면 자동으로 새 판매일을 시작합니다.
    // 판매일 날짜는 ① 목록의 글 제목("08월 03일") ② 글 내용 ③ 다음날 순으로 정합니다.
    const listMax = wrIds.length ? Math.max(...wrIds) : 0;
    if (listMax && n.lastTopWrId && listMax > n.lastTopWrId) {
      let label = '';
      // ① 목록에서 새 글의 제목을 찾아 날짜를 읽습니다. (추가 요청 없이)
      const titleLink = findLinks(listHtml).find((l) =>
        new RegExp(`(?:wr_id=|/${n.boTable}/)${listMax}(?:[^0-9]|$)`).test(l.href));
      if (titleLink) label = dateFromText(titleLink.text);
      // ② 없으면 글 내용에서 찾습니다.
      if (!label) {
        try {
          const { html: newPostHtml } = await nongraFetchPage(nongraPostUrl(listMax));
          label = dateFromText(stripTags(newPostHtml).slice(0, 3000));
        } catch {
          /* 못 읽으면 기본값(다음날) */
        }
      }
      addSalesDay(label, new Date().toISOString(),
        `새 판매글 #${listMax}${titleLink && titleLink.text ? ` "${titleLink.text.slice(0, 30)}"` : ''} 감지`);
    }
    if (listMax) {
      n.lastTopWrId = Math.max(n.lastTopWrId || 0, listMax);
    }

    // 설정할 때 붙여넣은 판매 페이지는 목록에 없어도 항상 맨 먼저 확인합니다.
    if (n.wrId) {
      const idx = wrIds.indexOf(n.wrId);
      if (idx >= 0) wrIds.splice(idx, 1);
      wrIds.unshift(n.wrId);
    }
    if (!wrIds.length) throw httpError(502, '게시판에서 글을 찾지 못했습니다. 주소를 확인해 주세요.');

    // 최신 글들을 매번 다시 읽습니다. (수정·품절·판매 수량 변화를 따라잡기 위해)
    const known = new Map(nongraCache.inbox.map((p) => [p.wrId, p]));
    const posts = [];
    for (const wrId of wrIds.slice(0, 10)) {
      try {
        const { res: pageRes, html } = await nongraFetchPage(nongraPostUrl(wrId));
        discoverOrderPage(html, pageRes.url || nongraPostUrl(wrId)); // 주문배송 메뉴 자동 발견

        // ① 상품 선택표가 있으면 = 판매 페이지 → 상품·재고·판매 수량 동기화
        //    (주문보다 먼저 읽어야 품목별 개당 가격을 매칭할 수 있습니다)
        let widget = parseSalesWidget(html);
        if (widget.length < 2) {
          // farmer4989처럼 재고가 주석 속에 있는 구조
          const staticWidget = parseNongraProducts(html);
          if (staticWidget.length >= 2) {
            widget = staticWidget;
            await enrichLiveCounts(widget, wrId); // 실시간 재고/진행/판매로 갱신
          }
        }
        if (widget.length >= 2) applySalesWidget(wrId, widget);

        // ② 페이지에 주문 목록이 있으면 주문을 등록/동기화합니다.
        const siteOrders = parseSiteOrders(html);
        if (siteOrders.length) applySiteOrders(siteOrders);

        if (widget.length >= 2 || siteOrders.length) continue; // 판매/주문 페이지는 주문서 글로 취급 안 함

        posts.push(parseOrderPost(html, wrId));
      } catch {
        const cached = known.get(wrId);
        if (cached) posts.push(cached); // 일시 오류면 이전 내용 유지
      }
    }

    // 주문서 후보만 남깁니다: 품목이 읽힌 글 + 아직 못 여는 비밀글
    // 판매자용 주문배송 페이지가 발견되어 있으면 거기서도 주문을 읽습니다.
    if (db.nongra.orderPageUrl) {
      try {
        const { html: orderHtml } = await nongraFetchPage(db.nongra.orderPageUrl);
        const adminOrders = parseSiteOrders(orderHtml);
        if (adminOrders.length) applySiteOrders(adminOrders);
      } catch {
        /* 주문배송 페이지 일시 오류는 다음 확인 때 재시도 */
      }
    }

    nongraCache.inbox = posts.filter((p) => p.items.length > 0 || p.secret);
    nongraCache.fetchedAt = new Date().toISOString();
    nongraCache.error = '';

    // 새 주문서는 자동 등록하고, 수정된 주문서는 주문에 반영합니다.
    autoSyncOrders();
  } catch (err) {
    nongraCache.error = err.message || '농라 사이트 조회 실패';
  } finally {
    nongraCache.polling = false;
  }
}

setInterval(() => pollNongra(false), NONGRA_POLL_MS);
setTimeout(() => pollNongra(true), 3000); // 서버 시작 3초 후 첫 확인

const postKeyOf = (p) => `w${p.wrId}`;

// 새 주문서는 등록하고, 이미 등록된 주문서가 수정되었으면 주문에 반영합니다.
function autoSyncOrders() {
  let created = 0;
  let updated = 0;

  for (const p of nongraCache.inbox) {
    const key = postKeyOf(p);
    if (p.secret) continue;

    const items = normalizeOrderItems(
      p.items.map((it) => ({ name: it.name, qty: it.qty, price: it.amount })),
    );
    if (!items.length) continue;

    const existingId = db.nongra.processed[key];
    if (!existingId) {
      // 처음 보는 주문서 → 자동 등록
      try {
        adjustStock(items, +1); // 재고 목록을 쓰는 경우에만 차감됩니다.
      } catch {
        // 재고가 부족해도 주문 접수는 막지 않습니다.
      }
      db.orderSeq += 1;
      const order = {
        id: nextId(),
        no: db.orderSeq,
        channel: 'nongra',
        buyer: p.buyer || p.author || '',
        phone: p.phone || '',
        address: p.address || '',
        memo: `농라F 주문서 #${p.wrId}${p.title && p.title !== `글 ${p.wrId}` ? ` · ${p.title}` : ''}`,
        items,
        status: 'new',
        createdAt: new Date().toISOString(),
        shippedAt: null,
        printedAt: null,
      };
      db.orders.unshift(order);
      db.nongra.processed[key] = order.id;
      logHistory('order', `농라F 주문서 #${p.wrId} 자동 등록 → 주문 #${order.no} (${order.buyer})`);
      created += 1;
      continue;
    }

    // 이미 등록된 주문서 → 내용이 바뀌었으면 동기화 (취소된 주문은 건드리지 않음)
    const order = findOrder(existingId);
    if (!order || order.status === 'canceled') continue;

    const sigOf = (list) => JSON.stringify(list.map((i) => [i.name, i.qty, i.price]));
    const buyer = p.buyer || p.author || order.buyer;
    const changed = sigOf(order.items) !== sigOf(items)
      || buyer !== order.buyer
      || (p.phone && p.phone !== order.phone)
      || (p.address && p.address !== order.address);
    if (!changed) continue;

    order.items = items;
    order.buyer = buyer;
    if (p.phone) order.phone = p.phone;
    if (p.address) order.address = p.address;
    logHistory('order', `농라F 주문서 #${p.wrId} 수정 감지 → 주문 #${order.no} 수량 동기화`);
    updated += 1;
  }

  if (created || updated) save(); // 폴링은 요청 밖에서 일어나므로 직접 저장합니다.
  return { created, updated };
}

function nongraUnprocessedCount() {
  return nongraCache.inbox.filter((p) => !db.nongra.processed[postKeyOf(p)]).length;
}

function nongraInboxWithFlags() {
  return nongraCache.inbox.map((p) => ({
    ...p,
    postKey: postKeyOf(p),
    processed: Boolean(db.nongra.processed[postKeyOf(p)]),
  }));
}

/* ------------------------------------------- 스마트스토어(커머스 API) */

// bcryptjs는 시작하기.bat이 자동으로 설치합니다. 없으면 스토어 연동만 꺼집니다.
let bcrypt = null;
try {
  bcrypt = require('bcryptjs');
} catch {
  /* npm install 전 */
}

const COMMERCE_BASE = 'https://api.commerce.naver.com';
const STORE_POLL_MS = 5 * 60 * 1000; // 5분마다 자동 확인

const storeCache = {
  token: '',
  tokenExpiresAt: 0,
  fetchedAt: null,
  error: '',
  polling: false,
};

function storePublic() {
  return {
    configured: Boolean(db.store.clientId && db.store.clientSecret),
    ready: Boolean(bcrypt),
    fetchedAt: storeCache.fetchedAt,
    error: storeCache.error,
  };
}

// 커머스 API 인증 토큰 발급 (전자서명 = bcrypt(clientId_timestamp, secret))
async function storeToken() {
  if (!bcrypt) {
    throw httpError(500, '스토어 연동 부품(bcryptjs)이 없습니다. 시작하기.bat을 다시 실행해 주세요.');
  }
  if (storeCache.token && Date.now() < storeCache.tokenExpiresAt - 60000) {
    return storeCache.token;
  }
  const timestamp = Date.now();
  const sign = Buffer.from(
    bcrypt.hashSync(`${db.store.clientId}_${timestamp}`, db.store.clientSecret),
  ).toString('base64');

  const body = new URLSearchParams({
    client_id: db.store.clientId,
    timestamp: String(timestamp),
    grant_type: 'client_credentials',
    client_secret_sign: sign,
    type: 'SELF',
  });

  let res;
  try {
    res = await fetch(`${COMMERCE_BASE}/external/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw httpError(502, '네이버 커머스 API에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const msg = data.message || data.code || res.status;
    if (String(msg).includes('IP') || res.status === 403) {
      throw httpError(403, `커머스 API 거부: ${msg} — 커머스API센터의 "API호출 IP"에 이 컴퓨터의 공인 IP를 등록했는지 확인하세요.`);
    }
    throw httpError(401, `커머스 API 인증 실패: ${msg} — 애플리케이션 ID/시크릿을 다시 확인해 주세요.`);
  }
  storeCache.token = data.access_token;
  storeCache.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 10800) * 1000;
  return storeCache.token;
}

async function commerceApi(method, apiPath, payload) {
  const token = await storeToken();
  let res;
  try {
    res = await fetch(COMMERCE_BASE + apiPath, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw httpError(502, '네이버 커머스 API에 연결하지 못했습니다.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(502, `커머스 API 오류: ${data.message || data.code || res.status}`);
  }
  return data;
}

// 결제된 주문을 가져와 주문 목록에 자동 등록합니다.
async function pollStore(force = false) {
  if (!db.store.clientId || !db.store.clientSecret || !bcrypt || storeCache.polling) return;
  storeCache.polling = true;
  try {
    // 최근 확인 시점부터(최대 24시간 전) 결제 완료된 주문 변경 내역 조회
    const from = new Date(Math.max(
      db.store.lastSync ? new Date(db.store.lastSync).getTime() - 10 * 60 * 1000 : 0,
      Date.now() - 24 * 60 * 60 * 1000,
    )).toISOString();

    const changed = await commerceApi(
      'GET',
      `/external/v1/pay-order/seller/product-orders/last-changed-statuses?lastChangedFrom=${encodeURIComponent(from)}&lastChangedType=PAYED`,
    );
    const list = (changed.data && (changed.data.lastChangeStatuses || changed.data)) || [];
    const newIds = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const id = entry.productOrderId || entry.productOrderNo;
      if (id && !db.store.processed[id]) newIds.push(String(id));
    }

    if (newIds.length) {
      // 상세 조회 (한 번에 최대 100건)
      const detail = await commerceApi('POST', '/external/v1/pay-order/seller/product-orders/query', {
        productOrderIds: newIds.slice(0, 100),
      });
      const rows = (detail.data && (Array.isArray(detail.data) ? detail.data : detail.data.productOrders)) || [];

      let created = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const po = row.productOrder || row;
        const ord = row.order || {};
        const id = String(po.productOrderId || '');
        if (!id || db.store.processed[id]) continue;

        const qty = Math.max(1, Number(po.quantity) || 1);
        const optionText = po.productOption ? ` (${po.productOption})` : '';
        // 배송비를 뺀 상품 금액만 기록합니다.
        const amount = Number(po.totalPaymentAmount || po.totalProductAmount || 0)
          - Number(po.deliveryFeeAmount || 0);
        const addr = po.shippingAddress || {};

        db.orderSeq += 1;
        const order = {
          id: nextId(),
          no: db.orderSeq,
          channel: 'store',
          buyer: addr.name || ord.ordererName || '',
          phone: addr.tel1 || ord.ordererTel || '',
          address: [addr.baseAddress, addr.detailedAddress].filter(Boolean).join(' '),
          memo: `스토어 주문 ${po.productOrderId}`,
          items: [{
            productId: null,
            name: String(po.productName || '스토어 상품') + optionText,
            qty,
            price: Math.max(0, amount),
          }],
          status: 'paid',
          createdAt: new Date().toISOString(),
          shippedAt: null,
          printedAt: null,
        };
        db.orders.unshift(order);
        db.store.processed[id] = order.id;
        logHistory('order', `스토어 주문 자동 등록 → 주문 #${order.no} (${order.buyer})`);
        created += 1;
      }
      if (created) save();
    }

    db.store.lastSync = new Date().toISOString();
    storeCache.fetchedAt = db.store.lastSync;
    storeCache.error = '';
    save();
  } catch (err) {
    storeCache.error = err.message || '스토어 조회 실패';
  } finally {
    storeCache.polling = false;
  }
}

setInterval(() => pollStore(false), STORE_POLL_MS);
setTimeout(() => pollStore(true), 5000); // 서버 시작 5초 후 첫 확인

routes['POST /api/store/settings'] = async (body) => {
  if (body.clientId !== undefined) db.store.clientId = String(body.clientId).trim();
  if (body.clientSecret !== undefined) db.store.clientSecret = String(body.clientSecret).trim();
  storeCache.token = '';
  storeCache.error = '';
  if (db.store.clientId && db.store.clientSecret) {
    await pollStore(true);
    if (storeCache.error) throw httpError(502, `저장은 했지만 확인 실패: ${storeCache.error}`);
  }
  return { store: storePublic() };
};

routes['POST /api/store/refresh'] = async () => {
  if (!db.store.clientId) throw httpError(400, '스토어 애플리케이션 ID/시크릿을 먼저 저장해 주세요.');
  await pollStore(true);
  if (storeCache.error) throw httpError(502, storeCache.error);
  return { store: storePublic() };
};

/* ---------------------------------------------------------------- 서버 */

const MUTATING = /^(POST|PATCH|DELETE)/;

function matchRoute(method, pathname) {
  for (const key of Object.keys(routes)) {
    const [routeMethod, routePath] = key.split(' ');
    if (routeMethod !== method) continue;
    const routeParts = routePath.split('/');
    const pathParts = pathname.split('/');
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    const ok = routeParts.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(pathParts[i]);
        return pathParts[i] !== '';
      }
      return part === pathParts[i];
    });
    if (ok) return { handler: routes[key], params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(httpError(413, '내용이 너무 큽니다.'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, '잘못된 요청입니다.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 403, { error: '접근할 수 없습니다.' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('찾을 수 없습니다.');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 새 버전이 실행되면 이 주소로 종료를 요청해 자리를 넘겨받습니다. (내 컴퓨터에서만 허용)
  if (pathname === '/api/shutdown' && req.method === 'POST') {
    const remote = String(req.socket.remoteAddress || '');
    if (!/^(::1|::ffff:127\.|127\.)/.test(remote)) {
      return sendJson(res, 403, { error: '이 컴퓨터에서만 가능합니다.' });
    }
    sendJson(res, 200, { ok: true, version: APP_VERSION });
    console.log('\n  새 버전이 실행되어 이 창은 종료됩니다. 이 창은 닫으셔도 됩니다.\n');
    setTimeout(() => process.exit(0), 300);
    return undefined;
  }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const route = matchRoute(req.method, pathname);
  if (!route) return sendJson(res, 404, { error: '없는 주소입니다.' });

  try {
    const body = MUTATING.test(req.method) ? await readBody(req) : {};
    const result = (await route.handler(body, route.params)) || {};
    if (MUTATING.test(req.method)) save();
    sendJson(res, 200, { ...result, updatedAt: db.updatedAt });
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message || '서버 오류' });
  }
});

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

let takeoverTries = 0;

server.on('listening', () => {
  console.log(`\n  꽃 작업장 주문 관리 ${APP_VERSION} 실행 중\n`);
  console.log(`  이 컴퓨터        : http://localhost:${PORT}`);
  for (const ip of localAddresses()) {
    console.log(`  휴대폰/다른 PC   : http://${ip}:${PORT}   (같은 와이파이)`);
  }
  console.log('\n  종료하려면 Ctrl + C\n');
});

// 예전 버전이 켜져 있으면 종료를 요청하고 자리를 넘겨받습니다.
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE' && takeoverTries < 3) {
    takeoverTries += 1;
    console.log('  이전 버전이 실행 중입니다. 종료를 요청합니다...');
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* 아주 예전 버전은 종료 요청을 모릅니다 */
    }
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 1500);
  } else if (err.code === 'EADDRINUSE') {
    console.log('\n  이미 실행 중인 프로그램이 있습니다.');
    console.log('  검은 창을 전부 닫은 뒤 시작하기.bat을 다시 실행해 주세요.\n');
  } else {
    console.error('  실행 오류:', err.message);
  }
});

server.listen(PORT, '0.0.0.0');
