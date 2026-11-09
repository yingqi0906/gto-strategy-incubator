/* 验证范围感知的蒙特卡洛胜率估算（修正版：卡牌必须取自 makeDeck，保证 id 一致） */
const C = require('./core.js');
const DECK = C.makeDeck();

function hand(str) {
  return str.split(' ').map(function (t) {
    const r = '23456789TJQKA'.indexOf(t[0]) + 2;
    const s = { s: 0, h: 1, d: 2, c: 3 }[t[1]];
    const c = DECK.find(function (x) { return x.r === r && x.s === s; });
    if (!c) throw new Error('bad card ' + t);
    return c;
  });
}

function avg(hole, nOpp, pctl, iters) {
  const N = iters || 1200;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += C.estimateWin(hole, [], nOpp, 100, [pctl]);
  return sum / N;
}
function avgFixed(hole, oppStr, iters) { // 对手固定手牌
  const opp = hand(oppStr);
  const known = {};
  hole.concat(opp).forEach(function (c) { known[c.id] = true; });
  const base = DECK.filter(function (c) { return !known[c.id]; });
  let win = 0;
  for (let t = 0; t < iters; t++) {
    C.shuffle(base);
    const comm = base.slice(0, 5);
    const c = C.cmpScore(C.best7(hole.concat(comm)).score, C.best7(opp.concat(comm)).score);
    if (c > 0) win += 1; else if (c === 0) win += 0.5;
  }
  return win / iters;
}

function chk(name, got, lo, hi) {
  const ok = got >= lo && got <= hi;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ': ' + got.toFixed(3) + (ok ? '' : '  (期望 ' + lo + '~' + hi + ')'));
  return ok;
}

let ok = true;
// 引擎基准抽查（教科书值）
ok &= chk('基准 AA vs KK', avgFixed(hand('Ah Ad'), 'Ks Kc', 400000), 0.80, 0.835);
ok &= chk('基准 AA vs 随机', avg(hand('Ah Ad'), 1, 1), 0.84, 0.87);
ok &= chk('基准 72o vs 随机', avg(hand('7h 2d'), 1, 1), 0.34, 0.42);

// 范围感知
ok &= chk('AA vs 3bet范围(6%)', avg(hand('Ah Ad'), 1, 0.06), 0.78, 0.87);
ok &= chk('72o vs 3bet范围(6%)', avg(hand('7h 2d'), 1, 0.06), 0.15, 0.24);
ok &= chk('72o vs 开池范围(25%)', avg(hand('7h 2d'), 1, 0.25), 0.20, 0.30);

const aksVsWide = avg(hand('As Ks'), 1, 0.65);
const aksVsTight = avg(hand('As Ks'), 1, 0.07);
ok &= chk('AKs vs 宽跟65% > vs 3bet7%', aksVsWide - aksVsTight, 0.04, 0.25);
console.log('  (AKs vs 宽跟 ' + aksVsWide.toFixed(3) + ' / vs 3bet ' + aksVsTight.toFixed(3) + ')');

// 多人混合
let m1 = 0, m2 = 0, N = 800;
for (let i = 0; i < N; i++) {
  m1 += C.estimateWin(hand('7h 2d'), [], 2, 80, [0.06, 1]);
  m2 += C.estimateWin(hand('7h 2d'), [], 2, 80, [0.06, 0.06]);
}
m1 /= N; m2 /= N;
ok &= chk('72o 双对手[6%,宽] > [6%,6%]', m1 - m2, 0.005, 0.30);
console.log('  (混合 ' + m1.toFixed(3) + ' / 双紧 ' + m2.toFixed(3) + ')');

// 翻牌圈带范围
let flop = 0;
for (let i = 0; i < N; i++) flop += C.estimateWin(hand('Ah Kh'), hand('Qh 7d 2c'), 1, 80, [0.3]);
flop /= N;
ok &= chk('AKs 在 Q72r 面对开池范围(30%)', flop, 0.40, 0.72);

console.log(ok ? '\n全部通过' : '\n存在失败项');
process.exit(ok ? 0 : 1);
