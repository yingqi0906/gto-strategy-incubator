/* 极端尺度 / 极端后手下的应对测试
   ------------------------------------------------------------
   回答"对手用完全不合 GTO 的策略（超池 10 倍 donk、超深后手）时 AI 怎么办"：
   纯 GTO = 纳什策略，不需要知道对手在干什么。但实现上必须保证
   任意尺度下公式仍然成立、没有钳位/取整 bug。本脚本检查这些。

   用法：node tools/extreme-test.js */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'core.js'));
const PF = require(path.join(__dirname, '..', 'postflop-engine.js'));

const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT = { s: 0, h: 1, d: 2, c: 3 };
function card(c) { return { r: RANK[c[0]], s: SUIT[c[1]], id: RANK[c[0]] * 4 + SUIT[c[1]] }; }
function cards(s) { return s.split(' ').filter(Boolean).map(card); }

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra ? '   [' + extra + ']' : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* 固定牌局，多次采样统计行动分布（引擎内部用 Math.random） */
function sampleActions(holeStr, boardStr, opt, n) {
  n = n || 400;
  const hole = cards(holeStr), board = cards(boardStr);
  const tally = {}; let bad = 0;
  for (let i = 0; i < n; i++) {
    const a = C.aiDecide(Object.assign({
      hole, community: board, nOpp: 1, bb: 2, oppPctls: [1]
    }, opt));
    if (!a || !a.type) { bad++; continue; }
    tally[a.type] = (tally[a.type] || 0) + 1;
    (a.opts || []).forEach(function (o) {
      if (typeof o.prob !== 'number' || !isFinite(o.prob) || o.prob < -1e-9 || o.prob > 1 + 1e-9) bad++;
      if (o.act && o.act.to !== undefined && (!isFinite(o.act.to) || o.act.to < 0)) bad++;
    });
  }
  const rate = {};
  Object.keys(tally).forEach(k => { rate[k] = tally[k] / (n - bad || n); });
  return { rate, bad, n };
}

console.log('='.repeat(76));
console.log('极端尺度 / 后手下的策略健壮性');
console.log('='.repeat(76));

const BOARD = 'Ad Ks Qc';            // A 高干燥面
const PFCTX = { raises: 1, opener: 'BTN', firstCaller: 'BB', lastRaiser: 'BTN', posName: 'BTN' };

console.log('\n[1] 面对不同尺度的下注：弃牌率应单调上升（尺度越大越该弃）');
const sizes = [0.33, 1, 3, 10];
const folds = [];
for (const s of sizes) {
  const potBefore = 100;
  const betOver = potBefore * s;
  const pot = potBefore + betOver;           // 页面口径：pot 含对手这一注
  const r = sampleActions('9h 9d', BOARD, {
    toCall: betOver, pot: pot, currentBet: betOver, bet: 0, chips: 200, effStack: 200,
    posName: 'BTN', pf: PFCTX, hasInitiative: false
  }, 400);
  folds.push(r.rate.fold || 0);
  const mdf = potBefore / (potBefore + betOver);
  const odds = betOver / (pot + betOver);
  console.log('   下注 ' + (s + 'x').padStart(5) + ' 池  →  MDF ' + (mdf * 100).toFixed(1) + '%  pot odds ' +
    (odds * 100).toFixed(1) + '%  弃牌率 ' + ((r.rate.fold || 0) * 100).toFixed(1) + '%' +
    (r.bad ? '  (异常项 ' + r.bad + ')' : ''));
  ok(r.bad === 0, '下注 ' + s + 'x 池：无 NaN / 越界概率');
}
ok(folds[0] < folds[1] && folds[1] <= folds[2] && folds[2] <= folds[3],
  '弃牌率随下注尺度单调不减', folds.map(f => (f * 100).toFixed(0) + '%').join(' → '));
ok(folds[3] > 0.6, '10x 超池下注面对中等手：弃牌率 > 60%（MDF 仅 9%）',
  (folds[3] * 100).toFixed(1) + '%');

console.log('\n[2] 10x 超池下注：空气应几乎全弃、坚果应几乎不弃');
const air = sampleActions('2h 3d', 'Ad Ks Qc', {
  toCall: 1000, pot: 1100, currentBet: 1000, bet: 0, chips: 200, effStack: 200,
  posName: 'BB', pf: PFCTX, hasInitiative: false
}, 400);
const nuts = sampleActions('Ac Ah', 'Ad Ks Qc', {
  toCall: 1000, pot: 1100, currentBet: 1000, bet: 0, chips: 200, effStack: 200,
  posName: 'BB', pf: PFCTX, hasInitiative: false
}, 400);
console.log('   空气 2h3d 弃牌率 ' + ((air.rate.fold || 0) * 100).toFixed(1) + '%' +
  '   坚果 AcAh 弃牌率 ' + ((nuts.rate.fold || 0) * 100).toFixed(1) + '%');
ok((air.rate.fold || 0) > 0.85, '空气面对 10x 超池：弃牌率 > 85%', (air.rate.fold * 100).toFixed(1) + '%');
ok((nuts.rate.fold || 0) < 0.1, '坚果面对 10x 超池：弃牌率 < 10%', ((nuts.rate.fold || 0) * 100).toFixed(1) + '%');
ok(air.bad === 0 && nuts.bad === 0, '无 NaN / 越界概率');

console.log('\n[3] 超深后手（500bb）：SPR 档位与尺度仍健全');
const deepBand = PF.sprBand(500, 12);
ok(deepBand === 'deep', 'SPR = 500/12 ≈ 41.7 → 档位 deep', deepBand);
const deep = sampleActions('Ks Kc', 'Ad Ks Qc', {
  toCall: 0, pot: 12, currentBet: 0, bet: 0, chips: 1000, effStack: 1000,
  posName: 'BTN', pf: PFCTX, hasInitiative: true
}, 400);
ok(deep.bad === 0, '深筹码下注无 NaN / 越界');
console.log('   深筹码（500bb）行动分布：' + Object.keys(deep.rate).map(k => k + ' ' + (deep.rate[k] * 100).toFixed(0) + '%').join('  '));

console.log('\n[4] 跟注额超过自身后手（对手全下超出）：应被裁剪且不出 NaN');
const short = sampleActions('Kh Qd', 'Ad Ks Qc', {
  toCall: 900, pot: 1000, currentBet: 900, bet: 0, chips: 30, effStack: 30,
  posName: 'BB', pf: PFCTX, hasInitiative: false
}, 400);
ok(short.bad === 0, '短码面对超额下注：无 NaN / 负数金额');
console.log('   短码（后手 30）面对 900：' + Object.keys(short.rate).map(k => k + ' ' + (short.rate[k] * 100).toFixed(0) + '%').join('  '));

console.log('\n[5] 我们主动用超大尺度下注：诈唬比例应受 alpha 约束（不失控）');
const bluff = sampleActions('2h 3d', 'Ad Ks Qc', {
  toCall: 0, pot: 100, currentBet: 0, bet: 0, chips: 400, effStack: 400,
  posName: 'BTN', pf: PFCTX, hasInitiative: true
}, 400);
const bluffRate = bluff.rate.raise || 0;
console.log('   纯空气在有主动权时下注率 ' + (bluffRate * 100).toFixed(1) + '%');
ok(bluffRate <= 0.95, '空气下注率不失控（≤95%）', (bluffRate * 100).toFixed(1) + '%');
ok(bluff.bad === 0, '无 NaN / 越界概率');

console.log('\n' + '='.repeat(76));
console.log('极端尺度测试：' + pass + ' 通过, ' + fail + ' 失败');
console.log('='.repeat(76));
process.exit(fail ? 1 : 0);
