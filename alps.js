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
const SITE_RE = new RegExp(process.env.ALPS_SITE_RE || 'alps\\.llogis\\.com');

/**
 * 화면에서 칸을 찾는 방법.
 * ① 지시서에 적힌 id가 있으면 그대로 사용
 * ② 없으면 화면의 "구역(수하인/기타화물정보)"과 "라벨(고객성명·전화번호…)" 글자로 찾습니다.
 *    → ALPS 화면이 바뀌어도 따라갑니다.
 */
const FIELD_PLAN = {
  name: { id: 'edtAcperNm', section: '수하인', labels: ['고객성명', '수하인명', '성명'] },
  tel: { id: 'edtAcperTel', section: '수하인', labels: ['전화번호', '전화'] },
  mobile: { id: 'edtAcperCpno', section: '수하인', labels: ['휴대폰', '핸드폰'] },
  address: { id: 'edtAcperPadr', section: '수하인', labels: ['주소'] },
  addressDetail: { id: 'edtAcperEtcAdr', section: '수하인', labels: ['상세주소', '나머지주소'] },
  ordNo: { id: 'edtOrdNo', section: '수하인', labels: ['주문번호'] },
  ordrNm: { id: 'edtOrdrNm', section: '수하인', labels: ['주문자명', '주문자'] },
  qty: { id: 'maeQty', section: '기타화물정보', labels: ['내품수량', '수량'] },
  goods: { id: 'edtGdsNm', section: '기타화물정보', labels: ['상품명'] },
  message: { id: 'edtDlvMsgCont', section: '기타화물정보', labels: ['배달메세지', '배달메시지', '배송메시지'] },
};

// 절대 건드리면 안 되는 구역 (읽기만 합니다)
const PROTECTED_SECTIONS = ['송하인', '운임정보', '운임상세', '집하'];

// 이 페이지가 송장 입력 화면인지 판정하는 코드
const FORM_TEST = `(() => {
  if (document.getElementById('edtAcperNm')) return true;
  const text = document.body ? document.body.innerText || '' : '';
  if (!/수하인/.test(text)) return false;
  return document.querySelectorAll('input:not([type=hidden])').length >= 5;
})()`;

// 화면 안에서 실행할 공통 코드: 구역·라벨을 따라 칸을 찾습니다.
const SCAN_FN = `
function __scanFields() {
  const SECTIONS = ['송하인','수하인','기타화물정보','운임정보','운임상세','참고운송장번호'];
  const out = [];
  let section = '', lastLabel = '';
  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (el.type === 'hidden') continue;
      out.push({ el, id: el.id || '', name: el.name || '', section, label: lastLabel,
                 value: el.value || '', readOnly: !!el.readOnly, disabled: !!el.disabled, type: el.type || tag });
      continue;
    }
    if (el.children.length === 0) {
      const t = (el.textContent || '').replace(/\\s+/g, '').trim();
      if (!t || t.length > 10) continue;
      if (SECTIONS.includes(t)) { section = t; lastLabel = ''; }
      else lastLabel = t;
    }
  }
  return out;
}
function __findField(plan) {
  if (plan.id) {
    const byId = document.getElementById(plan.id);
    if (byId) return byId;
  }
  const fields = __scanFields();
  for (const label of plan.labels) {
    const hit = fields.find((f) =>
      f.section === plan.section && f.label === label && !f.readOnly && !f.disabled);
    if (hit) return hit.el;
  }
  // 라벨이 정확히 안 맞으면 포함 관계로 한 번 더
  for (const label of plan.labels) {
    const hit = fields.find((f) =>
      f.section === plan.section && f.label.includes(label) && !f.readOnly && !f.disabled);
    if (hit) return hit.el;
  }
  return null;
}`;

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
    const r = await openAlpsTab();
    return {
      started: false,
      message: r.created
        ? '송장 창을 새로 열었습니다. 그 창에서 로그인해 주세요.'
        : '이미 열려 있는 송장 창을 앞으로 가져왔습니다.',
    };
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
    if (await browserAlive()) {
      await sleep(600);
      await openAlpsTab().catch(() => {});
      return {
        started: true,
        message: '송장 창을 열었습니다. 반드시 이 새 창에서 로그인해 주세요. (평소 쓰시는 크롬 창은 프로그램이 볼 수 없습니다)',
      };
    }
  }
  throw new Error('브라우저는 실행됐지만 연결하지 못했습니다. 창을 닫고 다시 시도해 주세요.');
}

/** ALPS 탭을 찾아 앞으로 가져오고, 없으면 새로 엽니다. */
async function openAlpsTab() {
  const { targetInfos } = await send('Target.getTargets');
  const existing = targetInfos.find(
    (t) => t.type === 'page' && SITE_RE.test(t.url || ''),
  );
  if (existing) {
    await send('Target.activateTarget', { targetId: existing.targetId }).catch(() => {});
    return { created: false };
  }
  const { targetId } = await send('Target.createTarget', { url: ALPS_LOGIN_URL });
  await send('Target.activateTarget', { targetId }).catch(() => {});
  return { created: true };
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
    (t) => ['page', 'iframe'].includes(t.type) && SITE_RE.test(t.url || ''),
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
      const has = await evaluate(FORM_TEST, { sessionId });
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
          const has = await evaluate(FORM_TEST, { sessionId, executionContextId });
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
function __setElValue(el, value) {
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

/** 화면 진단: 어떤 칸들이 보이는지 그대로 알려줍니다. */
async function scanScreen() {
  const form = await findForm();
  if (!form) return null;
  return evaluate(`(() => {
    ${SCAN_FN}
    return __scanFields().map((f) => ({
      구역: f.section, 라벨: f.label, id: f.id, 값: String(f.value).slice(0, 20),
      읽기전용: f.readOnly,
    })).slice(0, 60);
  })()`, form);
}

/** 브라우저·로그인·폼 상태를 구분해서 알려줍니다. */
async function status() {
  if (!(await browserAlive())) {
    return {
      browser: false,
      form: false,
      message: '송장 창이 꺼져 있습니다. [송장 창 열기]를 눌러 주세요. (평소 쓰는 크롬 창은 프로그램이 볼 수 없습니다)',
    };
  }

  const form = await findForm();
  if (!form) {
    // ALPS 탭은 있는지, 로그인 화면인지 구분해 줍니다.
    let hint = '송장 창에서 [건별주문접수] 화면을 열어 주세요.';
    try {
      const { targetInfos } = await send('Target.getTargets');
      const tabs = targetInfos.filter((t) => t.type === 'page' && SITE_RE.test(t.url || ''));
      if (!tabs.length) {
        hint = '송장 창에 롯데 파트너 페이지가 없습니다. [송장 창 열기]를 다시 눌러 주세요.';
      } else {
        const { sessionId } = await send('Target.attachToTarget', { targetId: tabs[0].targetId, flatten: true });
        const text = await evaluate('(document.body && document.body.innerText || "").slice(0, 400)', { sessionId });
        if (/로그인|인증|아이디|비밀번호/.test(text) && !/건별주문접수|수하인/.test(text)) {
          hint = '아직 로그인 전입니다. 열린 송장 창에서 로그인해 주세요.';
        }
      }
    } catch {
      /* 판단 못 하면 기본 안내 */
    }
    return { browser: true, form: false, message: hint };
  }

  const info = await evaluate(`(() => {
    ${SCAN_FN}
    const fields = __scanFields();
    // 송하인 구역의 이름 칸 (읽기만)
    const shipperField = fields.find((f) => f.section === '송하인'
      && /고객성명|성명|상호/.test(f.label));
    const plan = ${JSON.stringify(FIELD_PLAN)};
    const found = {}, missing = [];
    for (const [key, p] of Object.entries(plan)) {
      const el = __findField(p);
      if (el) found[key] = el.id || p.labels[0];
      else missing.push(p.labels[0]);
    }
    return {
      shipper: shipperField ? (shipperField.value || '').trim() : null,
      found, missing,
      sections: [...new Set(fields.map((f) => f.section).filter(Boolean))],
    };
  })()`, form);

  return {
    browser: true,
    form: true,
    url: form.url,
    shipper: info.shipper,
    found: info.found,
    missing: info.missing,
    sections: info.sections,
    message: `송장 화면 연결됨 (칸 ${Object.keys(info.found).length}개 인식)`,
  };
}

/**
 * 주문 하나를 폼에 채웁니다. (저장하지 않습니다)
 * 수하인·주문 칸만 채우고 송하인·거래처·집하점은 절대 손대지 않습니다.
 */
async function fillOrder(order, { orderNo } = {}) {
  const st = await status();
  if (!st.form) throw new Error(st.message);

  const form = await findForm();
  if (!form) throw new Error('송장 입력 화면을 찾지 못했습니다.');

  const warnings = [];
  if (st.shipper === null || st.shipper === undefined) {
    warnings.push('송하인 칸을 확인하지 못했습니다. 저장 전에 화면에서 직접 확인해 주세요.');
  } else if (!st.shipper) {
    throw new Error('송하인이 비어 있습니다. 지시서에 따라 중단합니다. 화면에서 송하인을 확인해 주세요.');
  }

  const qty = order.items.reduce((s, it) => s + it.qty, 0);
  const goods = order.items.map((it) => `${it.name} ${it.qty}개`).join(', ');
  const phone = String(order.phone || '').trim();
  const isMobile = /^01[016789]/.test(phone.replace(/[^\d]/g, ''));

  const addr = String(order.address || '').trim();
  const cut = addr.search(/\s(?:\(|[0-9]+동|[0-9]+호|[가-힣]*아파트\s|B?\d+층)/);
  const baseAddr = cut > 0 ? addr.slice(0, cut).trim() : addr;
  const detailAddr = cut > 0 ? addr.slice(cut).trim() : '';

  const values = {
    name: order.buyer || '',
    mobile: isMobile ? phone : '',
    tel: isMobile ? '' : phone,
    address: baseAddr,
    addressDetail: detailAddr,
    ordNo: String(orderNo || order.no || ''),
    ordrNm: order.buyer || '',
    qty: String(Math.max(1, qty)),
    goods: goods.slice(0, 40) || '생화',
    message: '파손주의 생화입니다',
  };

  const result = await evaluate(`(() => {
    ${SCAN_FN}
    ${SET_VALUE_FN}
    const plan = ${JSON.stringify(FIELD_PLAN)};
    const protectedSections = ${JSON.stringify(PROTECTED_SECTIONS)};
    const values = ${JSON.stringify(values)};
    const done = {}, missing = [];
    for (const [key, v] of Object.entries(values)) {
      if (!v) continue;
      const p = plan[key];
      const el = __findField(p);
      if (!el) { missing.push(p.labels[0]); continue; }
      // 보호 구역(송하인·운임)에 속한 칸이면 절대 쓰지 않습니다.
      const all = __scanFields();
      const info = all.find((f) => f.el === el);
      if (info && protectedSections.includes(info.section)) { missing.push(p.labels[0] + '(보호구역)'); continue; }
      __setElValue(el, v);
      done[p.labels[0]] = v;
    }
    return { done, missing };
  })()`, form);

  if (result.missing && result.missing.length) {
    warnings.push(`화면에서 못 찾은 칸: ${result.missing.join(', ')}`);
  }
  if (!detailAddr) warnings.push('상세주소를 나누지 못했습니다. 화면에서 확인해 주세요.');
  warnings.push('우편번호는 화면의 [주소검색] 버튼으로 확인해 주세요.');

  return { filled: result.done, warnings, shipper: st.shipper };
}

/** 폼을 저장합니다. (명시적으로 지시할 때만) */
async function saveForm() {
  const form = await findForm();
  if (!form) throw new Error('송장 입력 화면을 찾지 못했습니다.');

  const before = await evaluate(`(() => {
    ${SCAN_FN}
    const el = __findField(${JSON.stringify(FIELD_PLAN.name)});
    return el ? (el.value || '') : '';
  })()`, form);

  const clicked = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button, a, input[type=button], input[type=submit], span, div')];
    const btn = nodes.find((n) => {
      const t = ((n.textContent || n.value || '') + ' ' + (n.getAttribute && n.getAttribute('onclick') || '') + ' ' + (n.id || '')).trim();
      return /fnSave|^저장$|btnSave/.test(t);
    });
    if (btn) { btn.click(); return 'click:' + (btn.id || (btn.textContent || '').trim().slice(0, 12)); }
    if (typeof fnSave === 'function') { fnSave(); return 'fnSave()'; }
    return '';
  })()`, form);
  if (!clicked) throw new Error('저장 버튼을 찾지 못했습니다. 화면에서 직접 저장해 주세요.');

  await sleep(2500);

  const after = await evaluate(`(() => {
    ${SCAN_FN}
    const el = __findField(${JSON.stringify(FIELD_PLAN.name)});
    return el ? (el.value || '') : '';
  })()`, form).catch(() => '');
  const verified = Boolean(before) && after !== before;

  return { clicked, verified, before, after };
}

module.exports = { launch, status, fillOrder, saveForm, scanScreen, ALPS_LOGIN_URL };
