/* 前位多拿（余数 0.5）口径：按翻后行动顺序 —— 小盲最前位，按钮最后位（与座位号无关）
   覆盖：① ritSplitPot 除不尽余数归前位；② settlePots 平局余数归前位；③ postflopRank 顺序正确 */
'use strict';
const path = require('path');
const fs = require('fs');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(a, b, name) { ok(a === b, name + '（实际 ' + a + '，期望 ' + b + '）'); }

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
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

console.log('--- 源码级断言 ---');
ok(/function postflopRank\(idx\)/.test(script), '定义 postflopRank（按翻后行动顺序排名）');
ok(/function sortByPostflop\(a, b\)/.test(script), '定义 sortByPostflop 排序器');
ok(!/sorted = w\.slice\(\)\.sort\(function \(a, b\) \{ return a - b; \}\)/.test(script),
  'ritSplitPot 平局余数不再按座位号排序');
ok(!/sorted = winners\.slice\(\)\.sort\(function \(a, b\) \{ return a - b; \}\)/.test(script),
  'settlePots 平局余数不再按座位号排序');

eval(script);
const T = global.window.__PokerTest;
const R = T.rit;
const P = T.players;

function setup() {
  P.forEach(p => { p.seatType = null; p.name = ''; p.chips = 0; p.inHand = false; p.hole = []; });
  T.client.setMode('single', 0, '我');
  for (let i = 0; i < 6; i++) { P[i].seatType = 'human'; P[i].name = 'S' + i; P[i].chips = 100; P[i].inHand = true; }
}

console.log('--- 功能级断言：翻后行动顺序 ---');
setup();
// 6 人桌，按钮 = 座位 0 → 翻后顺序：1(小盲) 2(大盲) 3(枪口) 4 5 0(按钮最后)
R.setButton(0);
const pos = R.posMaps().zh;
eq(pos[0], '按钮', '座位0 是按钮（翻后最后）');
eq(pos[1], '小盲', '座位1 是小盲（翻后最前）');
eq(pos[2], '大盲', '座位2 是大盲');
console.log('  排名: ' + [0, 1, 2, 3, 4, 5].map(i => 'S' + i + '=' + R.postflopRank(i)).join(' '));
eq(R.postflopRank(1), 0, '小盲(座位1) 排名 0 —— 最前位');
eq(R.postflopRank(0), 5, '按钮(座位0) 排名 5 —— 最后位');
ok(R.postflopRank(1) < R.postflopRank(2) && R.postflopRank(2) < R.postflopRank(5) &&
   R.postflopRank(5) < R.postflopRank(0), '排名随翻后行动顺序递增（小盲<大盲<…<按钮）');

// 换按钮位验证：按钮 = 座位 3 → 小盲 = 座位 4
R.setButton(3);
eq(R.postflopRank(4), 0, '按钮在座位3时，座位4(小盲) 排名 0');
eq(R.postflopRank(3), 5, '按钮在座位3时，座位3(按钮) 排名 5');
R.setButton(0);

console.log('--- 功能级断言：用户给定例子（小盲 vs 按钮 平分 100.5）---');
// 小盲 = 座位1，按钮 = 座位0。两轮各赢一次：第1轮 winnerRound[0]=[1]，第2轮 winnerRound[1]=[0]
// 底池 100.5 → 每半 50.25，取整 50；合计 100，缺 0.5 → 归前位（小盲 座位1）
let pay = R.splitPot(100.5, [[1], [0]], [0, 1]);
console.log('  pay =', JSON.stringify(pay));
eq(pay[1], 50.5, '小盲(座位1) 拿 50.5 —— 前位多拿 0.5');
eq(pay[0], 50, '按钮(座位0) 拿 50');
eq(pay[1] + pay[0], 100.5, '总额守恒 = 100.5');

// 反向：即便"按钮"赢的是第一轮，余数也应给前位（小盲）
pay = R.splitPot(100.5, [[0], [1]], [0, 1]);
eq(pay[1], 50.5, '轮次对调后 小盲仍拿 50.5（余数不随轮次，只随位置）');
eq(pay[0], 50, '轮次对调后 按钮仍拿 50');

console.log('--- 功能级断言：翻后顺序 ≠ 座位号 的场景 ---');
// 按钮 = 座位 4 → 翻后顺序：5(小盲) 0 1 2 3(按钮)
R.setButton(4);
// 座位5(小盲) 与 座位2 各赢一轮，底池 101.5
pay = R.splitPot(101.5, [[5], [2]], [2, 5]);
console.log('  pay =', JSON.stringify(pay));
eq(pay[5], 51, '小盲(座位5，座位号更大) 拿 51 —— 按位置而非座位号');
eq(pay[2], 50.5, '座位2 拿 50.5');
// 座位号小但不是前位（座位0 在大盲位，座位5 是小盲）
pay = R.splitPot(100.5, [[0], [5]], [0, 5]);
eq(pay[5], 50.5, '座位5(小盲) 拿 50.5');
eq(pay[0], 50, '座位0(大盲) 拿 50 —— 座位号小但位置靠后，不多拿');
R.setButton(0);

console.log('--- 功能级断言：均分无余数 ---');
pay = R.splitPot(100, [[1], [0]], [0, 1]);
eq(pay[1], 50, '底池 100 时 小盲拿 50');
eq(pay[0], 50, '底池 100 时 按钮拿 50');

console.log('--- 功能级断言：某轮平局，平局内余数归前位 ---');
// 座位1(小盲) 与 座位2(大盲) 在第1轮平局，第2轮座位0(按钮)胜
// 底池 50.5 → 每半 25.25 取整 25 → 第2轮 25 给按钮；第1轮 25 由小盲+大盲均分（各12.5）
// 合计 25+25=50，缺 0.5 → 归全局前位（小盲 座位1）
pay = R.splitPot(50.5, [[1, 2], [0]], [0, 1, 2]);
console.log('  pay =', JSON.stringify(pay));
eq(pay[1] + pay[2] + pay[0], 50.5, '总平局+单胜场景总额守恒');
ok(pay[1] >= pay[2], '平局内 前位(小盲) 不少于 后位(大盲)');

console.log('--- 功能级断言：settlePots 平局时余数归前位 ---');
// 小盲(座位1) 与 按钮(座位0) 用相同牌力平局 → 主池余数归前位（座位1 小盲）
R.setButton(0);
P.forEach(p => { p.chips = 0; p.bet = 0; p.inHand = true; p.totalContrib = 0; p.hole = []; });
// 两人同牌力（同为 A♠A♥ + 公共牌无关），各投入 50.25 → 底池 100.5
const dk = PokerCore.makeDeck();
const pick = (r, s) => dk.find(c => c.r === r && c.s === s);
const holeA = [pick(14, 0), pick(14, 1)];   // A♠ A♥
P[1].hole = holeA.slice(); P[0].hole = holeA.slice();
P[1].totalContrib = 50.25; P[0].totalContrib = 50.25;
for (let i = 2; i < 6; i++) { P[i].inHand = false; P[i].totalContrib = 0; }
const board = [pick(2, 3), pick(7, 2), pick(9, 1), pick(11, 0), pick(3, 3)];
const res = R.settlePots(board, 1, '');
console.log('  座位筹码: S0(按钮)=' + P[0].chips + '  S1(小盲)=' + P[1].chips);
eq(P[1].chips, 50.5, 'settlePots 平局余数归前位：小盲(座位1) 拿 50.5');
eq(P[0].chips, 50, 'settlePots 平局余数归前位：按钮(座位0) 拿 50');

console.log('');
console.log('结果：' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
