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

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

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
  // 농라(밴드) 연동 설정: developers.band.us 에서 발급받은 액세스 토큰
  band: { accessToken: '', bandKey: '', bandName: '', processed: {} },
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
      band: { ...base.band, ...(raw.band || {}) },
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

/* ---------------------------------------------------------------- 라우팅 */

const routes = {
  'GET /api/state': () => ({
    products: db.products,
    orders: db.orders,
    history: db.history,
    band: bandPublic(), // 토큰 자체는 내보내지 않습니다.
    updatedAt: db.updatedAt,
  }),

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
      db.band.processed[String(body.commentKey)] = order.id;
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

  /* ---------- 농라(밴드) 연동 ---------- */

  'POST /api/band/settings': (body) => {
    if (body.accessToken !== undefined) db.band.accessToken = String(body.accessToken).trim();
    if (body.bandKey !== undefined) db.band.bandKey = String(body.bandKey).trim();
    if (body.bandName !== undefined) db.band.bandName = String(body.bandName).trim();
    return { band: bandPublic() };
  },

  // 토큰으로 가입된 밴드 목록 조회
  'GET /api/band/bands': async () => {
    const data = await bandGet('/v2.1/bands');
    const bands = (data.bands || []).map((b) => ({ name: b.name, bandKey: b.band_key }));
    return { bands };
  },

  // 선택한 밴드의 최근 글 + 댓글을 가져와 주문 후보로 보여줍니다.
  'GET /api/band/inbox': async () => {
    if (!db.band.bandKey) throw httpError(400, '연동할 밴드를 먼저 선택해 주세요.');
    const data = await bandGet('/v2/band/posts', { band_key: db.band.bandKey, locale: 'ko_KR' });
    const posts = (data.items || []).slice(0, 10);
    const inbox = [];

    for (const post of posts) {
      const entry = {
        postKey: post.post_key,
        author: post.author ? post.author.name : '',
        snippet: String(post.content || '').slice(0, 120),
        createdAt: post.created_at || null,
        commentCount: post.comment_count || 0,
        comments: [],
      };
      if (post.comment_count > 0) {
        try {
          const cd = await bandGet('/v2/band/post/comments', {
            band_key: db.band.bandKey,
            post_key: post.post_key,
          });
          entry.comments = (cd.items || []).map((c) => ({
            commentKey: String(c.comment_key),
            author: c.author ? c.author.name : '',
            content: String(c.content || ''),
            createdAt: c.created_at || null,
            processed: Boolean(db.band.processed[String(c.comment_key)]),
          }));
        } catch {
          // 댓글 조회가 막힌 글은 글만 보여줍니다.
        }
      }
      inbox.push(entry);
    }
    return { inbox, bandName: db.band.bandName };
  },

  // 댓글을 주문으로 만들지 않고 처리됨으로만 표시
  'POST /api/band/skip': (body) => {
    const key = String(body.commentKey || '').trim();
    if (!key) throw httpError(400, '댓글 정보가 없습니다.');
    db.band.processed[key] = db.band.processed[key] || 'skipped';
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
    const band = { ...db.band, processed: {} }; // 연동 설정은 남겨둡니다.
    db = emptyDb();
    db.band = band;
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

/* ---------------------------------------------------------------- 밴드 API */

// 토큰은 화면에 다시 보내지 않고, 설정 여부만 알려줍니다.
function bandPublic() {
  return {
    hasToken: Boolean(db.band.accessToken),
    bandKey: db.band.bandKey,
    bandName: db.band.bandName,
  };
}

async function bandGet(apiPath, params) {
  if (!db.band.accessToken) {
    throw httpError(400, '농라(밴드) 액세스 토큰을 먼저 저장해 주세요. (연동 설정 참고)');
  }
  const url = new URL('https://openapi.band.us' + apiPath);
  url.searchParams.set('access_token', db.band.accessToken);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw httpError(502, '밴드 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (data.result_code !== 1) {
    const detail = (data.result_data && data.result_data.message) || `코드 ${data.result_code ?? res.status}`;
    if (String(detail).includes('Invalid') || res.status === 401) {
      throw httpError(401, '밴드 토큰이 올바르지 않거나 만료되었습니다. 연동 설정에서 다시 발급받아 주세요.');
    }
    throw httpError(502, `밴드 응답 오류: ${detail}`);
  }
  return data.result_data || {};
}

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

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  꽃 작업장 주문/판매 관리 실행 중\n');
  console.log(`  이 컴퓨터        : http://localhost:${PORT}`);
  for (const ip of localAddresses()) {
    console.log(`  휴대폰/다른 PC   : http://${ip}:${PORT}   (같은 와이파이)`);
  }
  console.log('\n  종료하려면 Ctrl + C\n');
});
