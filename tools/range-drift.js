/* 范围收窄误差诊断（改造前口径存档）
   ------------------------------------------------------------
   本脚本量化"用单一百分位标量收窄范围"相比"真实逐街收窄"造成的 equity 偏差，
   用于说明为什么必须把范围升级为权重表。
   **当前引擎已改用权重表（见 postflop-engine.js 的 filterRange），
   本脚本的数值描述的是改造前行为，作为问题留档。**
   当前状态的验证请看 tools/range-test.js。
   用法：node tools/range-drift.js */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'core.js'));

const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT = { s: 0, h: 1, d: 2, c: 3 };
function card(c) { return { r: RANK[c[0]], s: SUIT[c[1]], id: RANK[c[0]] * 4 + SUIT[c[1]] } }
function cards(s) { return s.split(' ').filter(Boolean).map(card); }

/* 用 estimateWin 估算"我方手牌 vs 指定宽度范围"的 equity */
function eq(holeStr, boardStr, width, nOpp) {
  return C.estimateWin(cards(holeStr), cards(boardStr), nOpp || 1, 3000, [width]);
}

/* 场景：BTN 开池 40% → BB 跟注。翻牌 K72r，BB 过牌，BTN c-bet，BB 跟注。
   此时 BB 的范围已不是 40%，而是"跟注 c-bet 的过滤后范围"。
   当前引擎只会把 pfPctl 乘 0.6 → 40% * 0.6 = 24%。
   但真实的跟注范围在 K 高干燥面应该是：对子、Kx、A高、后门听牌 —— 且**不含**纯空气。 */

console.log('='.repeat(90));
console.log('范围收窄误差诊断');
console.log('='.repeat(90));

const cases = [
  { name: 'BTN 持 77（中对）', hole: '7h 7s', board: 'Kd 7c 2s', note: '翻牌已中三条' },
  { name: 'BTN 持 AA（超对）', hole: 'As Ah', board: 'Kd 7c 2s', note: '翻牌超对' },
  { name: 'BTN 持 AQo（A高）', hole: 'As Qh', board: 'Kd 7c 2s', note: '未中牌，A 高' }
];

console.log('\n【翻牌 K72r，BB 跟注了 c-bet 之后】');
console.log('  改造前引擎认为 BB 范围 ≈ 24%（pfPctl 40% × 0.6）');
console.log('  真实跟注范围应更窄且更偏价值/听牌 —— 估 18% 且结构完全不同\n');

cases.forEach(function (c) {
  const e24 = eq(c.hole, c.board, 0.24);
  const e18 = eq(c.hole, c.board, 0.18);
  const e40 = eq(c.hole, c.board, 0.40); // 翻前未收窄（错误口径）
  console.log(c.name + '  (' + c.note + ')');
  console.log('    vs 40%（错误：用翻前范围）: ' + (e40 * 100).toFixed(1) + '%');
  console.log('    vs 24%（改造前口径）    : ' + (e24 * 100).toFixed(1) + '%');
  console.log('    vs 18%（真实跟注范围）    : ' + (e18 * 100).toFixed(1) + '%');
  console.log('    → 改造前 equity 偏差: ' + ((e24 - e18) * 100).toFixed(1) + ' 个百分点');
});

console.log('\n' + '='.repeat(90));
console.log('【转牌 K72r-9h，BB 跟注 flop 后又跟注 turn bet】');
console.log('  改造前: pfPctl 连续乘两次 0.6 → 40% × 0.6 × 0.6 = 14.4%');
console.log('  问题: 转牌跟注范围已高度偏向 Kx / 99 / 听牌，纯空气全弃\n');
cases.forEach(function (c) {
  const e144 = eq(c.hole, 'Kd 7c 2s 9h', 0.144);
  const e08 = eq(c.hole, 'Kd 7c 2s 9h', 0.08);
  console.log(c.name);
  console.log('    vs 14.4%(改造前口径): ' + (e144 * 100).toFixed(1) + '%');
  console.log('    vs 8%（真实转牌跟注）: ' + (e08 * 100).toFixed(1) + '%');
  console.log('    → 偏差: ' + ((e144 - e08) * 100).toFixed(1) + ' 个百分点');
});

console.log('\n' + '='.repeat(90));
console.log('【河牌 K72r-9h-3c，对手三条街都跟注】');
console.log('  改造前: 40% × 0.6³ = 8.6%');
console.log('  真实: 能跟到河牌的范围极窄，几乎全是成手牌 → 约 4-5%\n');
cases.forEach(function (c) {
  const e086 = eq(c.hole, 'Kd 7c 2s 9h 3c', 0.086);
  const e045 = eq(c.hole, 'Kd 7c 2s 9h 3c', 0.045);
  console.log(c.name);
  console.log('    vs 8.6%(改造前口径) : ' + (e086 * 100).toFixed(1) + '%');
  console.log('    vs 4.5%（真实河牌）  : ' + (e045 * 100).toFixed(1) + '%');
  console.log('    → 偏差: ' + ((e086 - e045) * 100).toFixed(1) + ' 个百分点');
});

console.log('\n' + '='.repeat(90));
console.log('结论');
console.log('='.repeat(90));
console.log('范围收窄的误差是【累积】的：翻牌小偏差 → 转牌放大 → 河牌最大。');
console.log('改造前"统一乘 0.6"的做法，在河牌会让引擎高估自己的 equity，');
console.log('表现为"河牌跟注过多 / 诈唬过多"——这正是体感上"不聪明"的主要残留来源。');
console.log('');
console.log('→ 已修复：范围升级为 169 格权重表，跟注方按 MDF 逐街收窄');
console.log('  （postflop-engine.js 的 filterRange / core.js 的 narrowRange）。');
console.log('  本脚本仅作"问题存档"，数值描述的是改造前行为。');
console.log('  当前状态验证请看：node tools/range-test.js（22 项断言）');
