/* 复现用户牌谱：CO(A♠A♥) 开注 2.5 → BB(9♦9♦) 跟注 → 翻牌底池 5.5
   牌面（按截图还原）：翻牌 K♠2♦T♦(两同花) / 转牌 6♣ / 河牌 K♥(配对K)
   引擎在三条街"check to me"分支给出的原始选项与频率。
   用法：node tools/probe-aa-river.js */
'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'gw-ranges.js'));
const C = require(path.join(__dirname, '..', 'core.js'));

const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT = { s: 0, h: 1, d: 2, c: 3 };
function card(t) { return { r: RANK[t[0]], s: SUIT[t[1]], id: RANK[t[0]] * 4 + SUIT[t[1]] } }
function cards(s) { return s.split(' ').filter(Boolean).map(card); }

const HOLE_AI = cards('As Ah');
const HOLE_BB = cards('9d 9d');
const FLOP = cards('Ks 2d Td');
const TURN = cards('Ks 2d Td 6c');
const RIVER = cards('Ks 2d Td 6c Kh');

/* 范围：CO 开注范围 / BB 跟注范围（与游戏内 narrowRange 一致） */
const CO_OPEN = C.rangeForPreflop('CO', { posName: 'CO', raises: 0, opener: 'CO' }, 'raise');
const BB_CALL = C.rangeForPreflop('BB', { posName: 'BB', raises: 1, opener: 'CO' }, 'call');

function mkOpts(community, chips, label, myChecks) {
  console.log('\n----- ' + label + ' -----');
  console.log('牌面: ' + community.map(function (c) {
    const t = C.cardText(c); return t;
  }).join(' '));
  console.log('equity(AA vs BB跟注范围): ' +
    (C.estimateWin(HOLE_AI, community, 1, 4000, null, null, [BB_CALL]) * 100).toFixed(1) + '%');
  // 采样多次，统计选项频率分布
  const tally = {};
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const a = C.aiDecide({
      hole: HOLE_AI, community: community, nOpp: 1,
      toCall: 0, pot: 5.5, chips: chips, bet: 0,
      minRaiseTo: 5, bb: 1, currentBet: 0,
      oppPctls: [0.27], oppRanges: [BB_CALL], selfRange: CO_OPEN,
      hasInitiative: true, effStack: chips, posIdx: 1, posName: 'CO',
      pf: { posName: 'CO', raises: 1, opener: 'CO', lastRaiser: 'CO' },
      openerPos: 'CO',
      isLastToAct: true,   // CO 在 BB 之后行动 = 有位置
      myChecks: myChecks || 0
    });
    const key = (a.opts || []).map(function (o) {
      return (o.label || o.act.type) + ':' + Math.round(o.prob * 100) + '%' + (o.chosen ? '*' : '');
    }).join(' | ') + '  => ' + a.type + (a.to !== undefined ? '@' + a.to : '');
    tally[key] = (tally[key] || 0) + 1;
  }
  Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; }).forEach(function (k) {
    console.log('  [' + (tally[k] / N * 100).toFixed(1) + '%] ' + k);
  });
}

/* 完整三街序列模拟：check 过翻牌后转牌/河牌带 myChecks 传入（与游戏内一致） */
function simulateLine(chips) {
  const N = 1000;
  const lines = {};
  for (let i = 0; i < N; i++) {
    const acts = [];
    let mc = 0;
    [FLOP, TURN, RIVER].forEach(function (community, si) {
      const a = C.aiDecide({
        hole: HOLE_AI, community: community, nOpp: 1,
        toCall: 0, pot: 5.5, chips: chips, bet: 0,
        minRaiseTo: 5, bb: 1, currentBet: 0,
        oppPctls: [0.27], oppRanges: [BB_CALL], selfRange: CO_OPEN,
        hasInitiative: true, effStack: chips, posIdx: 1, posName: 'CO',
        pf: { posName: 'CO', raises: 1, opener: 'CO', lastRaiser: 'CO' },
        openerPos: 'CO', isLastToAct: true, myChecks: mc
      });
      if (a.type === 'check') { mc++; acts.push('过'); }
      else { acts.push('注' + (a.to || '')); }
    });
    const k = acts.join('-');
    lines[k] = (lines[k] || 0) + 1;
  }
  console.log('\n===== AA 三街行动线分布（后手 ' + chips + '）=====');
  Object.keys(lines).sort(function (a, b) { return lines[b] - lines[a]; }).forEach(function (k) {
    console.log('  [' + (lines[k] / N * 100).toFixed(1) + '%] ' + k);
  });
}

[15, 25].forEach(function (chips) {
  console.log('\n================ AI 后手 ' + chips + '（SPR ' + (chips / 5.5).toFixed(1) + '）================');
  mkOpts(FLOP, chips, '翻牌 K♠2♦T♦');
  mkOpts(TURN, chips, '转牌 K♠2♦T♦6♣（翻牌已过牌）', 1);
  mkOpts(RIVER, chips, '河牌 K♠2♦T♦6♣K♥（翻牌转牌均过牌）', 2);
  simulateLine(chips);
});
console.log('\n说明：AI(CO) 在 BB 之后行动 = 有位置。河牌后位过牌保护逻辑失效，');
console.log('      近坚果（两对 AA+KK）应接近满频下注 —— 对照修复前为 73% 下注 / 27% 过牌。');
