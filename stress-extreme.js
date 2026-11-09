/* 极端牌局压测：底池计算 / 分池 / 平局余数 / 发两次 / 筹码守恒
   —— 直击用户关心的"极端情况"
   用法：node stress-extreme.js  */
'use strict';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const failures = [];
function ok(c, name, extra) {
  if (c) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? ' | ' + extra : '')); console.error('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}

/* ---------- 无头 DOM ---------- */
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
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(t) { return new FakeEl(t); }, addEventListener() {},
  body: new FakeEl('body'), documentElement: new FakeEl('html'), hidden: false
};
global.window = global;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.sessionStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
global.PokerCore = require('./core.js');
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const C = global.PokerCore;
const P = T.players;
const R = T.rit;
const S = T.seats;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DECK = C.makeDeck();
function card(r, s) { return DECK.find(c => c.r === r && c.s === s); }

/* 布置 n 人牌局：chips/contrib/inHand/hole 由调用方给出 */
function setup(opts) {
  // opts: { seats: [{chip, contrib, inHand, hole:[[r,s],[r,s]], allIn}], button }
  P.forEach((p, i) => {
    p.seatType = null; p.name = ''; p.chips = 0; p.brought = 0; p.inHand = false;
    p.hole = []; p.bet = 0; p.totalContrib = 0; p.allIn = false; p.acted = false;
    p.winner = false; p.revealed = false; p.showFlags = [false, false]; p.showRevealed = [false, false];
  });
  opts.seats.forEach((s, i) => {
    if (!s) return;
    const p = P[i];
    p.seatType = i === (opts.hostSeat || 0) ? 'host' : 'ai';
    p.name = s.name || ('P' + i);
    p.chips = s.chip; p.brought = s.chip; p.inHand = !!s.inHand;
    p.totalContrib = s.contrib || 0;
    p.allIn = !!s.allIn;
    if (s.hole) p.hole = [card(s.hole[0][0], s.hole[0][1]), card(s.hole[1][0], s.hole[1][1])];
  });
  if (opts.button !== undefined) { T.client.setMode('single', 0, 'P0'); R.setButton(opts.button); }
}

function chipsOf() { return P.reduce((a, p) => a + (p.chips || 0), 0); }

console.log('=== 极端牌局压测 ===\n');

(async function () {

/* =========================================================
   一、平局 0.5 余数：前位（翻后行动顺序靠前）多拿
   ========================================================= */
console.log('--- 1. 平局余数分配（前位多拿 0.5）---');
{
  // 用户原例：小盲与按钮平分 100.5 底池 → 小盲 50.5、按钮 50
  // 构造：3 人桌，按钮=seat0，则 seat1=小盲，seat2=大盲。
  // 让 seat1(小盲) 与 seat0(按钮) 手牌完全相同（平局），底池 100.5
  const hole = [[14, 0], [13, 0]];  // AK
  // 公共牌不含任何面值相同时，AK 高牌；两人手牌相同 → 平局
  setup({
    hostSeat: 0, button: 0,
    seats: [
      { name: '按钮', chip: 0, contrib: 50.25, inHand: true, hole: hole },
      { name: '小盲', chip: 0, contrib: 50.25, inHand: true, hole: hole },
      { name: '大盲', chip: 0, contrib: 0, inHand: false }
    ]
  });
  R.setCollectedPot(100.5);
  const board = [card(2, 1), card(7, 2), card(9, 3), card(11, 0), card(4, 1)];
  const r = R.settlePots(board);
  const sbChips = P[1].chips, btnChips = P[0].chips;
  ok(Math.abs(sbChips - 50.5) < 1e-6, '小盲（前位）拿 50.5（实际 ' + sbChips + '）');
  ok(Math.abs(btnChips - 50) < 1e-6, '按钮（后位）拿 50（实际 ' + btnChips + '）');
  ok(Math.abs(chipsOf() - 100.5) < 1e-6, '派彩总额 = 底池 100.5（实际 ' + chipsOf() + '）');
}

/* 4 人平局：余数只给最前位 1 人 */
{
  const hole = [[14, 0], [13, 0]];
  setup({
    hostSeat: 0, button: 0,
    seats: [
      { name: '按钮', chip: 0, contrib: 25.375, inHand: true, hole: hole },
      { name: '小盲', chip: 0, contrib: 25.375, inHand: true, hole: hole },
      { name: '大盲', chip: 0, contrib: 25.375, inHand: true, hole: hole },
      { name: '枪口', chip: 0, contrib: 25.375, inHand: true, hole: hole }
    ]
  });
  R.setCollectedPot(101.5);
  const board = [card(2, 1), card(7, 2), card(9, 3), card(11, 0), card(4, 1)];
  R.settlePots(board);
  // 101.5 / 4 = 25.375 → 每人 25，余 1.5 → 最前位多拿
  const sb = P[1].chips;
  const total = chipsOf();
  ok(Math.abs(total - 101.5) < 1e-6, '4 人平局派彩总额守恒 = 101.5（实际 ' + total + '）');
  ok(sb >= 25.5, '小盲（最前位）拿到余数（实际 ' + sb + '）');
  ok(P[1].chips >= P[0].chips, '前位 ≥ 后位');
}

/* =========================================================
   二、多路 allin 边池：赢家不同 → 各自按资格拿
   ========================================================= */
console.log('\n--- 2. 多路 allin 边池 ---');
{
  // 3 人 allin：contrib 50 / 100 / 200
  //  主池 150（三人）→ 短码(seat0)最强 → 全拿
  //  边池 100（seat1、seat2）→ seat2 强于 seat1
  //  未遇注 100（seat2）→ 退还 seat2
  setup({
    hostSeat: 0, button: 0,
    seats: [
      { name: '短码', chip: 0, contrib: 50, inHand: true, allIn: true, hole: [[14, 0], [14, 1]] },  // AA
      { name: '中码', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[13, 0], [13, 1]] }, // KK
      { name: '大码', chip: 0, contrib: 200, inHand: true, allIn: true, hole: [[2, 0], [7, 1]] }    // 72o
    ]
  });
  R.setCollectedPot(350);
  const board = [card(3, 1), card(9, 2), card(11, 3), card(5, 0), card(4, 1)]; // 无 A/K
  const r = R.settlePots(board);
  // 短码 AA 拿主池 150；中码 KK 拿边池 100（seat1,2 中 KK 胜）；未遇注 100 退还大码
  ok(Math.abs(P[0].chips - 150) < 1e-6, '短码(AA) 赢主池 150（实际 ' + P[0].chips + '）');
  ok(Math.abs(P[1].chips - 100) < 1e-6, '中码(KK) 赢边池 100（实际 ' + P[1].chips + '）');
  ok(Math.abs(P[2].chips - 100) < 1e-6, '大码(72o) 收回未遇注 100（实际 ' + P[2].chips + '）');
  ok(Math.abs(chipsOf() - 350) < 1e-6, '边池派彩总额守恒 = 350（实际 ' + chipsOf() + '）');
  ok(P.slice(0, 3).every(p => p.chips >= 0), '无负筹码');
}

/* 4 人两档 allin + 一人弃牌留死钱 */
console.log('\n--- 3. 死钱 + 两档 allin ---');
{
  setup({
    hostSeat: 0, button: 0,
    seats: [
      { name: '死钱', chip: 0, contrib: 20, inHand: false },                                     // 翻前弃牌留 20
      { name: 'A', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[14, 0], [13, 0]] }, // AK
      { name: 'B', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[14, 1], [13, 1]] }, // AK 同花不同 → 平局
      { name: 'C', chip: 0, contrib: 60, inHand: true, allIn: true, hole: [[2, 2], [3, 2]] }     // 小牌
    ]
  });
  R.setCollectedPot(280);
  const board = [card(4, 0), card(8, 1), card(10, 2), card(5, 3), card(6, 0)];
  R.settlePots(board);
  // 主池：所有未弃牌且有贡献的层 —— A/B/C 三层各 [0..60] → 主池 60*3 + 死钱 20 = 200？按 buildPots 口径
  const total = chipsOf();
  ok(Math.abs(total - 280) < 1e-6, '死钱全数进入底池并派出（总额 ' + total + ' = 280）');
  ok(P[0].chips === 0, '已弃牌玩家不参与分池（chips 仍为 0）');
  ok(P[1].chips > 0 && P[2].chips > 0, '平局双方均有派彩');
}

/* =========================================================
   四、发两次（RIT）余数：全局缺口补前位
   ========================================================= */
console.log('\n--- 4. 发两次（RIT）余数分配 ---');
{
  const split = R.splitPot;
  // 两轮赢家相同、金额为 100.5 → 一人通吃 100.5
  let pay = split(100.5, [[1], [1]], [1, 2, 0], 0);
  ok(Math.abs(pay[1] - 100.5) < 1e-6, 'RIT 一人两轮通吃 100.5（实际 ' + pay[1] + '）');

  // 两轮分别被不同人赢 → 各 50 + 余 0.5 给前位
  R.setButton(0);
  pay = split(101, [[1], [2]], [0, 1, 2], 0);
  const sum = Object.keys(pay).reduce((a, k) => a + pay[k], 0);
  ok(Math.abs(sum - 101) < 1e-6, 'RIT 派彩总额守恒 = 101（实际 ' + sum + '）');

  // 平局 + 奇数池：小盲与按钮平分，小盲（前位）多拿
  R.setButton(0);
  pay = split(100.5, [[1, 0], [1, 0]], [0, 1, 2], 0);
  const sum2 = Object.keys(pay).reduce((a, k) => a + pay[k], 0);
  ok(Math.abs(sum2 - 100.5) < 1e-6, 'RIT 平局派彩总额守恒 = 100.5（实际 ' + sum2 + '）');
  ok(pay[1] >= pay[0], 'RIT 平局中前位（小盲 seat1）≥ 后位（按钮 seat0）：' + pay[1] + ' vs ' + pay[0]);

  // 大量随机池额：总额必须守恒
  let bad = 0;
  for (let amt = 1; amt <= 300; amt += 0.5) {
    for (const combo of [[[0], [1]], [[0, 1], [0, 1]], [[0], [1, 2]]]) {
      const p = split(amt, combo, [0, 1, 2], 0);
      const s = Object.keys(p).reduce((a, k) => a + p[k], 0);
      if (Math.abs(s - amt) > 1e-6) { bad++; if (bad < 4) console.error('    池额 ' + amt + ' 组合 ' + JSON.stringify(combo) + ' 派彩 ' + s); }
    }
  }
  ok(bad === 0, '600 组 RIT 池额×赢家组合全部守恒（异常 ' + bad + ' 组）');
}

/* =========================================================
   五、0.5 粒度极端：极小池 / 极大池 / 全员平分
   ========================================================= */
console.log('\n--- 5. 0.5 粒度极端值 ---');
{
  // 3 人均分 0.5 底池：不可能每人 >0，应给前位 0.5、其余 0
  setup({
    hostSeat: 0, button: 0,
    seats: [
      { name: '按钮', chip: 0, contrib: 0.165, inHand: true, hole: [[14, 0], [13, 0]] },
      { name: '小盲', chip: 0, contrib: 0.165, inHand: true, hole: [[14, 0], [13, 0]] },
      { name: '大盲', chip: 0, contrib: 0.17, inHand: true, hole: [[14, 0], [13, 0]] }
    ]
  });
  R.setCollectedPot(0.5);
  const board = [card(2, 1), card(7, 2), card(9, 3), card(11, 0), card(4, 1)];
  R.settlePots(board);
  const total = chipsOf();
  ok(Math.abs(total - 0.5) < 1e-6, '极小池 0.5 三人平局派彩守恒（实际 ' + total + '）');
  ok(P[1].chips === 0.5, '极小池全给最前位（小盲），其余为 0');

  // 6 人均分奇数池
  const hole = [[14, 0], [13, 0]];
  setup({
    hostSeat: 0, button: 0,
    seats: [0, 1, 2, 3, 4, 5].map(i => ({ name: 'P' + i, chip: 0, contrib: 16.75, inHand: true, hole: hole }))
  });
  R.setCollectedPot(100.5);
  R.settlePots(board);
  const t6 = chipsOf();
  ok(Math.abs(t6 - 100.5) < 1e-6, '6 人均分 100.5 派彩守恒（实际 ' + t6 + '）');
  // 翻后顺序：seat0=按钮(最后)，seat1=小盲(最前) → 余数给 seat1
  ok(P[1].chips >= P[2].chips && P[1].chips >= P[0].chips, '6 人平局余数给最前位（小盲）');
  ok(P.slice(0, 6).every(p => p.chips >= 0), '无负筹码');
}

/* =========================================================
   六、发两次 + 边池组合（两轮分别结算）
   ========================================================= */
console.log('\n--- 6. 发两次与边池组合 ---');
{
  // 3 人 allin 50/100/200，两轮公共牌不同 → 各自按轮结算半池
  setup({
    hostSeat: 0, button: 0,
    seats: [
      { name: '短码', chip: 0, contrib: 50, inHand: true, allIn: true, hole: [[14, 0], [14, 1]] },   // AA
      { name: '中码', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[13, 0], [13, 1]] },  // KK
      { name: '大码', chip: 0, contrib: 200, inHand: true, allIn: true, hole: [[12, 0], [12, 1]] }   // QQ
    ]
  });
  R.setCollectedPot(350);
  const b1 = [card(2, 1), card(7, 2), card(9, 3), card(11, 0), card(4, 1)];  // AA 胜
  R.settlePots(b1, 0.5, '第1次');
  const after1 = chipsOf();
  const b2 = [card(13, 2), card(13, 3), card(2, 2), card(3, 2), card(4, 2)]; // KK 中三条胜
  R.settlePots(b2, 0.5, '第2次');
  const after2 = chipsOf();
  ok(Math.abs(after2 - 350) < 1e-6, 'RIT 两轮合计派彩 = 350（实际 ' + after2 + '）');
  ok(Math.abs(after1 - 175) < 1e-6, '第 1 轮派出一半 175（实际 ' + after1 + '）');
}

/* =========================================================
   七、极端：全员 allin 同额 + 一人弃牌
   ========================================================= */
console.log('\n--- 7. 全员 allin 同额 + 死钱 ---');
{
  setup({
    hostSeat: 0, button: 0,
    seats: [
      { name: 'A', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[14, 0], [13, 0]] },
      { name: 'B', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[14, 1], [12, 1]] },
      { name: 'C', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[11, 2], [10, 2]] },
      { name: 'D', chip: 0, contrib: 100, inHand: true, allIn: true, hole: [[9, 3], [8, 3]] },
      { name: '弃牌', chip: 0, contrib: 30, inHand: false },
      { name: '弃牌2', chip: 0, contrib: 15, inHand: false }
    ]
  });
  R.setCollectedPot(445);
  const board = [card(4, 0), card(5, 1), card(6, 2), card(7, 3), card(8, 0)]; // A: AK 高牌；D: 9,8 + 8 → 一对 8 胜
  R.settlePots(board);
  const total = chipsOf();
  ok(Math.abs(total - 445) < 1e-6, '6 人（4 allin + 45 死钱）派彩守恒 = 445（实际 ' + total + '）');
  ok(P[3].chips === 445, '唯一赢家（D 一对 8）独得全部 445（实际 ' + P[3].chips + '）');
}

/* =========================================================
   八、连续 300 手随机跑牌：全局守恒（本地 6 人 AI）
   ========================================================= */
console.log('\n--- 8. 随机连跑守恒（本地 6 人 AI，程序自带续局）---');
{
  T.client.setMode('single', 0, '我');
  P.forEach(p => { p.seatType = null; p.name = ''; p.chips = 0; p.brought = 0; p.inHand = false; });
  for (let i = 0; i < 6; i++) { P[i].seatType = 'ai'; P[i].name = 'AI' + i; P[i].chips = 100; P[i].brought = 100; }
  const brought0 = P.slice(0, 6).reduce((a, p) => a + p.brought, 0);
  T.debug.startHand();
  let sampled = 0, bad = 0, lastNo = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && sampled < 12) {
    await sleep(60);
    const st = T.debug.state();
    if (!st.handSettling || st.handNo === lastNo) continue;
    // 等桌上下注收拢（此时筹码要么在玩家手上，要么在中央底池 collectedPot）
    for (let i = 0; i < 40; i++) {
      await sleep(40);
      const bets = P.slice(0, 6).reduce((a, p) => a + (p.bet || 0), 0);
      if (bets === 0) break;
    }
    lastNo = st.handNo; sampled++;
    const chips = P.slice(0, 6).reduce((a, p) => a + p.chips, 0);
    const bets = P.slice(0, 6).reduce((a, p) => a + (p.bet || 0), 0);
    const brought = P.slice(0, 6).reduce((a, p) => a + p.brought, 0);
    const pot = T.debug.collectedPot();
    // 局间窗口存在两种合法状态（showHandEnd/finishFoldWin 先置 handSettling=true，之后才派彩）：
    //   ① 派彩已完成：chips + bets == brought
    //   ② 派彩尚未完成：钱还在中央底池 → chips + bets + collectedPot == brought
    // 两者任一成立即守恒；都失败才是真异常（旧断言只认 ① → 会在派彩动画中途误报）。
    if (Math.abs(chips + bets - brought) > 1e-6 && Math.abs(chips + bets + pot - brought) > 1e-6) {
      bad++;
      console.error('    第' + st.handNo + '局不守恒：chips=' + chips + ' bet=' + bets +
        ' pot=' + pot + ' 合计=' + (chips + bets) + '/' + (chips + bets + pot) + ' brought=' + brought);
    }
  }
  ok(sampled >= 5, '随机连跑采样 ≥5 局（实际 ' + sampled + ' 局）');
  ok(bad === 0, '每局 chips + 桌上下注 == brought 守恒（异常 ' + bad + ' 局）');
  const broughtE = P.slice(0, 6).reduce((a, p) => a + p.brought, 0);
  ok(broughtE >= brought0, '带入总额只增不减（' + brought0 + ' → ' + broughtE + '）');
}

console.log('\n========================================');
console.log('极端牌局压测：' + pass + ' 通过, ' + fail + ' 失败');
if (fail) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)); }
console.log('========================================');
process.exit(fail ? 1 : 0);

})();
