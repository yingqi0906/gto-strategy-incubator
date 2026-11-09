/* GTO 校准锚点核对：把 翻后GTO校准锚点.md 的频率/尺度基准变成可执行检查。
   做法：对翻前范围的每一手逐一手求策略，按组合加权得到"范围整体 c-bet 频率"与
   "主导尺度"，再与锚点区间对照。

   两段：
     [A] 单加池（SRP）：17 个代表牌面 × 锚点区间（绝对区间，容差 ±10pp / ±0.12）
     [B] 3-bet 池：同一批牌面，检查**方向性关系**——
         低/中牌面上 3-bet 池的 c-bet 频率应高于单加池（跟注方不再持有小同花连张，
         其范围优势被削弱）；高牌干燥面上两者接近。这是公开求解器研究里最稳的结论，
         比给 3-bet 池编一套绝对区间更可信。

   用法：node tools/calibrate.js
   注意：锚点是公开求解器研究的近似区间，本脚本只报偏差，不做硬性断言；
   偏离超过阈值时提示人工复核。 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'core.js'));
const PF = require(path.join(__dirname, '..', 'postflop-engine.js'));

const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT = { s: 0, h: 1, d: 2, c: 3 };
function card(c) { return { r: RANK[c[0]], s: SUIT[c[1]], id: RANK[c[0]] * 4 + SUIT[c[1]] }; }
function cards(s) { return s.split(' ').filter(Boolean).map(card); }

/* ---------- 两种底池的取样口径 ---------- */
/* 单加池：BTN 开池，BB 跟注（100bb，翻牌底池 12，SPR ≈ 8.3） */
const SRP = {
  tag: 'srp',
  range: () => C.rangeForPreflop('BTN', { raises: 0 }, 'raise'),
  pf: { raises: 1, opener: 'BTN', lastRaiser: 'BTN', posName: 'BTN' },
  pot: 12, chips: 100, hasInitiative: true
};
/* 3-bet 池：CO 开池，BTN 3-bet，CO 跟注（100bb，翻牌底池 20，SPR ≈ 4.5）
   攻击方 = BTN（3-bettor）；其范围取 VS|CO|BTN 的加注部分 */
const THREE_BET = {
  tag: 'threebet',
  range: () => C.rangeForPreflop('BTN', { raises: 1, opener: 'CO', posName: 'BTN' }, 'raise'),
  pf: { raises: 2, opener: 'CO', threeBettor: 'BTN', lastRaiser: 'BTN', posName: 'BTN' },
  pot: 20, chips: 90, hasInitiative: true
};

/* 对整个攻击方范围求"范围整体 c-bet 频率"与"主导尺度" */
function probeCbet(boardStr, mode) {
  const cfg = mode || SRP;
  const board = cards(boardStr);
  const range = cfg.range();
  const boardIds = {};
  board.forEach(c => { boardIds[c.id] = true; });

  let totalC = 0, betC = 0, sizeCount = {};
  for (const k in range) {
    const w = range[k];
    if (!(w > 0)) continue;
    const combos = PF.combosOfCards(k);
    const h = combos[0];
    if (boardIds[h[0].id] || boardIds[h[1].id]) continue;   // 与牌面冲突
    const cw = w * PF.rangeCombos(k);
    totalC += cw;

    const a = C.aiDecide({
      hole: h, community: board, nOpp: 1, toCall: 0, pot: cfg.pot, currentBet: 0,
      chips: cfg.chips, bb: 2, hasInitiative: cfg.hasInitiative, effStack: cfg.chips,
      oppPctls: [0.5], posName: 'BTN', pf: cfg.pf
    });
    let betProb = 0;
    let sizeW = 0;
    if (a.opts) {
      a.opts.forEach(function (o) {
        if (o.act && o.act.type === 'raise') {
          betProb += o.prob;
          const frac = (o.act.to || 0) / cfg.pot;
          sizeW += o.prob * frac;
          const key = (Math.round(frac * 100) / 100).toFixed(2);
          sizeCount[key] = (sizeCount[key] || 0) + o.prob * cw;
        }
      });
    }
    betC += cw * betProb;
  }
  let domSize = 0, domW = -1;
  for (const s in sizeCount) { if (sizeCount[s] > domW) { domW = sizeCount[s]; domSize = +s; } }
  return { freq: totalC > 0 ? betC / totalC : 0, size: domSize, width: totalC / 1326 };
}

/* ---------- [A] 单加池锚点 ---------- */
const ANCHORS = [
  /* 高牌干燥（加注者范围优势最大） */
  { board: 'Kd 7c 2s', label: 'K72r (K高·干燥)', freq: [0.75, 0.80], size: [0.30, 0.40], note: '加注者范围优势极大' },
  { board: 'Ad 9c 4s', label: 'A94r (A高·干燥)', freq: [0.78, 0.85], size: [0.30, 0.40], note: '加注者坚果优势最显著' },
  { board: 'Ad 7c 2s', label: 'A72r (A高·干燥)', freq: [0.80, 0.88], size: [0.30, 0.40], note: 'A高干燥面 → 范围下注' },
  { board: 'Qd 7c 2s', label: 'Q72r (Q高·干燥)', freq: [0.70, 0.80], size: [0.30, 0.40], note: '同高牌干燥面' },
  /* 高牌两同花（转极化、大尺度） */
  { board: 'Ad Td 9c', label: 'AT9dd (A高·两同花)', freq: [0.50, 0.62], size: [0.60, 0.75], note: 'A高但湿润，频率下调尺度放大' },
  { board: 'Kd Qd 7c', label: 'KQ7dd (K高·两同花)', freq: [0.48, 0.60], size: [0.60, 0.75], note: 'K高两同花' },
  { board: 'Qd Jd 5c', label: 'QJ5dd (Q高·两同花)', freq: [0.45, 0.58], size: [0.60, 0.75], note: 'Q高两同花' },
  /* 连通面 */
  { board: 'Qd Jc Th', label: 'QJT (高连通)', freq: [0.45, 0.55], size: [0.60, 0.70], note: '跟注者大量击中' },
  { board: 'Th 9h 8c', label: 'T98ss (两同花·连通)', freq: [0.50, 0.60], size: [0.60, 0.75], note: '湿润，转极化' },
  { board: '7d 6c 5s', label: '765r (低连通)', freq: [0.40, 0.50], size: [0.30, 0.40], note: '跟注者有范围优势' },
  /* 中低牌面 */
  { board: 'Td 7c 2s', label: 'T72r (中牌·干燥)', freq: [0.55, 0.68], size: [0.30, 0.40], note: 'T高不连，中等优势' },
  { board: '8d 3c 2s', label: '832r (低牌·干燥)', freq: [0.42, 0.55], size: [0.30, 0.40], note: '双方都难击中，低频小注' },
  { board: '8d 5d 2c', label: '852dd (低牌·两同花)', freq: [0.38, 0.50], size: [0.33, 0.55], note: '低牌加同花听牌' },
  /* 对子面 / 特殊面 */
  { board: '2d 2c 7s', label: '227r (低对子面)', freq: [0.60, 0.70], size: [0.30, 0.40], note: '双方都难击中' },
  { board: 'Kd Kc 7s', label: 'KK7r (高对子面)', freq: [0.68, 0.82], size: [0.30, 0.40], note: '高对子面，小尺度高频' },
  { board: '7s 7h 7d', label: '777 (三条面)', freq: [0.72, 0.85], size: [0.30, 0.40], note: '三条面，坚果优势最大' },
  { board: 'Ks Qs 8s', label: 'KQ8sss (三同花)', freq: [0.30, 0.48], size: [0.33, 0.60], note: '三同花面，频率最低' }
];

console.log('='.repeat(94));
console.log('[A] 单加池锚点核对（BTN 开池范围整体 c-bet，翻牌底池 12，SPR ≈ 8.3）');
console.log('='.repeat(94));
console.log('牌面'.padEnd(22) + '引擎频率   锚点频率    引擎尺度   锚点尺度   判定');
console.log('-'.repeat(94));

let offCount = 0;
ANCHORS.forEach(function (an) {
  const r = probeCbet(an.board, SRP);
  const fOk = r.freq >= an.freq[0] - 0.10 && r.freq <= an.freq[1] + 0.10;
  const sOk = r.size >= an.size[0] - 0.12 && r.size <= an.size[1] + 0.12;
  const ok = fOk && sOk;
  if (!ok) offCount++;
  const fStr = (r.freq * 100).toFixed(0) + '%';
  const fAnchor = (an.freq[0] * 100).toFixed(0) + '-' + (an.freq[1] * 100).toFixed(0) + '%';
  console.log(
    an.label.padEnd(22) + fStr.padEnd(11) + fAnchor.padEnd(12) +
    (r.size.toFixed(2) + '池').padEnd(11) +
    ((an.size[0] * 100).toFixed(0) + '-' + (an.size[1] * 100).toFixed(0) + '%池').padEnd(11) +
    (ok ? '一致' : '偏差'));
  if (!ok) {
    if (!fOk) console.log('    └ 频率偏离：引擎 ' + fStr + '，锚点 ' + fAnchor);
    if (!sOk) console.log('    └ 尺度偏离：引擎 ' + r.size.toFixed(2) + '池，锚点 ' +
      (an.size[0] * 100).toFixed(0) + '-' + (an.size[1] * 100).toFixed(0) + '%池');
  }
});
console.log('-'.repeat(94));
console.log('说明：锚点为公开求解器研究的近似区间，容差 ±10pp（频率）/ ±0.12（尺度）。');
console.log('     偏差项：' + offCount + ' / ' + ANCHORS.length);

/* ---------- [B] 3-bet 池：方向性关系 ---------- */
console.log('\n' + '='.repeat(94));
console.log('[B] 单加池 vs 3-bet 池（同一牌面，攻击方范围整体 c-bet）');
console.log('='.repeat(94));
console.log('范围宽度：单加池 ' + (PF.rangeWidth(SRP.range()) * 100).toFixed(1) +
  '%  |  3-bet 池攻击方 ' + (PF.rangeWidth(THREE_BET.range()) * 100).toFixed(1) + '%');
console.log('');
console.log('牌面'.padEnd(22) + '单加池      3-bet 池    差值      尺度(单/3b)');
console.log('-'.repeat(94));

const LOW_MID = ['8d 3c 2s', '7d 6c 5s', 'Td 7c 2s', '8d 5d 2c'];
const HIGH_DRY = ['Kd 7c 2s', 'Ad 7c 2s'];
const SHOW = ['Kd 7c 2s', 'Ad 7c 2s', 'Qd 7c 2s', 'Td 7c 2s', '8d 3c 2s',
  '7d 6c 5s', 'Qd Jc Th', 'Th 9h 8c', '2d 2c 7s', '8d 5d 2c'];
const relChecks = [];
const paired = {};
SHOW.forEach(function (b) {
  const a = probeCbet(b, SRP), t = probeCbet(b, THREE_BET);
  paired[b] = { a: a, t: t };
  const d = t.freq - a.freq;
  console.log(b.padEnd(22) + ((a.freq * 100).toFixed(0) + '%').padEnd(12) +
    ((t.freq * 100).toFixed(0) + '%').padEnd(12) +
    ((d >= 0 ? '+' : '') + (d * 100).toFixed(0) + 'pp').padEnd(10) +
    a.size.toFixed(2) + ' / ' + t.size.toFixed(2));
  if (LOW_MID.indexOf(b) >= 0) relChecks.push({ b: b, kind: 'up', d: d });
  if (HIGH_DRY.indexOf(b) >= 0) relChecks.push({ b: b, kind: 'hi', d: d, t: t });
});

console.log('-'.repeat(94));
let relBad = 0;
relChecks.forEach(function (c) {
  const ok = c.kind === 'up' ? c.d > 0.02
    : (c.t.freq >= 0.70 && c.d >= -0.05);
  const msg = c.kind === 'up'
    ? '低/中牌面：3-bet 池 c-bet 应高于单加池（+2pp 以上）'
    : '高牌干燥面：3-bet 池同样高频（≥70%），且不低于单加池';
  if (!ok) relBad++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + c.b + ' ' + msg +
    '  [单加池 ' + (paired[c.b].a.freq * 100).toFixed(0) + '% → 3-bet ' +
    (paired[c.b].t.freq * 100).toFixed(0) + '%]');
});
const sizeBad = LOW_MID.filter(function (b) { return paired[b].t.size > paired[b].a.size + 0.02; });
console.log((sizeBad.length === 0 ? '  PASS  ' : '  FAIL  ') +
  '3-bet 池的翻牌尺度不大于单加池（更统一/更小）' +
  (sizeBad.length ? '  异常：' + sizeBad.join(',') : ''));

console.log('\n' + '='.repeat(94));
console.log('汇总：单加池绝对锚点偏差 ' + offCount + ' / ' + ANCHORS.length +
  '；3-bet 池方向性检查失败 ' + (relBad + (sizeBad.length ? 1 : 0)) + ' 项');
console.log('说明：3-bet 池不给绝对区间 —— 公开资料里"低牌面 3-bet 池 c-bet 更高"这一');
console.log('     方向是稳的，具体点位的绝对频率没有可靠公开锚点，编一个反而误导。');
console.log('     另：第 9 部分的【C】范围现算层会按真实范围下调"桶内连接率偏高"的牌面，');
console.log('     因此个别落在某桶但明显偏离桶级典型牌面的牌面（如 KQ7dd 落入 K高·两同花桶');
console.log('     但 Q 让跟注方大量连接）偏离桶级锚点属**预期行为**，不是回退。');
