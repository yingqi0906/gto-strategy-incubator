/* 【C】范围现算优势探针
   ------------------------------------------------------------
   验证 postflop-engine 的"用真实范围现算牌面优势"是否生效，重点回答：
     1) 同一个桶内（K_hi_dry）的不同牌面，频率是否真的拉开了？
     2) 桶与桶边界（KT8r → KT9r）的跳变是否被平滑？
     3) 3-bet 池下这套优势是否仍然可用？

   用法：node tools/adv-probe.js
   说明：优势量由 gw-ranges 的真实范围算出；ADV_CBET_SLOPE 等斜率仍是估值，
        本脚本只报告"引擎实际输出的排序与差异"，不声称与求解器一致。 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'core.js'));
const PF = require(path.join(__dirname, '..', 'postflop-engine.js'));

const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT = { s: 0, h: 1, d: 2, c: 3 };
function card(c) { return { r: RANK[c[0]], s: SUIT[c[1]], id: RANK[c[0]] * 4 + SUIT[c[1]] }; }
function cards(s) { return s.split(' ').filter(Boolean).map(card); }

/* 单加池：BTN 开池，BB 跟注（100bb，翻牌底池 12）
   rangePf 是"攻击方范围"的查表上下文 —— 开注者要查自己的 RFI 节点（raises:0），
   否则 chartFor 会因为"开注者的加注仍然有效"而返回 null。 */
const SRP = {
  pf: { raises: 1, opener: 'BTN', firstCaller: 'BB', lastRaiser: 'BTN', posName: 'BTN' },
  rangePf: { raises: 0, posName: 'BTN' },
  pot: 12, chips: 100, hasInitiative: true, posName: 'BTN'
};
/* 3-bet 池：CO 开池，BTN 3-bet，CO 跟注（100bb，翻牌底池 20）
   3-bet 者的范围取自"面对开注"节点的加注部分 */
const THREE_BET = {
  pf: { raises: 2, opener: 'CO', threeBettor: 'BTN', lastRaiser: 'BTN', posName: 'BTN' },
  rangePf: { raises: 1, opener: 'CO', posName: 'BTN' },
  pot: 20, chips: 90, hasInitiative: true, posName: 'BTN'
};

/* 对整个攻击方范围求"范围整体 c-bet 频率"（与 calibrate.js 同口径） */
function rangeCbet(boardStr, cfg) {
  const board = cards(boardStr);
  const range = C.rangeForPreflop(cfg.posName, cfg.rangePf, 'raise');
  const boardIds = {};
  board.forEach(c => { boardIds[c.id] = true; });
  let totalC = 0, betC = 0, sizeW = 0;
  for (const k in range) {
    const w = range[k];
    if (!(w > 0)) continue;
    const h = PF.combosOfCards(k)[0];
    if (boardIds[h[0].id] || boardIds[h[1].id]) continue;
    const cw = w * PF.rangeCombos(k);
    totalC += cw;
    const a = C.aiDecide({
      hole: h, community: board, nOpp: 1, toCall: 0, pot: cfg.pot, currentBet: 0,
      chips: cfg.chips, bb: 2, hasInitiative: cfg.hasInitiative, effStack: cfg.chips,
      oppPctls: [0.5], posName: cfg.posName, pf: cfg.pf
    });
    let p = 0;
    if (a.opts) a.opts.forEach(o => {
      if (o.act && o.act.type === 'raise') { p += o.prob; sizeW += o.prob * ((o.act.to || 0) / cfg.pot); }
    });
    betC += cw * p;
  }
  return { freq: totalC > 0 ? betC / totalC : 0, size: betC > 0 ? sizeW / betC : 0, combos: totalC };
}

/* 直接读引擎内部的优势量（不经抽样，看"算出来的值"本身） */
function advantageRow(boardStr, cfg) {
  const board = PF.analyzeBoard(cards(boardStr));
  const arrival = PF.preflopArrivalRanges(
    { pf: cfg.pf, posName: cfg.posName }, { rangeForPreflop: C.rangeForPreflop });
  if (!arrival) return null;
  const now = PF.boardAdvantage(board, arrival.atk, arrival.cal, { best7: C.best7, cmpScore: C.cmpScore });
  const refBoard = PF.analyzeBoard(PF.cardsFromStr(PF.BUCKET_CANONICAL[board.bucket.id]));
  const ref = PF.boardAdvantage(refBoard, arrival.atk, arrival.cal, { best7: C.best7, cmpScore: C.cmpScore });
  return { board, now, ref, residual: now.driver - ref.driver };
}

function table(cfg, boards, title) {
  console.log('\n' + title);
  console.log('牌面         桶            驱动量   残差     引擎cbet  尺度');
  const rows = [];
  for (const s of boards) {
    const r = advantageRow(s, cfg);
    const e = rangeCbet(s, cfg);
    if (!r) { console.log(s.padEnd(13) + '(无范围数据，回退桶表)'); continue; }
    rows.push({ s, bucket: r.board.bucket.id, driver: r.now.driver, res: r.residual, freq: e.freq, size: e.size });
    console.log(s.padEnd(13) + r.board.bucket.id.padEnd(14) +
      r.now.driver.toFixed(3).padStart(7) + r.residual.toFixed(3).padStart(8) +
      ((e.freq * 100).toFixed(1) + '%').padStart(10) + ((e.size * 100).toFixed(0) + '%').padStart(7));
  }
  return rows;
}

console.log('='.repeat(78));
console.log('【C】范围现算优势探针 —— 用 gw-ranges 的真实范围算牌面优势');
console.log('='.repeat(78));
console.log('说明：引擎 cbet 由蒙特卡洛抽样得到（有 ±几 pp 抖动），只反映抽样后的实际输出。');

const kHi = ['Kd Qs 2c', 'Kd Js 2c', 'Kd Ts 2c', 'Kd 9s 2c', 'Kd 8s 2c', 'Kd 7s 2c', 'Kd 6s 2c'];
table(SRP, kHi, '[1] 同一桶 K_hi_dry：KQ2r → K72r（桶内梯度是否拉开）');

table(SRP, ['Kd 9s 4c', 'Ad 9s 4c', 'Qd Js 9c', 'Jd Td 9c', '7d 6s 4c', 'Td 7s 2c', '8d 5d 2c'],
  '[2] 跨桶对照（均为非 canonical 牌面，残差应非零）：高干燥 / A高 / 高连通 / 低连通 / 中牌 / 低湿');

const jump = table(SRP, ['Kd Ts 8c', 'Kd Ts 9c'],
  '[3] 桶边界：KT8r(K_hi_dry) → KT9r(conn_hi_dry)，一张牌的跳变');

table(THREE_BET, ['Kd Qs 2c', 'Kd Ts 2c', 'Kd 7s 2c', '7d 6s 5c', 'Td 9d 8c'],
  '[4] 3-bet 池（CO 开 → BTN 3bet → CO 跟）：同一套优势是否仍可用');

/* 结论行 */
const r1 = advantageRow('Kd 7s 2c', SRP), r2 = advantageRow('Kd Qs 2c', SRP);
if (r1 && r2) {
  console.log('\n' + '-'.repeat(78));
  console.log('K72r 驱动量 ' + r1.now.driver.toFixed(3) + '  vs  KQ2r 驱动量 ' + r2.now.driver.toFixed(3) +
    '  →  后者低 ' + ((r1.now.driver - r2.now.driver) * PF.ADV_CBET_SLOPE * 100).toFixed(1) + 'pp 的 c-bet 频率');
}
const e1 = rangeCbet('Kd 7s 2c', SRP), e2 = rangeCbet('Kd Qs 2c', SRP);
console.log('引擎实测：K72r ' + (e1.freq * 100).toFixed(1) + '%   KQ2r ' + (e2.freq * 100).toFixed(1) + '%' +
  '   （改前两者完全相同 = 74.0%）');
console.log('='.repeat(78));
