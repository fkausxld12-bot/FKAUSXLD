'use strict';

/**
 * 롯데택배 파트너(ALPS) 송장 도우미
 *
 * 사장님이 직접 로그인한 브라우저 창을 프로그램이 이어받아 "수하인·주문 칸만" 채웁니다.
 *
 * 안전 규칙 (지시서 그대로)
 *  1. 비밀번호는 절대 대신 입력하지 않습니다. 로그인은 사장님이 그 창에서 직접.
 *  2. 송하인·거래처·운임구분·집하점은 손대지 않습니다. 송하인이 비어 있으면 중단.
 *  3. 기본은 채우기만 하고 저장하지 않습니다. 저장은 명시적으로 지시할 때만.
 *  4. 같은 주문은 두 번 등록하지 않습니다. (이중 발행 방지)
 *
 * 브라우저는 Node 내장 기능(WebSocket + Chrome DevTools 프로토콜)으로 조종하므로
 * 추가 설치가 필요 없습니다.
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ALPS_LOGIN_URL = 'https://partner.alps.llogis.com/main/pages/sec/authentication';
const DEBUG_PORT = Number(process.env.ALPS_PORT) || 9222;
const PROFILE_DIR = path.join(os.homedir(), '.flower-workshop', 'chrome-profile');

// 채워도 되는 칸 (지시서의 표 그대로). 이 목록 밖의 칸은 절대 건드리지 않습니다.
const FILL_FIELDS = {
  edtAcperNm: '수하인명',
  edtAcperTel: '전화',
  edtAcperCpno: '휴대폰',
  edtAcperPadr: '주소',
  edtAcperEtcAdr: '상세주소',
  edtOrdNo: '주문번호',
  edtOrdrNm: '주문자명',
  maeQty: '수량',
  edtGdsNm: '상품명',
  edtDlvMsgCont: '배송메시지',
};

// 송하인으로 보이는 칸 (읽기만 합니다)
const SHIPPER_HINTS = ['edtSndrNm', 'edtSndNm', 'edtSenderNm', 'edtSndperNm'];

/* ------------------------------------------------------- 브라우저 찾기/띄우기 */

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 다음 후보 */
    }
  }
  return '';
}

function httpJson(pathName) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${DEBUG_PORT}${pathName}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('브라우저 응답 없음')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browserProc = null;

async function browserAlive() {
  try {
    await httpJson('/json/version');
    return true;
  } catch {
    return false;
  }
}

/** 브라우저를 띄우고 ALPS 로그인 페이지를 엽니다. (로그인은 사장님이 직접) */
async function launch() {
  if (await browserAlive()) {
    await openAlpsTab();
    return { started: false, message: '이미 열려 있는 브라우저를 사용합니다.' };
  }

  const exe = findBrowser();
  if (!exe) {
    throw new Error('크롬(또는 엣지)을 찾지 못했습니다. 크롬을 설치한 뒤 다시 시도해 주세요.');
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    ALPS_LOGIN_URL,
  ];
  if (process.env.ALPS_HEADLESS === '1') args.unshift('--headless=new');
  if (process.env.ALPS_NO_SANDBOX === '1') args.unshift('--no-sandbox'); // 테스트 환경용

  browserProc = spawn(exe, args, { detached: true, stdio: 'ignore' });
  browserProc.unref();

  for (let i = 0; i < 30; i += 1) {
    await sleep(400);
    if (await browserAlive()) return { started: true, message: '브라우저를 열었습니다. 그 창에서 로그인해 주세요.' };
  }
  throw new Error('브라우저는 실행됐지만 연결하지 못했습니다. 창을 닫고 다시 시도해 주세요.');
}

async function openAlpsTab() {
  const tabs = await httpJson('/json/list').catch(() => []);
  if (tabs.some((t) => (t.url || '').includes('alps.llogis.com'))) return;
  await httpJson(`/json/new?${encodeURIComponent(ALPS_LOGIN_URL)}`).catch(() => {});
}

/* ------------------------------------------------------- CDP 통신 */

let ws = null;
let msgId = 0;
const pending = new Map();

async function connect() {
  if (ws && ws.readyState === 1) return ws;
  if (typeof WebSocket !== 'function') {
    throw new Error('이 Node 버전은 브라우저 조종을 지원하지 않습니다. Node를 최신 LTS로 업데이트해 주세요.');
  }
  const info = await httpJson('/json/version');
  const sock = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.onopen = resolve;
    sock.onerror = () => reject(new Error('브라우저에 연결하지 못했습니다.'));
  });
  sock.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  sock.onclose = () => { ws = null; };
  ws = sock;
  return ws;
}

async function send(method, params = {}, sessionId) {
  const sock = await connect();
  const id = (msgId += 1);
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify(payload));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 응답이 없습니다.`));
      }
    }, 20000);
  });
}

async function evaluate(expression, form) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (form && form.executionContextId) params.contextId = form.executionContextId;
  const res = await send('Runtime.evaluate', params, form && form.sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || '브라우저에서 오류가 났습니다.');
  }
  return res.result ? res.result.value : undefined;
}

function flattenFrames(node, out = []) {
  out.push(node.frame);
  for (const child of node.childFrames || []) flattenFrames(child, out);
  return out;
}

/** 송장 입력 폼(교차출처 iframe 포함)을 찾습니다. */
async function findForm() {
  const { targetInfos } = await send('Target.getTargets');
  const candidates = targetInfos.filter(
    (t) => ['page', 'iframe'].includes(t.type) && /alps\.llogis\.com/.test(t.url || ''),
  );

  for (const target of candidates) {
    let sessionId;
    try {
      ({ sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    } catch {
      continue;
    }

    // ① 이 대상(교차출처 iframe 포함) 자체에 폼이 있는지
    try {
      const has = await evaluate("!!document.getElementById('edtAcperNm')", { sessionId });
      if (has === true) return { sessionId, url: target.url, mainWorld: true };
    } catch {
      /* 다음 방법 */
    }

    // ② 같은 프로세스 안의 하위 프레임들을 하나씩 확인
    try {
      await send('Page.enable', {}, sessionId);
      const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
      for (const frame of flattenFrames(frameTree)) {
        try {
          const { executionContextId } = await send(
            'Page.createIsolatedWorld',
            { frameId: frame.id, worldName: 'flower-workshop' },
            sessionId,
          );
          const has = await evaluate("!!document.getElementById('edtAcperNm')", { sessionId, executionContextId });
          if (has === true) return { sessionId, executionContextId, url: frame.url, mainWorld: false };
        } catch {
          /* 다음 프레임 */
        }
      }
    } catch {
      /* 다음 대상 */
    }
  }
  return null;
}

/* ------------------------------------------------------- 폼 읽기/채우기 */

// 브라우저 안에서 실행할 코드: 값 넣기 (프레임워크가 알아채도록 이벤트까지 발생)
const SET_VALUE_FN = `
function __setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}`;

/** 폼 상태: 로그인 여부, 송하인 값, 채울 칸 존재 여부 */
async function status() {
  const alive = await browserAlive();
  if (!alive) {
    return { browser: false, form: false, message: '브라우저가 꺼져 있습니다. [송장 창 열기]를 눌러 주세요.' };
  }
  const form = await findForm();
  if (!form) {
    return {
      browser: true,
      form: false,
      message: '송장 입력 화면을 찾지 못했습니다. 브라우저에서 로그인하고 "건별주문접수" 화면을 열어 주세요.',
    };
  }
  const info = await evaluate(
    `(() => {
      const shipperIds = ${JSON.stringify(SHIPPER_HINTS)};
      let shipper = null, shipperId = '';
      for (const id of shipperIds) {
        const el = document.getElementById(id);
        if (el) { shipper = (el.value || '').trim(); shipperId = id; break; }
      }
      if (shipper === null) {
        // 라벨에 "송하인"이 있는 입력칸을 찾아봅니다.
        const labels = [...document.querySelectorAll('label, th, td, div, span')]
          .filter((n) => /송하인|보내는/.test(n.textContent || ''));
        for (const lab of labels) {
          const inp = lab.querySelector('input') ||
            (lab.parentElement && lab.parentElement.querySelector('input'));
          if (inp) { shipper = (inp.value || '').trim(); shipperId = inp.id || '(이름없음)'; break; }
        }
      }
      const fields = {};
      for (const id of ${JSON.stringify(Object.keys(FILL_FIELDS))}) {
        const el = document.getElementById(id);
        fields[id] = el ? (el.value || '') : null;
      }
      return { shipper, shipperId, fields, title: document.title };
    })()`,
    form,
  );

  return {
    browser: true,
    form: true,
    url: form.url,
    shipper: info.shipper,
    shipperId: info.shipperId,
    fields: info.fields,
    message: '송장 입력 화면 연결됨',
  };
}

/**
 * 주문 하나를 폼에 채웁니다. (저장하지 않습니다)
 * 지시서: 수하인·주문 칸만 채우고 송하인/거래처/집하점은 손대지 않습니다.
 */
async function fillOrder(order, { orderNo } = {}) {
  const st = await status();
  if (!st.browser) throw new Error(st.message);
  if (!st.form) throw new Error(st.message);
  const form = await findForm();
  if (!form) throw new Error('송장 입력 화면을 찾지 못했습니다.');

  const warnings = [];
  if (st.shipper === null || st.shipper === undefined) {
    warnings.push('송하인 칸을 확인하지 못했습니다. 저장 전에 화면에서 직접 확인해 주세요.');
  } else if (!st.shipper) {
    throw new Error('송하인 칸이 비어 있습니다. 지시서에 따라 중단합니다. 화면에서 송하인을 확인해 주세요.');
  }

  const qty = order.items.reduce((s, it) => s + it.qty, 0);
  const goods = order.items.map((it) => `${it.name} ${it.qty}개`).join(', ');
  const phone = String(order.phone || '').trim();
  const isMobile = /^01[016789]/.test(phone.replace(/[^\d]/g, ''));

  // 주소를 도로명/상세로 나눕니다. (괄호·동호수 앞에서 자름)
  const addr = String(order.address || '').trim();
  const cut = addr.search(/\s(?:\(|[0-9]+동|[0-9]+호|[가-힣]*아파트\s|B?\d+층)/);
  const baseAddr = cut > 0 ? addr.slice(0, cut).trim() : addr;
  const detailAddr = cut > 0 ? addr.slice(cut).trim() : '';

  const values = {
    edtAcperNm: order.buyer || '',
    edtAcperCpno: isMobile ? phone : '',
    edtAcperTel: isMobile ? '' : phone,
    edtAcperPadr: baseAddr,
    edtAcperEtcAdr: detailAddr,
    edtOrdNo: String(orderNo || order.no || ''),
    edtOrdrNm: order.buyer || '',
    maeQty: String(Math.max(1, qty)),
    edtGdsNm: goods.slice(0, 40) || '생화',
    edtDlvMsgCont: '파손주의 생화입니다',
  };

  const result = await evaluate(
    `(() => {
      ${SET_VALUE_FN}
      const values = ${JSON.stringify(values)};
      const done = {}, missing = [];
      for (const [id, v] of Object.entries(values)) {
        if (v === '') continue;
        if (__setFieldValue(id, v)) done[id] = v; else missing.push(id);
      }
      return { done, missing };
    })()`,
    form,
  );

  if (result.missing && result.missing.length) {
    warnings.push(`화면에 없는 칸: ${result.missing.join(', ')}`);
  }
  if (!detailAddr) warnings.push('상세주소를 나누지 못했습니다. 화면에서 확인해 주세요.');
  warnings.push('우편번호는 화면의 [주소검색] 버튼으로 확인해 주세요.');

  return { filled: result.done, warnings, shipper: st.shipper };
}

/** 폼을 저장합니다. (명시적으로 지시할 때만) */
async function saveForm() {
  const form = await findForm();
  if (!form) throw new Error('송장 입력 화면을 찾지 못했습니다.');

  const before = await evaluate("(document.getElementById('edtAcperNm')||{}).value || ''", form);

  const clicked = await evaluate(
    `(() => {
      // 저장 버튼을 찾아 사람이 누르듯 클릭합니다.
      const nodes = [...document.querySelectorAll('button, a, input[type=button], input[type=submit]')];
      const btn = nodes.find((n) => {
        const t = (n.textContent || n.value || '') + ' ' + (n.getAttribute('onclick') || '') + ' ' + (n.id || '');
        return /fnSave|저장|등록/.test(t);
      });
      if (btn) { btn.click(); return 'click:' + (btn.id || btn.textContent || '').trim().slice(0, 20); }
      if (typeof fnSave === 'function') { fnSave(); return 'fnSave()'; }
      return '';
    })()`,
    form,
  );
  if (!clicked) throw new Error('저장 버튼을 찾지 못했습니다. 화면에서 직접 저장해 주세요.');

  await sleep(2500);

  // 성공 판정은 화면 메시지가 아니라 다시 읽어서 확인합니다.
  const after = await evaluate("(document.getElementById('edtAcperNm')||{}).value || ''", form).catch(() => '');
  const verified = Boolean(before) && after !== before;

  return { clicked, verified, before, after };
}

module.exports = { launch, status, fillOrder, saveForm, ALPS_LOGIN_URL };
