/* 临时：用 CDP 在真实 Edge 里跑一次现场解（禁止虚拟时间，真等 Worker 算完） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = 'file:///' + path.join(__dirname, 'gto策略培养皿.html').replace(/\\/g, '/');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].filter(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } })[0];
const PORT = 9337;
const UD = path.join(os.tmpdir(), 'edge-cdp-solver-' + Date.now());

const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--allow-file-access-from-files', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + UD, APP], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targetUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.filter(t => t.type === 'page')[0];
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('CDP 未就绪');
}

const EXPR = `(async () => {
  const R = { ok: false };
  try {
    R.bridge = !!(window.SolverBridge && window.SolverBridge.onStreetStart);
    R.kernel = typeof window.__SOLVER_KERNEL_SRC === 'string' ? window.__SOLVER_KERNEL_SRC.length : 0;
    R.tableReady = !!(window.PostflopTable && window.PostflopTable.ready());
    R.pokerTest = !!window.__PokerTest;
    R.postflopEngine = typeof window.PostflopEngine;
    R.hasAdviceBtn = !!document.getElementById("btn-start");
    if (!R.bridge) return R;
    const t0 = Date.now();
    window.SolverBridge.onStreetStart({
      gen: 1, street: 'turn', mode: 'single', boardStr: 'Ah 7d 2c Ts',
      pfCtx: { raises: 1, opener: 'BTN', firstCaller: 'BB' },
      pot: 13, stack: 194, nPlayers: 2, bb: 2, seed: 5
    });
    R.createdMs = Date.now() - t0;
    let st = null;
    while (Date.now() - t0 < 45000) {
      st = window.SolverBridge._state();
      if (st && st.status !== 'solving') break;
      await new Promise(r => setTimeout(r, 250));
    }
    R.state = st;
    R.ms = Date.now() - t0;
    if (st && st.status === 'ready') {
      const a = await window.SolverBridge.decideFor({
        gen: 1, hole: [{ r: 12, s: 0, id: 'Qh' }, { r: 11, s: 0, id: 'Jh' }],
        posName: 'BB', toCall: 0, myBet: 0, potNow: 26, bb: 2
      });
      R.action = a ? a.a : null;
      R.opts = a ? (a.opts || []).map(x => ({ t: x.act.type, to: x.act.to || 0, p: +x.prob.toFixed(3) })) : null;
    }
    R.ok = !!(st && st.status === 'ready' && R.action);
    return R;
  } catch (e) { R.err = String(e && e.stack || e); return R; }
})()`;

(async function () {
  let ws;
  try {
    const url = await targetUrl();
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = {};
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    };
    const call = (method, params) => new Promise(res => {
      const i = ++id; pending[i] = res;
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    await call('Runtime.enable');
    /* 等页面把脚本都执行完 */
    for (let i = 0; i < 40; i++) {
      const r = await call('Runtime.evaluate', { expression: 'typeof window.SolverBridge', returnByValue: true });
      if (r.result && r.result.result && r.result.result.value === 'object') break;
      await sleep(250);
    }
    const r = await call('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 60000 });
    const v = r.result && r.result.result && r.result.result.value;
    console.log(JSON.stringify(v, null, 1));
  } catch (e) {
    console.log('失败:', e.message);
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  }
})();
