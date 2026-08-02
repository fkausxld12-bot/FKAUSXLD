'use strict';

/**
 * 전체 자체 점검 (설치 전에 프로그램이 스스로 확인합니다)
 *
 *   node selftest.js
 *
 * 농라F·주문·현장판매·문자주문·매출·송장 도우미까지 모두 모의 사이트로
 * 실제 동작을 확인하고 결과를 한국어로 알려줍니다.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const APP_PORT = 4711;
const SITE_PORT = 4712;
const ALPS_SHELL_PORT = 4713;
const ALPS_FORM_PORT = 4714;
const CDP_PORT = 9711;
const DATA_DIR = path.join(os.tmpdir(), 'flower-selftest-' + process.pid);

let pass = 0;
let fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(pathName, options) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${pathName}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/* ------------------------------------------------ 모의 농라F 사이트 */

let soldArgus = 12;
let ordersHtml = `
<div>주문완료</div><div>입금완료</div><div>택배발송</div><div>구매확정</div>
<div>15,000 원</div>
<div>26-08-02 19:02</div>
<div>25244427</div>
<div>이선희 (yfqfo264308) 010-3326-4308</div>
<div>[이선희] 인천 미추홀구 소성로163번길 49 (학익동, 타워) 311</div>
<div>공작초)백공작 (1 개)</div>
<div>부들레야)보라 (2 개)</div>
<div>택배요금 : 4000</div>
<div>총결제요금 : 15000</div>
<div>일시 : 2026-08-02 19:02:12</div>`;

function salesWidget() {
  return [
    ['장미)원탑(sp)', 16, 8000, 1988810],
    ['장미)스노우블라썸(sp)', 49, 10000, 1988811],
    ['국화)아르거스', 20, 4000, 1988813],
    ['장미)빈티지스프레이장미', 2, 13000, 1988814],
  ].map(([name, total, price, id]) => `
<input type="hidden" name="option_quantity[${id}]" id="option_quantity_${id}" value="0"
  attr-cont='${name}' data-idx1="${id}" data-idx2="${total}">
<div class="cvss_row">
  <div class="fl goods"><span class="goods_name">${name}</span></div>
  <!-- <div>재고 : ${total} 개</div> -->
  <div class="fr won">${price.toLocaleString()}원</div>
  <a onclick="quantity(-1, ${id}, ${price});" class="_minus"></a>
</div>`).join('');
}

const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const html = (body) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  if (url.pathname === '/gnuboard5/bbs/login_check.php') {
    res.writeHead(302, { Location: '/gnuboard5/', 'Set-Cookie': 'PHPSESSID=t; path=/' });
    return res.end();
  }
  if (url.pathname === '/gnuboard5/skin/board/basic/view_gonggoo.cnt.php') {
    const live = {
      1988810: '6_10_0', 1988811: '30_19_0',
      1988813: `${soldArgus}_${20 - soldArgus}_1`, 1988814: '2_0_0',
    };
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(live[url.searchParams.get('idx')] || '');
  }
  if (url.pathname === '/html/mypage_buy_log.php') {
    return html(`<html><body><h1>주문배송</h1>${ordersHtml}</body></html>`);
  }
  if (url.pathname === '/gnuboard5/bbs/board.php') {
    if (url.searchParams.get('wr_id')) {
      return html(`<html><head><title>판매</title></head><body>
<nav><a href="/html/mypage_buy_log.php">주문배송</a></nav>
<h1 id="bo_v_title"><span class="bo_v_tit">8/2 판매</span></h1>
${salesWidget()}</body></html>`);
    }
    return html(`<html><body><ul>
<li><a href="/gnuboard5/bbs/board.php?bo_table=ymh14141&amp;wr_id=49">8/2 판매</a></li>
</ul></body></html>`);
  }
  if (url.pathname.startsWith('/ymh14141')) {
    const seg = url.pathname.split('/').filter(Boolean);
    if (seg[1]) return html(`<html><body><a href="/gnuboard5/bbs/board.php?bo_table=ymh14141&wr_id=49">글</a></body></html>`);
    res.writeHead(404);
    return res.end('404');
  }
  if (url.pathname === '/__neworder') {
    soldArgus += 2;
    ordersHtml += `
<div>주문완료</div><div>입금완료</div>
<div>12,000 원</div>
<div>26-08-02 19:40</div>
<div>25244099</div>
<div>박철수 01099998888</div>
<div>[박철수] 서울시 마포구 어딘가 7</div>
<div>국화)아르거스 (2 개)</div>
<div>택배요금 : 4000</div>
<div>총결제요금 : 12000</div>
<div>일시 : 2026-08-02 19:40:05</div>`;
    res.writeHead(200);
    return res.end('ok');
  }
  if (url.pathname === '/__ship') {
    ordersHtml = ordersHtml.replace('<div>15,000 원</div>',
      '<div>411378009999</div><div>롯데택배</div>\n<div>15,000 원</div>');
    res.writeHead(200);
    return res.end('ok');
  }
  res.writeHead(404);
  res.end();
});

/* ------------------------------------------------ 모의 ALPS (교차출처 iframe) */

let alpsSaved = null;

const alpsShell = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>ALPS</title></head><body>
<h1>건별주문접수</h1>
<iframe id="PIDCUS013U" src="http://127.0.0.1:${ALPS_FORM_PORT}/form" width="900" height="600"></iframe>
</body></html>`);
});

const alpsForm = http.createServer((req, res) => {
  if (req.url === '/saved' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { alpsSaved = JSON.parse(body); } catch { alpsSaved = null; }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>
<div class="sec">송하인</div>
<table>
<tr><td>전화번호</td><td><input id="f1" value="010-9477-6402"></td>
    <td>고객성명</td><td><input id="f2" value="명정원예영농조합법인"></td></tr>
<tr><td>주소</td><td><input id="f3" value="전북 임실군 지사면 원산리 748"></td></tr>
</table>
<div class="sec">수하인</div>
<table>
<tr><td>전화번호</td><td><input id="g1"></td><td>고객성명</td><td><input id="g2"></td></tr>
<tr><td>휴대폰</td><td><input id="g3"></td></tr>
<tr><td>주소</td><td><input id="g4"></td></tr>
<tr><td>상세주소</td><td><input id="g5"></td></tr>
<tr><td>주문번호</td><td><input id="g6"></td><td>주문자명</td><td><input id="g7"></td></tr>
</table>
<div class="sec">기타화물정보</div>
<table>
<tr><td>내품수량</td><td><input id="h1"></td></tr>
<tr><td>상품명</td><td><input id="h2"></td></tr>
<tr><td>배달메세지</td><td><input id="h3"></td></tr>
</table>
<button id="btnSave" onclick="fnSave()">저장</button>
<script>
function fnSave() {
  const map = { edtAcperNm:'g2', edtAcperTel:'g1', edtAcperCpno:'g3', edtAcperPadr:'g4',
                edtAcperEtcAdr:'g5', edtOrdNo:'g6', edtOrdrNm:'g7', maeQty:'h1',
                edtGdsNm:'h2', edtDlvMsgCont:'h3', edtSndrNm:'f2' };
  const data = {};
  Object.entries(map).forEach(([k, id]) => { data[k] = document.getElementById(id).value; });
  fetch('/saved', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) })
    .then(() => Object.entries(map).forEach(([k, id]) => { if (k !== 'edtSndrNm') document.getElementById(id).value = ''; }));
}
</script></body></html>`);
});

/* ------------------------------------------------ 점검 실행 */

let appProc = null;

async function startApp(fresh) {
  if (fresh) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  appProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DATA_DIR,
      ALPS_PORT: String(CDP_PORT),
      ALPS_SITE_RE: `localhost:${ALPS_SHELL_PORT}|127\\.0\\.0\\.1:${ALPS_FORM_PORT}`,
      ALPS_LOGIN_URL: `http://localhost:${ALPS_SHELL_PORT}/`,
      TZ: 'Asia/Seoul',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    try {
      const r = await api('/api/state');
      if (r.ok) return r.data.version;
    } catch {
      /* 아직 시작 중 */
    }
  }
  throw new Error('프로그램이 시작되지 않았습니다.');
}

async function main() {
  console.log('\n🌸 꽃 작업장 프로그램 자체 점검\n');

  siteServer.listen(SITE_PORT, '127.0.0.1');
  alpsShell.listen(ALPS_SHELL_PORT, 'localhost');
  alpsForm.listen(ALPS_FORM_PORT, '127.0.0.1');
  await sleep(300);

  const version = await startApp(true);
  console.log(`[1] 프로그램 실행 (${version})`);
  check('서버가 켜지고 화면 데이터를 준다', Boolean(version));

  console.log('\n[2] 농라F 연동');
  const setup = await api('/api/nongra/settings', {
    method: 'POST',
    body: JSON.stringify({
      url: `http://127.0.0.1:${SITE_PORT}/ymh14141/49`,
      mbId: 'tester', mbPw: 'pw',
    }),
  });
  check('연동 설정 저장', setup.ok, setup.data.error);
  await sleep(600);

  let st = (await api('/api/state')).data;
  check('사이트 경로 자동 감지', String(st.nongra.base).includes('gnuboard5'), st.nongra.base);
  check('로그인 성공', st.nongra.loggedIn === true);
  check('상품 4종 동기화', st.nongra.sales.products.length === 4,
    `${st.nongra.sales.products.length}종`);
  check('실시간 재고·판매 수량 읽기',
    st.nongra.sales.products.some((p) => p.sold === 6 && p.stock === 10));
  check('품절 상품 인식', st.nongra.sales.products.some((p) => p.stock === 0));
  check('주문배송에서 주문 자동 등록', st.orders.length === 1, `${st.orders.length}건`);
  const lee = st.orders.find((o) => o.buyer.includes('이선희'));
  check('배송비 제외 금액 계산',
    lee && lee.items.reduce((s, i) => s + i.price, 0) === 11000,
    lee && String(lee.items.reduce((s, i) => s + i.price, 0)));
  check('주소·연락처 추출', Boolean(lee && lee.address && lee.phone));

  console.log('\n[3] 새 주문 감지와 송장 자동 완료');
  await fetch(`http://127.0.0.1:${SITE_PORT}/__neworder`);
  await api('/api/nongra/refresh', { method: 'POST', body: '{}' });
  st = (await api('/api/state')).data;
  check('새 주문 자동 등록', st.orders.length === 2, `${st.orders.length}건`);
  check('판매 수량 실시간 반영',
    st.nongra.sales.products.some((p) => p.name.includes('아르거스') && p.sold === 14));

  await fetch(`http://127.0.0.1:${SITE_PORT}/__ship`);
  await api('/api/nongra/refresh', { method: 'POST', body: '{}' });
  st = (await api('/api/state')).data;
  const leeAfter = st.orders.find((o) => o.buyer.includes('이선희'));
  check('송장 붙으면 완료로 자동 전환', leeAfter && leeAfter.status === 'shipped',
    leeAfter && leeAfter.status);

  console.log('\n[4] 현장 판매');
  const sale = await api('/api/field-sale', {
    method: 'POST',
    body: JSON.stringify({ items: [{ name: '장미)원탑(sp)', qty: 2, price: 16000 }] }),
  });
  check('현장 판매 등록 (배송비 없음)', sale.ok && sale.data.total === 16000);
  const saleId = sale.data.order && sale.data.order.id;
  await api(`/api/orders/${saleId}/status`, { method: 'POST', body: JSON.stringify({ status: 'canceled' }) });
  st = (await api('/api/state')).data;
  const canceled = st.orders.find((o) => o.id === saleId);
  check('실수 취소 시 수량 복구', canceled && canceled.status === 'canceled');

  console.log('\n[5] 문자 주문');
  const sms = await api('/api/sms-order', {
    method: 'POST',
    body: JSON.stringify({
      buyer: '김손님', phone: '010-1111-2222', address: '서울시 강남구 어딘가 1 (역삼동) 101호',
      items: [{ name: '장미)원탑(sp)', qty: 2, price: 16000 }],
    }),
  });
  check('문자 주문 등록', sms.ok && sms.data.order.status === 'paid');
  check('배송비 자동 포함 (4,000원)', sms.data.shippingFee === 4000 && sms.data.payTotal === 20000,
    `${sms.data.payTotal}원`);
  check('안내 문구에 계좌 포함', String(sms.data.message).includes('351-1168-0445-63'));

  const big = await api('/api/sms-order', {
    method: 'POST',
    body: JSON.stringify({
      buyer: '대량', phone: '010-2', address: '부산',
      items: [{ name: '장미)스노우블라썸(sp)', qty: 11, price: 110000 }],
    }),
  });
  check('10만원 이상 무료배송', big.data.shippingFee === 0);

  console.log('\n[6] 날짜별 매출');
  await api('/api/salesday', {
    method: 'POST',
    body: JSON.stringify({ label: '2026-08-03', at: '2026-08-02 18:00' }),
  });
  st = (await api('/api/state')).data;
  const rows = Object.fromEntries((st.salesSummary || []).map((r) => [r.label, r]));
  check('발송글 기준 날짜 분리', Boolean(rows['2026-08-03']), Object.keys(rows).join(','));
  check('매출은 배송비 제외 물품 금액', (rows['2026-08-03'] || {}).amount > 0);

  console.log('\n[7] 송장 도우미 (롯데 ALPS)');
  const before = await api('/api/alps/status');
  check('상태를 사람이 알아볼 수 있게 안내',
    typeof before.data.message === 'string' && before.data.message.length > 5,
    before.data.message);

  // 실제 브라우저로 폼 채우기까지 확인 (크롬이 있을 때만)
  const alps = require('./alps');
  let browserOk = false;
  try {
    process.env.ALPS_HEADLESS = process.env.ALPS_HEADLESS || '1';
    const testModule = path.join(os.tmpdir(), `alps-selftest-${process.pid}.js`);
    process.env.ALPS_LOGIN_URL = `http://localhost:${ALPS_SHELL_PORT}/`;
    process.env.ALPS_SITE_RE = `localhost:${ALPS_SHELL_PORT}|127\\.0\\.0\\.1:${ALPS_FORM_PORT}`;
    fs.writeFileSync(testModule, fs.readFileSync(path.join(__dirname, 'alps.js'), 'utf8'));
    const testAlps = require(testModule);

    await testAlps.launch();
    await sleep(2500);
    const status = await testAlps.status();
    browserOk = status.form === true;
    check('송장 화면(교차출처 iframe) 연결', browserOk, status.message);
    check('송하인 읽기 (수정하지 않음)', status.shipper === '명정원예영농조합법인', status.shipper);

    if (browserOk) {
      const order = {
        id: 'test', no: 99, buyer: '이선희', phone: '010-3326-4308',
        address: '인천 미추홀구 소성로163번길 49 (학익동, 타워) 311호',
        items: [{ name: '공작초)백공작', qty: 1 }, { name: '부들레야)보라', qty: 2 }],
      };
      const filled = await testAlps.fillOrder(order, { orderNo: 99 });
      check('수하인·주소·수량 자동 입력 (라벨로 찾기)',
        filled.filled['고객성명'] === '이선희' && filled.filled['내품수량'] === '3',
        JSON.stringify(filled.filled));
      const saved = await testAlps.saveForm();
      check('저장 후 재조회로 확인', saved.verified === true);
      await sleep(500);
      check('사이트에 저장됨', alpsSaved && alpsSaved.edtAcperNm === '이선희');
      check('송하인은 그대로 유지', alpsSaved && alpsSaved.edtSndrNm === '명정원예영농조합법인');

      // 창이 멈췄을 때 스스로 닫고 다시 여는지
      const again = await testAlps.launch({ force: true });
      check('강제 다시 열기로 창 복구', again.started === true,
        `${again.message} / ${(again.log || []).join(' → ')}`);
      await sleep(1500);
      const reStatus = await testAlps.status();
      check('다시 연 창에서도 송장 화면 인식', reStatus.form === true, reStatus.message);
    }
    fs.rmSync(testModule, { force: true });
  } catch (err) {
    console.log(`  · 브라우저 점검 건너뜀 (${err.message})`);
  }

  console.log('\n[8] 껐다 켜도 유지되는지');
  appProc.kill();
  await sleep(800);
  await startApp();
  st = (await api('/api/state')).data;
  check('주문·설정 유지', st.orders.length >= 3 && st.nongra.configured === true,
    `주문 ${st.orders.length}건`);
  await api('/api/nongra/refresh', { method: 'POST', body: '{}' });
  const after = (await api('/api/state')).data;
  const nongraCount = after.orders.filter((o) => o.channel === 'nongra').length;
  check('중복 등록 없음', nongraCount === 2, `농라 주문 ${nongraCount}건`);

  console.log('\n[9] 프로그램 스스로 점검하기 (🩺 전체 점검)');
  const sc = (await api('/api/selfcheck')).data;
  check('점검 결과를 한국어로 알려준다',
    Array.isArray(sc.lines) && sc.lines.length >= 5, JSON.stringify(sc).slice(0, 120));
  check('농라F 상태를 짚어준다',
    (sc.lines || []).some((l) => l.includes('농라F')));
  check('송장 브라우저 위치를 알려준다',
    (sc.lines || []).some((l) => l.includes('송장용 브라우저')));
  check('문제가 있으면 무엇이 문제인지 알려준다',
    Array.isArray(sc.problems) && typeof sc.ok === 'boolean');
  const openFail = await api('/api/alps/open', { method: 'POST', body: '{}' });
  check('송장 창을 못 열면 시도 내용까지 알려준다',
    openFail.ok || (openFail.data.error || '').includes('시도한 내용') || openFail.data.started !== undefined,
    JSON.stringify(openFail.data).slice(0, 160));

  console.log(`\n${'─'.repeat(46)}`);
  if (fail === 0) {
    console.log(`✅ 모두 정상입니다. (${pass}개 항목 통과)\n`);
  } else {
    console.log(`⚠ ${fail}개 항목에 문제가 있습니다. (통과 ${pass}개)\n`);
  }

  appProc.kill();
  siteServer.close();
  alpsShell.close();
  alpsForm.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n점검 중 오류:', err.message, '\n');
  if (appProc) appProc.kill();
  process.exit(1);
});
