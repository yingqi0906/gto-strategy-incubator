/* 范围接入集成验证：在真实游戏流程中确认「范围权重表」被正确构建并逐街收窄。
   用法：node tools/range-integration.js

   重要：只调用一次 startHand()，之后靠游戏自动续局（D.startHand 反复调用会
   产生并发的 playHand，破坏牌面状态——这是本脚本早期版本的坑）。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const PORT = 18992;
const BASE = 'http://127.0.0.1:' + PORT;
const PF = require(path.join(__dirname, '..', 'postflop-engine.js'));

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
global.PokerCore = require(path.join(__dirname, '..', 'core.js'));
const realFetch = fetch;
global.fetch = function (u, o) { if (typeof u === 'string' && u[0] === '/') u = BASE + u; return realFetch(u, o); };
const html = fs.readFileSync(path.join(__dirname, '..', 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const P = T.players;
const D = T.debug;
const sleep = ms => new Promise(r => setTimeout(r, ms));

process.on('unhandledRejection', function (e) {
  console.log('  [未捕获异常] ' + (e && e.message));
  try {
    const st = D.state();
    console.log('    street=' + st.street + ' handSettling=' + st.handSettling);
    P.slice(0, 6).forEach(function (p, i) {
      console.log('    seat' + i + ' ' + p.name + ' inHand=' + p.inHand + ' hole=' + ((p.hole || []).length));
    });
  } catch (_) {}
});

(async function () {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
    { env: Object.assign({}, process.env, { PORT: String(PORT), MP_SEATS: '9' }), stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(BASE + '/'); up = true; } catch (e) { await sleep(100); } }
  await sleep(300);

  T.client.setMode('single', 0, '我');
  for (let i = 0; i < 9; i++) { P[i].seatType = null; P[i].name = ''; P[i].chips = 0; P[i].brought = 0; P[i].inHand = false; }
  for (let i = 0; i < 6; i++) { P[i].seatType = 'ai'; P[i].name = 'AI' + i; P[i].chips = 100; P[i].brought = 100; }

  /* 只手起一次，之后自动续局 */
  D.startHand();

  const stats = new Map(); // handNo -> { post, pre, sawPost }
  const t0 = Date.now();
  const LIMIT_MS = 110000;
  while (Date.now() - t0 < LIMIT_MS) {
    await sleep(18);
    const st = D.state();
    const hn = st.handNo;
    if (!hn) continue;
    let rec = stats.get(hn);
    if (!rec) { rec = { post: 1, pre: 1, sawPost: false }; stats.set(hn, rec); }
    if (st.street && st.street !== 'preflop') rec.sawPost = true;
    for (let q = 0; q < 6; q++) {
      const pl = P[q];
      if (!pl || !pl.range) continue;
      const w = PF.rangeWidth(pl.range);
      if (w < rec.pre) rec.pre = w;
      if (rec.sawPost && w < rec.post) rec.post = w;
    }
  }

  const hands = [...stats.values()];
  const total = hands.length;
  const preflopNarrowed = hands.filter(h => h.pre < 0.9).length;
  const postHands = hands.filter(h => h.sawPost);
  const everNarrowed = postHands.filter(h => h.post < 0.9).length;
  const minSeen = postHands.length ? Math.min.apply(null, postHands.map(h => h.post)) : 1;
  const avgMin = postHands.length ? postHands.reduce((a, h) => a + h.post, 0) / postHands.length : 1;

  console.log('='.repeat(84));
  console.log('范围接入集成验证（' + (LIMIT_MS / 1000) + 's 内共 ' + total + ' 手）');
  console.log('='.repeat(84));
  console.log('  翻前观察到范围收窄  : ' + preflopNarrowed + ' / ' + total + ' 手');
  console.log('  进入翻牌后的手数    : ' + postHands.length);
  console.log('  翻后观察到收窄      : ' + everNarrowed + ' / ' + postHands.length + ' 手');
  console.log('  翻后最小范围宽度    : ' + (minSeen * 100).toFixed(1) + '%');
  console.log('  翻后平均最小宽度    : ' + (avgMin * 100).toFixed(1) + '%');
  console.log('');

  let fail = 0;
  if (total < 3) { console.log('  FAIL  完成手数太少 (' + total + ')'); fail++; }
  else console.log('  PASS  游戏正常运行 (' + total + ' 手)');
  if (preflopNarrowed === 0) { console.log('  FAIL  翻前未观察到范围收窄'); fail++; }
  else console.log('  PASS  翻前范围收窄 (' + preflopNarrowed + '/' + total + ')');
  if (postHands.length === 0) console.log('  —     本次无手进入翻牌，翻后收窄由 tools/range-test.js 覆盖');
  else if (everNarrowed === 0) { console.log('  FAIL  翻后未观察到范围收窄'); fail++; }
  else console.log('  PASS  翻后范围确实收窄 (' + everNarrowed + '/' + postHands.length + ')');

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过'));
  srv.kill();
  process.exit(fail ? 1 : 0);
})();
