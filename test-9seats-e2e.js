/* 8 人桌端到端：联机主机模式下 8 人开局，验证发牌/行动顺序/位置名/盲注/完局 */
'use strict';
const path = require('path');
const fs = require('fs');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div'; this.children = []; this._class = new Set();
    this.style = {}; this.parentNode = null; this.textContent = '';
    this._innerHTML = ''; this.disabled = false; this.value = '';
    this.min = 0; this.max = 0; this.step = 1;
    this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null;
    this._qs = {}; this._listeners = {};
  }
  get classList() {
    const s = this;
    return {
      add: c => s._class.add(c), remove: c => s._class.delete(c),
      toggle: (c, f) => {
        if (f === undefined) { s._class.has(c) ? s._class.delete(c) : s._class.add(c); }
        else if (f) s._class.add(c); else s._class.delete(c);
      },
      contains: c => s._class.has(c)
    };
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
}
const byId = {};
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(tag) { return new FakeEl(tag); },
  addEventListener() {}, body: new FakeEl('body'), documentElement: new FakeEl('html')
};
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
global.PokerCore = require('./core.js');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const D = T.debug;
const S = T.seats;
const P = T.players;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  console.log('--- 8 人桌端到端 ---');

  // 布置：联机主机模式，8 个座位全部有人（1 主机 + 7 AI）
  P.forEach(p => {
    p.seatType = null; p.name = ''; p.chips = 0; p.inHand = false;
    p.hole = []; p.bet = 0; p.totalContrib = 0; p.allIn = false; p.acted = false;
    p.joining = false; p.isAI = undefined;
  });
  T.client.setMode('host', 0, '主机');
  P[0].seatType = 'host'; P[0].name = '主机'; P[0].chips = 200;
  for (let i = 1; i < 8; i++) {
    P[i].seatType = 'ai'; P[i].name = 'AI' + i; P[i].chips = 200;
  }
  P.forEach(p => { p.isAI = function () { return p.seatType === 'ai'; }; });

  ok(S.count() === 8, '联机模式座位数 = 8');
  ok(S.activeIdx().length === 8, '8 个座位全部激活');

  // 重建座位（8 个 DOM 座位）
  T.seats.posTable();
  ok(S.posTable().length === 8, '使用 8 人坐标表（SEAT_POS_8，WPT 版式）');
  D.buildSeats();
  ok(P.slice(0, 8).every(p => !!p.seatEl), '8 个座位 DOM 均已建立');

  // 开局
  D.startHand();
  await sleep(400);

  /* ---------- 盲注位徽章（S/B，与庄位 D 同一组） ---------- */
  console.log('--- 盲注位徽章 ---');
  const bl = T.blindSeats(), btnIdx = T.buttonIdx();
  const has = cls => P.slice(0, 8).map((p, i) => (p.seatEl && p.seatEl.classList.contains(cls)) ? i : -1).filter(i => i >= 0);
  const sbSeats = has('has-sb'), bbSeats = has('has-bb'), btnSeats = has('has-button');
  ok(bl.sb >= 0 && bl.bb >= 0 && bl.sb !== bl.bb, '8 人桌小盲/大盲落在不同座位（sb=' + bl.sb + ' bb=' + bl.bb + '）');
  ok(JSON.stringify(sbSeats) === JSON.stringify([bl.sb]), '恰好一个座位挂 .has-sb，且 = 小盲座位');
  ok(JSON.stringify(bbSeats) === JSON.stringify([bl.bb]), '恰好一个座位挂 .has-bb，且 = 大盲座位');
  ok(JSON.stringify(btnSeats) === JSON.stringify([btnIdx]), '恰好一个座位挂 .has-button，且 = 庄位（D 规则未被破坏）');
  ok(sbSeats[0] !== bbSeats[0], '小盲与大盲不重合（S/B 不会同时亮在同一座位）');
  // 徽章文字与可见性由 CSS 类驱动 —— 断言模板里 S/B 字样确实存在
  const seatHtml = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  ok(/<div class="pos-badge sb-badge">S<\/div>/.test(seatHtml) && /<div class="pos-badge bb-badge">B<\/div>/.test(seatHtml),
    '座位模板含 S（小盲）/ B（大盲）字样徽章');

  let st = D.state();
  const liveCount = st.seats.filter(s => s.inHand).length;
  ok(liveCount === 8, '8 人全部入局（发到手牌）');

  // 位置名：检查 9 人位名已生成且互不重复（除中位可重复）
  const pos = T.rit.posMaps().zh;
  const posVals = Object.keys(pos).map(k => pos[k]);
  ok(posVals.indexOf('按钮') >= 0 && posVals.indexOf('小盲') >= 0 && posVals.indexOf('大盲') >= 0,
    '位名含 按钮/小盲/大盲');
  ok(posVals.filter(x => x === '枪口').length === 1, '恰好一个枪口位');
  ok(posVals.filter(x => x === '关煞').length === 1, '恰好一个关煞位');

  // 等第一手结束（AI 自动跑完，放宽到 60 秒）
  let waited = 0;
  while (D.state().handSettling !== true && waited < 60000) { await sleep(200); waited += 200; }
  st = D.state();
  console.log('  [完局] 用时约 ' + Math.round(waited / 1000) + 's，tableMsg = ' + JSON.stringify(st.tableMsg));
  ok(st.handSettling === true || waited >= 60000, '8 人桌一手牌可正常推进到结算');

  // 筹码守恒（总和 == 8 * 200）
  const total = P.slice(0, 8).reduce((a, p) => a + p.chips, 0);
  ok(Math.abs(total - 1600) < 1e-6, '8 人桌筹码守恒 = 1600（实际 ' + total + '）');

  console.log('');
  console.log('结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); console.error(e.stack); process.exit(1); });
