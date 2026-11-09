/* 快照瘦身（D1）+ 服务端 gzip（D2）测试
   D1：buildSnapshot 只带日志/历史的尾部窗口（logFrom/histFrom），客机合并回完整副本
   D2：/api/poll 与 /api/* JSON 响应 >1KB 且客户端支持时 gzip，小响应与不支持时不压 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = 8899;
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  [' + extra + ']' : '')); }
}

const html = fs.readFileSync(path.join(ROOT, 'gto策略培养皿.html'), 'utf8');
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/* ---------- ① D1 源码契约 ---------- */
ok(/const WIRE_LOG_MAX = 90;/.test(html) && /const WIRE_HIST_MAX = 4;/.test(html),
  '① 有日志/历史传输窗口上限常量（90 条 / 4 局）');
ok(/const logFrom = Math\.max\(0, liveLog\.length - WIRE_LOG_MAX\);/.test(html) &&
  /const histFrom = Math\.max\(0, handHistory\.length - WIRE_HIST_MAX\);/.test(html),
  '① buildSnapshot 计算尾部起点下标');
ok(/logFrom: logFrom,\s*\n\s*log: liveLog\.slice\(logFrom\),/.test(html) &&
  /histFrom: histFrom,\s*\n\s*hist: handHistory\.slice\(histFrom\),/.test(html),
  '① buildSnapshot 只发送 slice 出的尾部窗口');
ok(!/^\s*log: liveLog,\s*$/m.test(html) && !/^\s*hist: handHistory,\s*$/m.test(html),
  '① 不再整包发送完整 liveLog / handHistory');
ok(/function mergeWireLog\(snap, target\)/.test(html) &&
  /if \(from === 0 \|\| from > target\.length\) target\.length = 0;/.test(html),
  '① 日志尾部合并在 mergeWireLog（起点越界则整包替换）');
ok(/function mergeWireHist\(snap, target\)/.test(html) &&
  /if \(from === 0 \|\| from > target\.length\) return inc\.slice\(\);/.test(html),
  '① 历史尾部合并在 mergeWireHist（起点越界则整包替换）');
ok(/mergeWireLog\(snap, liveLog\);/.test(html) && /handHistory = mergeWireHist\(snap, handHistory\);/.test(html),
  '① applySnapshot 调用两个合并函数');
ok(/const histTailNo = handHistory\.length \? handHistory\[handHistory\.length - 1\]\.no : -1;/.test(html) &&
  /histTailNo !== lastHistTailNo/.test(html),
  '① 历史渲染按"长度 + 最后一局局号"判定（瘦身后长度不变但内容会换）');

/* ---------- ①-2 合并逻辑的行为测试（提取真函数） ---------- */
const mergeSrc = html.slice(html.indexOf('function mergeWireLog('), html.indexOf('function buildSnapshot('));
let M = null;
try { M = new Function(mergeSrc + '\n; return { mergeWireLog: mergeWireLog, mergeWireHist: mergeWireHist };')(); }
catch (e) { console.log('  ✗ 提取合并函数失败: ' + e.message); }
ok(!!M, '① 能提取 mergeWireLog / mergeWireHist');
if (M) {
  const mkLog = n => Array.from({ length: n }, (_, i) => ({ text: 'L' + i }));
  const mkHist = (from, n) => Array.from({ length: n }, (_, i) => ({ no: from + i, lines: [] }));

  let local = mkLog(120);
  M.mergeWireLog({ logFrom: 110, log: mkLog(120).slice(110) }, local);
  ok(local.length === 120 && local[119].text === 'L119', '① 尾部窗口拼回：本地 120 条仍是 120 条', '长度 ' + local.length);

  local = [];
  M.mergeWireLog({ logFrom: 110, log: mkLog(120).slice(110) }, local);
  ok(local.length === 10, '① 本地为空（换页/重连）→ 退回整包替换', '长度 ' + local.length);

  local = mkLog(120);
  M.mergeWireLog({ logFrom: 5, log: mkLog(20).slice(5) }, local);
  ok(local.length === 20 && local[0].text === 'L0', '① 起点回退（重放旧快照）→ 截断到起点再拼，不重复', '长度 ' + local.length);

  local = mkLog(3);
  M.mergeWireLog({ log: [{ text: 'X' }] }, local);
  ok(local.length === 1 && local[0].text === 'X', '① 无 logFrom 字段（旧格式）→ 整包替换');

  let h = mkHist(0, 30);
  const merged = M.mergeWireHist({ histFrom: 26, hist: mkHist(26, 4) }, h);
  ok(merged.length === 30 && merged[29].no === 29, '① 历史尾部窗口拼回：30 局仍是 30 局', '长度 ' + merged.length);

  h = [];
  const fresh = M.mergeWireHist({ histFrom: 26, hist: mkHist(26, 4) }, h);
  ok(fresh.length === 4 && fresh[0].no === 26, '① 历史本地为空 → 取尾窗 4 局', '长度 ' + fresh.length);
}

/* ---------- ② D2 服务端契约 ---------- */
ok(/const zlib = require\('zlib'\);/.test(srv), '② 服务端引入 zlib');
ok(/function sendJson\(req, res, obj\)/.test(srv) && /buf\.length > 1024 && \/\\bgzip\\b\/i\.test\(ae\)/.test(srv),
  '② sendJson：>1KB 且 Accept-Encoding 含 gzip 才压缩');
ok(/res\.json = function \(o\) \{\s*\n\s*sendJson\(req, res, o\);/.test(srv),
  '② res.json 统一走 sendJson');
ok((srv.match(/sendJson\(req, res, \{ ok: (true|false)/g) || []).length === 2,
  '② /api/poll 的正常回包与 closed 回包都走 sendJson');

/* ---------- ③ D2 端到端：真起服务器 ---------- */
function req(method, p, body, headers) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {})
    }, function (res) {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function run() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), MP_SWEEP: '5000' }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errBuf = '';
  proc.stderr.on('data', d => { errBuf += d.toString(); });

  /* 等端口就绪 */
  for (let i = 0; i < 40; i++) {
    try { await req('GET', '/api/lan'); break; }
    catch (e) { await sleep(100); }
  }

  try {
    const c = await req('POST', '/api/create', { name: '主机', mode: 'normal' });
    const cr = JSON.parse(c.buf.toString());
    ok(cr.ok && cr.room && cr.id, '③ 创建房间成功（' + cr.room + '）');

    const j = await req('POST', '/api/join', { room: cr.room, name: '客机' });
    const jr = JSON.parse(j.buf.toString());
    ok(jr.ok && jr.id, '③ 客机加入成功');

    /* 造一份"长会话"快照：600 条日志 + 30 局历史 */
    const log = [];
    for (let i = 0; i < 600; i++) log.push({ text: '第' + i + '条 · 玩家加注至 12bb 底池 34bb', cls: 'a', meta: { kind: 'action', name: 'P' + (i % 8), amount: '12bb' } });
    const hist = [];
    for (let i = 0; i < 30; i++) hist.push({ no: i + 1, lines: log.slice(0, 20) });
    const snap = { phase: 'playing', logFrom: 510, log: log.slice(510), histFrom: 26, hist: hist.slice(26), seats: [], board: [] };

    const m = await req('POST', '/api/msg', { room: cr.room, id: cr.id, msg: { type: 'state', snap: snap } });
    ok(JSON.parse(m.buf.toString()).ok, '③ 主机推送状态成功');

    /* ③-1 带 gzip 的客户端 */
    const g = await req('GET', '/api/poll?room=' + cr.room + '&id=' + jr.id + '&seq=0', undefined, { 'Accept-Encoding': 'gzip, deflate' });
    ok(g.status === 200, '③ 长轮询回包 200');
    ok((g.headers['content-encoding'] || '') === 'gzip', '③ 大响应带 Content-Encoding: gzip', '实际 ' + g.headers['content-encoding']);
    const plain = zlib.gunzipSync(g.buf).toString();
    const d = JSON.parse(plain);
    ok(d.ok && d.msgs && d.msgs.length === 1, '③ 解压后能正常解析出消息');
    ok(d.msgs[0].snap.logFrom === 510 && d.msgs[0].snap.log.length === 90,
      '③ 快照只传尾部 90 条日志（起点 510）', 'log=' + d.msgs[0].snap.log.length);
    ok(d.msgs[0].snap.histFrom === 26 && d.msgs[0].snap.hist.length === 4,
      '③ 快照只传尾部 4 局历史', 'hist=' + d.msgs[0].snap.hist.length);
    const rawLen = Buffer.byteLength(plain);
    const gzLen = g.buf.length;
    ok(gzLen < rawLen / 3, '③ gzip 压缩率 ≥ 3 倍（' + Math.round(rawLen / 1024) + 'KB → ' + Math.round(gzLen / 1024) + 'KB）',
      rawLen + ' → ' + gzLen);

    /* ③-2 不带 Accept-Encoding：必须原样明文，不能压坏 */
    const m2 = await req('POST', '/api/msg', { room: cr.room, id: cr.id, msg: { type: 'chat', text: '再来一条' } });
    ok(JSON.parse(m2.buf.toString()).ok, '③ 第二条消息推送成功');
    const p2 = await req('GET', '/api/poll?room=' + cr.room + '&id=' + jr.id + '&seq=1');
    ok(!p2.headers['content-encoding'], '③ 客户端不支持 gzip 时明文返回', '实际 ' + p2.headers['content-encoding']);
    ok(JSON.parse(p2.buf.toString()).msgs.length === 1, '③ 明文回包内容正确');

    /* ③-3 小响应不压缩（创建房间的回包只有几十字节） */
    const small = await req('GET', '/api/lan', undefined, { 'Accept-Encoding': 'gzip' });
    ok(!small.headers['content-encoding'], '③ 小于 1KB 的响应不压缩（省 CPU）');

    /* ---------- ④ 新增客户端模块必须可经 HTTP 下发（否则联机静默降级） ---------- */
    const need = ['postflop-table.js', 'postflop-table-data.js', 'solver-kernel-src.js', 'postflop-solver-bridge.js'];
    const m4 = srv.match(/const CLIENT_JS = \[([\s\S]*?)\];/);
    ok(!!m4, '④ 服务端有 CLIENT_JS 白名单');
    need.forEach(function (f) {
      ok(m4 && m4[1].indexOf("'" + f + "'") >= 0, '④ 白名单已登记 ' + f);
    });
    for (const f of need) {
      const r = await req('GET', '/' + f, undefined, { 'Accept-Encoding': 'gzip' });
      ok(r.status === 200, '④ GET /' + f + ' → 200', '实际 ' + r.status);
      ok((r.headers['content-type'] || '').indexOf('javascript') >= 0, '④ /' + f + ' Content-Type 是 JS', r.headers['content-type']);
    }
    const br = await req('GET', '/postflop-solver-bridge.js', undefined, { 'Accept-Encoding': 'gzip' });
    ok(br.headers['content-encoding'] === 'gzip', '④ 大脚本走 gzip（联机首屏省流量）', br.headers['content-encoding']);
    ok(zlib.gunzipSync(br.buf).toString().indexOf('SolverBridge') >= 0, '④ 解压后内容正确（SolverBridge）');
    const tr = await req('GET', '/postflop-table-data.js', undefined, { 'Accept-Encoding': 'gzip' });
    ok(tr.buf.length < 300 * 1024, '④ 策略表压缩后 < 300KB（原始 800KB）', Math.round(tr.buf.length / 1024) + 'KB');
    const hr = await req('GET', '/', undefined, { 'Accept-Encoding': 'gzip' });
    ok(hr.status === 200 && hr.headers['content-encoding'] === 'gzip', '④ 入口 HTML 也走 gzip', hr.headers['content-encoding']);
    const hPlain = zlib.gunzipSync(hr.buf).toString();
    ok(hPlain.indexOf('solver-kernel-src.js') >= 0 && hPlain.indexOf('postflop-solver-bridge.js') >= 0,
      '④ 入口 HTML 引用了解算内核与桥接');
    const kr = await req('GET', '/solver-kernel-src.js');
    ok(kr.status === 200 && !kr.headers['content-encoding'], '④ 不支持 gzip 的客户端拿到明文内核', kr.headers['content-encoding']);
  } catch (e) {
    fail++; console.log('  ✗ 端到端异常: ' + e.message);
  }

  try { proc.kill(); } catch (e) {}
  if (errBuf.trim()) console.log('  (server stderr) ' + errBuf.trim().split('\n').slice(0, 3).join(' | '));

  console.log('\n--- 快照瘦身/gzip 测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
  process.exit(fail ? 1 : 0);
})();
