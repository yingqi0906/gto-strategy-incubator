/* 筹码守恒定点探测 v2：不主动起手，让程序自带"3 秒后自动下一局"循环跑，
   在每手"局间等待"窗口内采样，检查不变量 chips + 桌上未收下注 == brought */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const PORT = 18989;
const BASE = 'http://127.0.0.1:' + PORT;

class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div'; this.children = []; this._class = new Set();
    this.style = {}; this.parentNode = null; this.textContent = '';
    this._innerHTML = ''; this.disabled = false; this.value = '';
    this.min = 0; this.max = 0; this.step = 1; this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null; this._qs = {}; this._listeners = {};
  }
  get classList() {
    const s = this;
    return { add: c => s._class.add(c), remove: c => s._class.delete(c),
      toggle: (c, f) => { if (f === undefined) { s._class.has(c) ? s._class.delete(c) : s._class.add(c); } else if (f) s._class.add(c); else s._class.delete(c); },
      contains: c => s._class.has(c) };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  querySelectorAll() { return []; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener() {} focus() {}
  getBoundingClientRect() { return { width: 100, height: 100, top: 0, left: 0 }; }
  contains() { return false; }
}
const byId = {};
global.document = { getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(t) { return new FakeEl(t); }, addEventListener() {}, body: new FakeEl('body'),
  documentElement: new FakeEl('html'), hidden: false };
global.window = global;
global.location = { host: 'localhost:' + PORT, origin: BASE, href: BASE + '/', search: '', protocol: 'http:', pathname: '/' };
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.sessionStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.alert = function () {};
global.PokerCore = require('./core.js');
const realFetch = fetch;
global.fetch = function (u, o) { if (typeof u === 'string' && u[0] === '/') u = BASE + u; return realFetch(u, o); };
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const P = T.players;
const D = T.debug;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function () {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: Object.assign({}, process.env, { PORT: String(PORT), MP_SEATS: '9' }), stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(BASE + '/'); up = true; } catch (e) { await sleep(100); } }
  await sleep(300);

  T.client.setMode('single', 0, '我');
  for (let i = 0; i < 9; i++) { P[i].seatType = null; P[i].name = ''; P[i].chips = 0; P[i].brought = 0; P[i].inHand = false; }
  // 6 名 AI（不含我，全自动）
  for (let i = 0; i < 6; i++) { P[i].seatType = 'ai'; P[i].name = 'AI' + i; P[i].chips = 100; P[i].brought = 100; }

  /* 不变量：chips + 桌上未收下注 == brought。
     注意：不要加 collectedPot —— 局间窗口里筹码已派回玩家，而 collectedPot 要等
     下一手 playHand 开头才清零，此刻它是上一手的残值，加上会重复计数。 */
  const inv = () => {
    const chips = P.slice(0, 6).reduce((a, p) => a + p.chips, 0);
    const bets = P.slice(0, 6).reduce((a, p) => a + (p.bet || 0), 0);
    const brought = P.slice(0, 6).reduce((a, p) => a + (p.brought || 0), 0);
    const inHand = P.slice(0, 6).filter(p => p.inHand).length;
    return { chips, bets, brought, inHand, total: chips + bets,
      ok: Math.abs(chips + bets - brought) < 1e-6 };
  };

  console.log('起手前：' + JSON.stringify(inv()));

  D.startHand();   // 只起一次手，之后靠程序自动续局

  let bad = 0, samples = 0, lastHandNo = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && samples < 25) {
    await sleep(60);
    const s = D.state();
    if (!s.handSettling) continue;
    // 局间窗口：等状态干净（无在局玩家人数、无桌上下注）后采样
    let clean = 0;
    for (let i = 0; i < 40 && clean < 3; i++) {
      await sleep(40);
      const v = inv();
      if (v.inHand === 0 && v.bets === 0) clean++; else clean = 0;
    }
    const v = inv();
    if (s.handNo === lastHandNo) continue;
    lastHandNo = s.handNo;
    samples++;
    const flag = v.ok ? '' : '  <<< 筹码泄漏 ' + (v.total - v.brought).toFixed(1);
    if (!v.ok) bad++;
    console.log('第' + String(s.handNo).padStart(3) + ' 局 | chips=' + v.chips +
      ' bet=' + v.bets + ' 合计=' + v.total + ' brought=' + v.brought +
      ' inHand=' + v.inHand + flag);
  }
  const v = inv();
  const okCount = samples - bad;
  console.log('\n采样 ' + samples + ' 局，泄漏 ' + bad + ' 局');
  console.log('末尾：' + JSON.stringify(v));
  console.log('不变量 chips + 桌上未收下注 == brought  → ' + (v.ok ? '守恒 ✓' : '不守恒 ✗'));
  console.log('\n=== 筹码守恒测试结果: ' + okCount + ' 通过, ' + bad + ' 失败 ===');
  srv.kill();
  process.exit(bad || samples < 5 ? 1 : 0);
})();
