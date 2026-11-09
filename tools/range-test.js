/* 范围权重表验证：确认"跟注方也会收窄"，并对比新旧口径的 equity 差异。
   用法：node tools/range-test.js */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'core.js'));
const PF = require(path.join(__dirname, '..', 'postflop-engine.js'));

const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT = { s: 0, h: 1, d: 2, c: 3 };
function card(c) { return { r: RANK[c[0]], s: SUIT[c[1]], id: RANK[c[0]] * 4 + SUIT[c[1]] } }
function cards(s) { return s.split(' ').filter(Boolean).map(card); }

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg); }
}

console.log('='.repeat(84));
console.log('范围权重表验证');
console.log('='.repeat(84));

// 1. 基础结构
console.log('\n[1] 权重表基础');
check(PF.RANGE_KEYS.length === 169, '169 格范围键');
check(PF.rangeCombos('p14') === 6, '对子 6 组合');
check(PF.rangeCombos('s14_13') === 4, '同花 4 组合');
check(PF.rangeCombos('o14_13') === 12, '非同花 12 组合');
const full = PF.makeFullRange();
check(Math.abs(PF.rangeWidth(full) - 1) < 1e-9, '全范围宽度 = 100%');

// 2. 翻前 GTO 表构建
console.log('\n[2] 翻前从 GTO 表构建范围');
const rfiBtn = C.rangeForPreflop('BTN', { raises: 0 }, 'raise');
const wBtn = C.rangeWidthOf(rfiBtn);
check(wBtn > 0.35 && wBtn < 0.48, 'BTN RFI 宽度 ≈ 40% (实测 ' + (wBtn * 100).toFixed(1) + '%)');
const rfiUtg = C.rangeForPreflop('UTG', { raises: 0 }, 'raise');
const wUtg = C.rangeWidthOf(rfiUtg);
check(wUtg < wBtn - 0.1, 'UTG RFI 明显窄于 BTN (' + (wUtg * 100).toFixed(1) + '% vs ' + (wBtn * 100).toFixed(1) + '%)');

// 3. 翻后过滤 —— 核心：跟注方必须收窄
console.log('\n[3] 翻后按行动过滤（核心修复）');
const flop = cards('Kd 7c 2s');
const bbCall = C.rangeForPreflop('BB', { raises: 1, opener: 'BTN', threeBettor: null }, 'call');
const wPre = C.rangeWidthOf(bbCall);
check(wPre > 0.1, 'BB 跟注开池的范围宽度 = ' + (wPre * 100).toFixed(1) + '%');

const wCall1 = C.rangeWidthOf(C.filterRangeOnAction(bbCall, flop, 'call', 0.33));
const wCall2 = C.rangeWidthOf(C.filterRangeOnAction(bbCall, flop, 'call', 0.66));
check(wCall1 < wPre, '面对 1/3 池跟注后范围收窄 (' + (wPre * 100).toFixed(1) + '% → ' + (wCall1 * 100).toFixed(1) + '%)');
check(wCall2 < wCall1, '面对 2/3 池收窄更多 (' + (wCall1 * 100).toFixed(1) + '% → ' + (wCall2 * 100).toFixed(1) + '%)');
check(wCall1 / wPre > 0.7, '小注下防守接近 MDF（' + (wCall1 / wPre * 100).toFixed(0) + '% of 原范围，MDF 应为 75%）');
check(wCall2 / wPre > 0.5 && wCall2 / wPre < 0.7, '中注下防守接近 MDF（' + (wCall2 / wPre * 100).toFixed(0) + '%，MDF 应为 60%）');

// 4. 逐街累积收窄
console.log('\n[4] 逐街累积收窄');
let r = bbCall;
const streets = [['Kd 7c 2s', 0.66], ['Kd 7c 2s 9h', 0.66], ['Kd 7c 2s 9h 3c', 0.66]];
streets.forEach(function (s) {
  r = C.filterRangeOnAction(r, cards(s[0]), 'call', s[1]);
  console.log('    ' + s[0].padEnd(14) + ' → 宽度 ' + (C.rangeWidthOf(r) * 100).toFixed(1) + '%');
});
const wRiver = C.rangeWidthOf(r);
check(wRiver < 0.09, '三条街跟注后河牌范围 < 9% (实测 ' + (wRiver * 100).toFixed(1) + '%)');
check(wRiver < wPre * 0.45, '相比翻前显著收窄（' + (wRiver / wPre * 100).toFixed(0) + '% of 翻前宽度）');

// 5. 下注方范围应极化（强牌保留率高，中等牌被压缩）
console.log('\n[5] 下注范围极化');
const betR = C.filterRangeOnAction(bbCall, flop, 'bet', 0.66);
function retention(before, after, board, predicate) {
  function sum(range) {
    let s = 0;
    for (const k in range) {
      const w = range[k]; if (!(w > 0)) continue;
      if (predicate(PF.boardStrength(k, board))) s += w * PF.rangeCombos(k);
    }
    return s;
  }
  const b = sum(before);
  return b > 0 ? sum(after) / b : 0;
}
const strongRet = retention(bbCall, betR, flop, s => s.tier >= 4);
const midRet = retention(bbCall, betR, flop, s => s.tier === 2);
const weakRet = retention(bbCall, betR, flop, s => s.tier <= 1 && s.outs < 4);
console.log('    保留率：强牌 ' + (strongRet * 100).toFixed(0) + '%，中等牌 ' + (midRet * 100).toFixed(0) + '%，弱牌 ' + (weakRet * 100).toFixed(0) + '%');
check(strongRet > midRet, '强牌保留率高于中等牌（极化：' + (strongRet * 100).toFixed(0) + '% vs ' + (midRet * 100).toFixed(0) + '%）');
check(strongRet > 0.7, '强牌在下注范围中基本全保留（≥70%）');

// 6. equity 口径对比：范围表 vs 旧的百分位
console.log('\n[6] equity 口径对比（河牌，对手三条街跟注）');
const hole = cards('Ah Ad');
const riverBoard = cards('Kd 7c 2s 9h 3c');
let rRiver = bbCall;
streets.forEach(function (s) { rRiver = C.filterRangeOnAction(rRiver, cards(s[0]), 'call', s[1]); });

const eqOld = C.estimateWin(hole, riverBoard, 1, 4000, [wPre]);           // 旧口径：固定翻前宽度
const eqNew = C.estimateWin(hole, riverBoard, 1, 4000, null, null, [rRiver]); // 新口径：范围权重表
console.log('    AA 实际权益 vs 翻前宽度 ' + (wPre * 100).toFixed(0) + '% : ' + (eqOld * 100).toFixed(1) + '%');
console.log('    AA 实际权益 vs 收窄后范围       : ' + (eqNew * 100).toFixed(1) + '%');
check(eqNew < eqOld, '新口径给出的权益更低（更诚实）：' + ((eqOld - eqNew) * 100).toFixed(1) + ' 个百分点');
check(eqOld - eqNew > 0.03, '差异显著（>3 个百分点）—— 说明旧口径确实高估');

// 7. Alpha 闭环
console.log('\n[7] Alpha 诈唬比例');
check(Math.abs(PF.alphaRatio(1) - 1 / 3) < 1e-9, '底池注 → 诈唬占 33%（理论值）');
check(Math.abs(PF.alphaRatio(1 / 3) - 0.2) < 1e-9, '1/3 池注 → 诈唬占 20%');
check(Math.abs(PF.alphaRatio(2 / 3) - 2 / 7) < 1e-9, '2/3 池注 → 诈唬占 28.6%');
check(PF.alphaRatio(1.5) > PF.alphaRatio(1) && PF.alphaRatio(1) > PF.alphaRatio(0.33),
  '尺度越大，诈唬比例越高（单调）');

// 8. 牌面分桶分类器：分类结果必须稳定（改动 bucketOf 的优先级会在这里暴露）
console.log('\n[8] 牌面结构分桶分类');
const bucketCases = [
  ['7s 7h 7d', 'trips', '三条面'],
  ['Ks Qs 8s', 'monotone', '三同花'],
  ['Kd Kc 7s', 'paired_hi', '高对子面'],
  ['2d 2c 7s', 'paired_lo', '低对子面'],
  ['Ad 7c 2s', 'A_hi_dry', 'A高干燥'],
  ['Ad Td 9c', 'A_hi_wet', 'A高两同花'],
  ['Kd 7c 2s', 'K_hi_dry', 'K高干燥'],
  ['Kd Qd 7c', 'K_hi_wet', 'K高两同花'],
  ['Qd 7c 2s', 'Q_hi_dry', 'Q高干燥'],
  ['Qd Jd 5c', 'Q_hi_wet', 'Q高两同花'],
  ['Qd Jc Th', 'conn_hi_dry', '高连通彩虹'],
  ['Th 9h 8c', 'conn_hi_wet', '高连通两同花'],
  ['7d 6c 5s', 'conn_lo', '低连通'],
  ['Td 7c 2s', 'mid_dry', '中牌干燥'],
  ['8d 3c 2s', 'lo_dry', '低牌干燥'],
  ['8d 5d 2c', 'lo_wet', '低牌两同花']
];
bucketCases.forEach(function (c) {
  const b = PF.analyzeBoard(cards(c[0]));
  check(b.bucket.id === c[1], c[0] + ' → ' + c[2] + '（' + b.bucket.id + '）');
});
// 桶参数必须自洽：范围下注桶用 33% 尺度，两极化桶用大尺度
const dryBuckets = ['A_hi_dry', 'K_hi_dry', 'Q_hi_dry', 'paired_hi', 'paired_lo', 'trips', 'mid_dry', 'lo_dry', 'conn_lo'];
const badSize = dryBuckets.filter(function (k) { return PF.BOARD_BUCKETS[k].size > 0.4; });
check(badSize.length === 0, '小尺度桶的 size 均 ≤ 33%' + (badSize.length ? '（异常：' + badSize.join(',') + '）' : ''));
const badOrder = Object.keys(PF.BOARD_BUCKETS).filter(function (k) {
  const b = PF.BOARD_BUCKETS[k];
  return !(b.vbet >= b.cbet && b.cbet > 0 && b.size > 0);
});
check(badOrder.length === 0, '每个桶满足 vbet ≥ cbet 且参数为正' + (badOrder.length ? '（异常：' + badOrder.join(',') + '）' : ''));

// 9. 底池类型（单加池 / 3-bet 池）：与桶正交的第二维
console.log('\n[9] 底池类型修正');
check(PF.potTypeOf({ pf: { raises: 1 } }, 'deep') === 'srp', 'raises=1 → 单加池');
check(PF.potTypeOf({ pf: { raises: 2 } }, 'medium') === 'threebet', 'raises=2 → 3-bet 池');
check(PF.potTypeOf({ pf: { raises: 3 } }, 'commit') === 'fourbet', 'raises=3 → 4-bet 池');
check(PF.potTypeOf({}, 'deep') === 'srp', '上下文缺失 + 深 SPR → 单加池（兜底）');
check(PF.potTypeOf({}, 'shallow') === 'threebet', '上下文缺失 + 浅 SPR → 3-bet 池（兜底）');
const bLo = PF.BOARD_BUCKETS.conn_lo, bHi = PF.BOARD_BUCKETS.A_hi_dry;
const fSrpLo = PF.bucketFreqs(bLo, PF.POT_TYPE_MOD.srp);
const fTbLo = PF.bucketFreqs(bLo, PF.POT_TYPE_MOD.threebet);
const fSrpHi = PF.bucketFreqs(bHi, PF.POT_TYPE_MOD.srp);
const fTbHi = PF.bucketFreqs(bHi, PF.POT_TYPE_MOD.threebet);
check(Math.abs(fSrpLo.cbet - bLo.cbet) < 1e-9, '单加池不改变桶频率（adv 系数 = 1）');
check(fTbLo.cbet > bLo.cbet, '低连通面：3-bet 池频率被拉高（' +
  (bLo.cbet * 100).toFixed(0) + '% → ' + (fTbLo.cbet * 100).toFixed(0) + '%）');
check(fTbHi.cbet < bHi.cbet, 'A高干燥面：3-bet 池频率被拉低（' +
  (bHi.cbet * 100).toFixed(0) + '% → ' + (fTbHi.cbet * 100).toFixed(0) + '%）');
check(fTbLo.vbet > bLo.vbet && fTbHi.vbet > bHi.vbet, '3-bet 池价值手频率上调（低 SPR 更敢承诺）');
check(PF.POT_TYPE_MOD.threebet.size < 1 && PF.POT_TYPE_MOD.fourbet.size < PF.POT_TYPE_MOD.threebet.size,
  '底池越深，翻牌尺度系数越小（更统一）');

console.log('\n' + '='.repeat(84));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
