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
const DL_DIR = path.join(os.tmpdir(), 'flower-selftest-dl-' + process.pid); // 가짜 다운로드 폴더

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

/* ------------------------------------------------ 모의 낙찰서 엑셀 */

// 공판장 낙찰서와 같은 구조의 .xlsx를 외부 패키지 없이 만들어 업로드를 점검합니다.
// (실제 파일처럼 한글이 &#숫자; 표기인 칸, 공유 문자열, 그냥 한글 칸을 섞어 둡니다)

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files) { // [[이름, 내용]] → 압축 없이 담은 zip Buffer
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

function buildAuctionXlsx(date = '2026-08-24') {
  const inline = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  const numCell = (ref, n) => `<c r="${ref}" t="n"><v>${n}</v></c>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="2">${inline('A2', '&#44144;&#47000;&#45236;&#50669;(&#45209;&#52272;&#49436;)')}</row>
<row r="6">${inline('A6', '&#51473;&#46020;&#47588;&#51064;')}<c r="B6" t="s"><v>0</v></c></row>
<row r="7">${inline('A7', '화훼부류')}${inline('B7', '절화')}</row>
<row r="8">${inline('A8', '&#44221;&#47588;&#51068;&#51088;')}${inline('B8', date)}</row>
<row r="11">${inline('A11', '&#54408;&#47785;&#47749;')}${inline('B11', '품종명')}${inline('C11', '등급')}${inline('D11', '상자수')}${inline('E11', '속수량')}${inline('F11', '단가')}${inline('G11', '매입금액')}${inline('H11', '상장번호')}${inline('I11', '출하자')}</row>
<row r="12">${inline('A12', '&#44397;&#54868;')}${inline('B12', '설국')}${inline('C12', '특3')}${numCell('D12', '1.0')}${numCell('E12', '40.0')}${numCell('F12', '2340.0')}${numCell('G12', '93600.0')}${inline('H12', 'B0084-01')}${inline('I12', '김왕규')}</row>
<row r="13">${inline('A13', '장미')}${inline('B13', '스프레이')}${inline('C13', '특3')}${numCell('D13', '2.0')}${numCell('E13', '13.0')}${numCell('F13', '10600.0')}${numCell('G13', '137800.0')}${inline('H13', 'A0758-01')}${inline('I13', '로즈피아')}</row>
<row r="14">${inline('A14', '합계')}${numCell('D14', '3.0')}${numCell('E14', '53.0')}${numCell('G14', '231400.0')}</row>
</sheetData></worksheet>`;
  const shared = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>명정원예영농조</t></si></sst>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="거래내역(낙찰서)" sheetId="1"/></sheets></workbook>`;
  return zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/workbook.xml', workbook],
    ['xl/sharedStrings.xml', shared],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

/* ------------------------------------------------ 점검 실행 */

let appProc = null;

async function startApp(fresh) {
  if (fresh) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(DL_DIR, { recursive: true, force: true });
    fs.mkdirSync(DL_DIR, { recursive: true });
  }
  appProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DATA_DIR,
      DOWNLOADS_DIR: DL_DIR,
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

  console.log('\n[7] 매입 (경매 낙찰서 엑셀)');
  const xlsx64 = buildAuctionXlsx().toString('base64');
  const up = await api('/api/purchases/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: '거래내역(낙찰서).xlsx', data: xlsx64 }),
  });
  const bought = up.data.purchase || {};
  check('낙찰서 엑셀 업로드·해석 (한글 &#표기 포함)',
    up.ok && bought.date === '2026-08-24' && bought.items.length === 2,
    up.data.error || JSON.stringify(bought).slice(0, 120));
  check('품목·단가·금액 읽기',
    up.ok && bought.items[0].item === '국화' && bought.items[0].unitPrice === 2340
    && bought.items[1].amount === 137800);
  check('매입 합계 계산 (합계 줄과 검산)',
    up.ok && bought.totalAmount === 231400 && bought.totalBoxes === 3
    && bought.totalBunches === 53 && !up.data.warning);
  check('중도매인·부류 읽기', up.ok && bought.buyer === '명정원예영농조' && bought.category === '절화');

  st = (await api('/api/state')).data;
  const prow = (st.salesSummary || []).find((r) => r.label === '2026-08-24');
  check('날짜별 매출에 매입 표시 (주문 없는 날짜도)', Boolean(prow) && prow.purchase === 231400,
    JSON.stringify(prow));

  const reup = await api('/api/purchases/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: '거래내역(낙찰서)-다시.xlsx', data: xlsx64 }),
  });
  st = (await api('/api/state')).data;
  check('같은 날짜 다시 올리면 새 파일로 교체', reup.ok && reup.data.replaced === true
    && st.purchases.length === 1);

  const notXlsx = await api('/api/purchases/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: '사진.jpg', data: Buffer.from('엑셀 아님').toString('base64') }),
  });
  check('엑셀이 아니면 한국어로 알려줌', !notXlsx.ok && String(notXlsx.data.error).includes('엑셀'),
    notXlsx.data.error);

  const delRes = await api(`/api/purchases/${st.purchases[0].id}`, { method: 'DELETE' });
  st = (await api('/api/state')).data;
  check('잘못 올린 낙찰서 삭제', delRes.ok && st.purchases.length === 0);

  // 재시작 후에도 남는지 보려고 다시 올려 둡니다.
  await api('/api/purchases/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: '거래내역(낙찰서).xlsx', data: xlsx64 }),
  });

  console.log('\n[8] 낙찰서 자동 가져오기 · 장부 엑셀');
  // 공판장에서 받은 것처럼 다운로드 폴더에 넣습니다. (받은 지 1분 된 파일로)
  const putDownload = (name, buf) => {
    const file = path.join(DL_DIR, name);
    fs.writeFileSync(file, buf);
    const t = new Date(Date.now() - 60000);
    fs.utimesSync(file, t, t);
  };
  putDownload('거래내역낙찰서20260824.xlsx', buildAuctionXlsx('2026-08-24')); // 이미 올린 것과 같은 내용
  putDownload('거래내역낙찰서20260825.xlsx', buildAuctionXlsx('2026-08-25'));
  putDownload('은행거래내역.xlsx', buildAuctionXlsx('2026-08-20')); // 낙찰서가 아닌 파일
  const scan = await api('/api/purchases/auto', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  const got = (scan.data.imported || []).map((i) => i.date);
  check('다운로드 폴더의 낙찰서 자동 등록', scan.ok && got.includes('2026-08-25'), got.join(','));
  check('같은 내용·낙찰서 아닌 파일은 건너뜀', got.length === 1, got.join(','));

  st = (await api('/api/state')).data;
  const auto825 = st.purchases.find((p) => p.date === '2026-08-25');
  const detail825 = auto825 && await api(`/api/purchases/${auto825.id}`);
  check('목록은 가볍게, 품목은 [자세히] 때 따로',
    Boolean(auto825) && !('items' in auto825) && auto825.itemCount === 2 && auto825.source === 'auto'
    && detail825.ok && detail825.data.purchase.items.length === 2);

  await api(`/api/purchases/${auto825.id}`, { method: 'DELETE' });
  const rescan = await api('/api/purchases/auto', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  check('지운 낙찰서는 다시 들어오지 않음', rescan.ok && rescan.data.imported.length === 0);

  await api('/api/purchases/auto', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  putDownload('거래내역낙찰서20260826.xlsx', buildAuctionXlsx('2026-08-26')); // 꺼져 있는 동안 받은 파일

  st = (await api('/api/state')).data;
  const aug = (st.monthTotals || []).find((m) => m.month === '2026-08');
  check('달 합계에 매입 반영', Boolean(aug) && aug.purchase === 231400 && aug.purchaseDays === 1,
    JSON.stringify(aug));
  const ledger = await fetch(`http://127.0.0.1:${APP_PORT}/api/export/sales.csv`);
  const ledgerBytes = Buffer.from(await ledger.arrayBuffer()); // .text()는 BOM을 떼어 버리므로 바이트로 확인
  const ledgerText = ledgerBytes.toString('utf8');
  check('장부 엑셀(CSV) 내려받기',
    ledger.ok && ledgerBytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])) && ledgerText.includes('"매입(원)"')
    && ledgerText.includes('"2026-08-24"') && ledgerText.includes('"231400"') && ledgerText.includes('"2026-08 합계"'),
    ledgerText.slice(0, 160));

  console.log('\n[9] 송장 도우미 (롯데 ALPS)');
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

  console.log('\n[10] 껐다 켜도 유지되는지');
  appProc.kill();
  await sleep(800);
  await startApp();
  st = (await api('/api/state')).data;
  check('주문·설정 유지', st.orders.length >= 3 && st.nongra.configured === true,
    `주문 ${st.orders.length}건`);
  check('매입(낙찰서) 기록 유지', st.purchases.length === 1
    && st.purchases[0].totalAmount === 231400, `매입 ${st.purchases.length}건`);
  await sleep(3500); // 켜고 3초 뒤 첫 확인이 지나가도록
  st = (await api('/api/state')).data;
  check('자동 가져오기를 끄면 그대로 꺼져 있음',
    st.purchaseAuto.enabled === false && !st.purchases.some((p) => p.date === '2026-08-26'));
  const reon = await api('/api/purchases/auto', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  const reonDates = (reon.data.imported || []).map((i) => i.date);
  check('다시 켜면 꺼져 있던 동안 받은 낙찰서만 가져옴 (지운 것은 기억)',
    reonDates.length === 1 && reonDates[0] === '2026-08-26', reonDates.join(','));
  await api('/api/nongra/refresh', { method: 'POST', body: '{}' });
  const after = (await api('/api/state')).data;
  const nongraCount = after.orders.filter((o) => o.channel === 'nongra').length;
  check('중복 등록 없음', nongraCount === 2, `농라 주문 ${nongraCount}건`);

  console.log('\n[11] 프로그램 스스로 점검하기 (🩺 전체 점검)');
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
  fs.rmSync(DL_DIR, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n점검 중 오류:', err.message, '\n');
  if (appProc) appProc.kill();
  process.exit(1);
});
