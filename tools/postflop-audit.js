/* 翻后策略审计：在固定局面下重复采样 AI 决策，输出动作频率与下注尺度分布。
   用法：node tools/postflop-audit.js [--json]
   目的：用数据暴露"不该有的 donk / 过度跟注 / 尺度错误"，并作为改造后的回归基准。 */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'core.js'));

const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT = { s: 0, h: 1, d: 2, c: 3 };
function card(code) { return { r: RANK[code[0]], s: SUIT[code[1]], id: RANK[code[0]] * 4 + SUIT[code[1]] }; }
function cards(str) { return str.split(' ').filter(Boolean).map(card); }

const N = +(process.argv.find(a => /^--n=/.test(a)) || '--n=400').split('=')[1];

/* 跑一个局面，返回动作分布 */
function probe(name, o) {
  const counts = {};
  const sizes = [];
  let potPctSum = 0, potPctN = 0;
  for (let i = 0; i < N; i++) {
    const a = C.aiDecide(Object.assign({}, o));
    let key = a.type;
    if (a.type === 'raise') {
      const to = a.to || 0;
      const add = to - (o.bet || 0);
      sizes.push(to);
      if (o.pot > 0) { potPctSum += add / o.pot; potPctN++; }
    }
    // 选项权重只统计一次（概率是确定的）
    if (i === 0 && a.opts) {
      const mix = a.opts.map(x => x.label + ' ' + Math.round(x.prob * 100) + '%').join(' | ');
      counts.__mix = mix;
    }
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    name,
    dist: Object.keys(counts).filter(k => k !== '__mix').map(k => k + ':' + (counts[k] / N * 100).toFixed(1) + '%').join('  '),
    mix: counts.__mix || '',
    avgPotPct: potPctN ? (potPctSum / potPctN * 100).toFixed(0) + '%' : '-'
  };
}

const base = { bb: 2, chips: 200, nOpp: 2, oppPctls: [0.3, 0.3], posIdx: 0, posName: 'BTN', pf: { raises: 1, opener: 'BTN', lastRaiser: 'BTN' } };

const cases = [];

/* 场景 1：BTN 开池，BB 跟注。flop K72r，BTN 持 AKo（顶对顶踢）—— 标准 c-bet 局面 */
cases.push(probe('1. [IP 有主动权] K72r, BTN持AKo, 无人下注',
  Object.assign({}, base, { hole: cards('As Kh'), community: cards('Kd 7c 2s'), toCall: 0, pot: 12, currentBet: 0, hasInitiative: true })));

/* 场景 2：同局面，BTN 持 76s（空气，无摊牌价值）—— 应高频 c-bet 诈唬，不该永远过牌 */
cases.push(probe('2. [IP 有主动权] K72r, BTN持76s(空气), 无人下注',
  Object.assign({}, base, { hole: cards('7h 6h'), community: cards('Kd 7c 2s'), toCall: 0, pot: 12, currentBet: 0, hasInitiative: true })));

/* 场景 3：DONK 测试。BB 在 BTN 开池、BB 跟注后，翻牌 BTN 过牌、BB 面对无人下注 */
cases.push(probe('3. [OOP 无主动权] K72r, BB持TT, 无人下注(应多为过牌)',
  Object.assign({}, base, { hole: cards('Th Ts'), community: cards('Kd 7c 2s'), toCall: 0, pot: 12, currentBet: 0, posIdx: 1, posName: 'BB', hasInitiative: false })));

/* 场景 4：OOP 持顶对，面对 IP 的下注 —— 应跟注/加注，不该弃 */
cases.push(probe('4. [OOP 面对下注] K72r, BB持KQs(顶对), 面对 8 (2/3池)',
  Object.assign({}, base, { hole: cards('Ks Qs'), community: cards('Kd 7c 2s'), toCall: 8, pot: 12, currentBet: 8, posIdx: 1, posName: 'BB', hasInitiative: false })));

/* 场景 5：OOP 持垃圾，面对小注 —— MDF 测试：面对 1/3 池应防守足够多，面对 1.5x 池应大幅弃牌 */
cases.push(probe('5a. [MDF] K72r, BB持54o(空气), 面对 4 (1/3池)',
  Object.assign({}, base, { hole: cards('5h 4d'), community: cards('Kd 7c 2s'), toCall: 4, pot: 12, currentBet: 4, posIdx: 1, posName: 'BB' })));
cases.push(probe('5b. [MDF] K72r, BB持54o(空气), 面对 30 (2.5x池)',
  Object.assign({}, base, { hole: cards('5h 4d'), community: cards('Kd 7c 2s'), toCall: 30, pot: 12, currentBet: 30, posIdx: 1, posName: 'BB' })));

/* 场景 6：SPR 测试。浅筹码 (SPR~1.5) 持顶对，面对下注应倾向全下；深筹码应控制池底 */
cases.push(probe('6a. [SPR低] K72r, 持AKo顶对, SPR=1.5, 面对 20',
  Object.assign({}, base, { hole: cards('As Kh'), community: cards('Kd 7c 2s'), toCall: 20, pot: 30, currentBet: 20, chips: 45, effStack: 45, bet: 0, posIdx: 1, posName: 'BB', hasInitiative: false })));
cases.push(probe('6b. [SPR高] K72r, 持AKo顶对, SPR=10, 面对 20',
  Object.assign({}, base, { hole: cards('As Kh'), community: cards('Kd 7c 2s'), toCall: 20, pot: 30, currentBet: 20, chips: 300, effStack: 300, bet: 0, posIdx: 1, posName: 'BB', hasInitiative: false })));

/* 场景 7：河牌薄价值。持中等对子，无人下注，河牌应检查/小额价值，不该大注 */
cases.push(probe('7. [River] K72-3-9, BTN持99(中三条), 无人下注',
  Object.assign({}, base, { hole: cards('9h 9s'), community: cards('Kd 7c 2s 3h 9c'), toCall: 0, pot: 40, currentBet: 0 })));

/* 场景 8：无摊牌价值的纯空气在河牌面对下注，应弃牌 */
cases.push(probe('8. [River] K72-3-9, BB持54o(空气), 面对 25',
  Object.assign({}, base, { hole: cards('5h 4d'), community: cards('Kd 7c 2s 3h 9c'), toCall: 25, pot: 40, currentBet: 25, posIdx: 1, posName: 'BB' })));

/* 场景 9：湿润牌面。持顶对在听牌面面对下注 */
cases.push(probe('9. [湿润面] T98两同花, 持AA, 面对 2/3池',
  Object.assign({}, base, { hole: cards('As Ah'), community: cards('Th 9h 8c'), toCall: 20, pot: 30, currentBet: 20, posIdx: 1, posName: 'BB' })));

/* 场景 10：多人池。3人，持顶对无人下注 */
cases.push(probe('10. [多人池] K72r, BTN持AKo顶对, 2对手, 无人下注',
  Object.assign({}, base, { hole: cards('As Kh'), community: cards('Kd 7c 2s'), toCall: 0, pot: 30, currentBet: 0, nOpp: 3, oppPctls: [0.3, 0.3, 0.3] })));

/* 场景 11：配对河牌的近坚果两对，后位。AA 在 K-2-T-6-K = 两对 AA+KK（只输 66/Kx），
   对手已过牌且我在后位 → 过牌保护逻辑失效，下注频率应接近满频
   （此前 27% 过牌是"频率与手牌强度无关 + 无位置区分"的产物） */
cases.push(probe('11. [River两对·后位] K-2-T-6-K配对河牌, BTN持AA(近坚果两对), 无人下注',
  Object.assign({}, base, { hole: cards('As Ah'), community: cards('Ks 2d Td 6c Kh'),
    toCall: 0, pot: 12, currentBet: 0, nOpp: 1, oppPctls: [0.27], hasInitiative: true, isLastToAct: true })));

/* 场景 12：多街计划。翻牌过牌后（myChecks=1），转牌有主动权的强牌应高频补注（stab），
   而不是每街独立掷骰（此前 AA 有 9% 概率连过翻转两条街） */
cases.push(probe('12. [stab] K-2-T-6, BTN持AA, 翻牌已过牌(myChecks=1), 无人下注',
  Object.assign({}, base, { hole: cards('As Ah'), community: cards('Ks 2d Td 6c'),
    toCall: 0, pot: 12, currentBet: 0, nOpp: 1, oppPctls: [0.27], hasInitiative: true, isLastToAct: true, myChecks: 1 })));

/* 输出 + 回归断言 */
const json = process.argv.includes('--json');
if (json) { console.log(JSON.stringify(cases, null, 2)); }
else {
  console.log('='.repeat(96));
  console.log('翻后策略审计  (每局面采样 ' + N + ' 次)');
  console.log('='.repeat(96));
  cases.forEach(function (c) {
    console.log('\n' + c.name);
    console.log('  实际动作分布 : ' + c.dist);
    console.log('  选项权重混合 : ' + c.mix);
    console.log('  平均下注尺度 : ' + c.avgPotPct + ' 池底');
  });
  console.log('\n' + '='.repeat(96));
}

/* 回归断言：把已修复的三类反常行为固化为不变量，防止未来改动回退。
   每项检查一个局面的动作分布必须落在 GTO 合理区间内。 */
function pct(dist, act) {
  const m = dist.match(new RegExp(act + ':(\\d+(?:\\.\\d+)?)%'));
  return m ? parseFloat(m[1]) : 0;
}
/* 用例索引映射（按上面 push 顺序）：
   0=1 IP有主动权顶对 | 1=2 IP空气 | 2=3 OOP无主动权TT | 3=4 OOP顶对面对下注
   4=5a 空气面对1/3池 | 5=5b 空气面对2.5x池 | 6=6a SPR低顶对 | 7=6b SPR高顶对
   8=7 河牌三条 | 9=8 河牌空气 | 10=9 湿润面AA | 11=10 多人池
   12=11 配对河牌近坚果两对 | 13=12 翻牌过牌后转牌stab */
const checks = [
  { i: 2, name: 'OOP 无主动权不应 donk（下注率 ≤ 5%）', fn: c => pct(c.dist, 'raise') <= 5 },
  { i: 3, name: '顶对面对 2/3 池：不得弃牌（弃牌率 ≤ 5%）', fn: c => pct(c.dist, 'fold') <= 5 },
  { i: 6, name: 'SPR 低时强牌应倾向投入筹码（加注率 ≥ 50%）', fn: c => pct(c.dist, 'raise') >= 50 },
  { i: 7, name: 'SPR 高时顶对以控池为主（弃牌率 ≤ 5%，加注率 ≤ 45%）', fn: c => pct(c.dist, 'fold') <= 5 && pct(c.dist, 'raise') <= 45 },
  { i: 9, name: '河牌空气面对下注应弃牌为主（弃牌率 ≥ 70%）', fn: c => pct(c.dist, 'fold') >= 70 },
  { i: 10, name: '湿润面强牌应加注保护（加注率 ≥ 30%）', fn: c => pct(c.dist, 'raise') >= 30 },
  { i: 0, name: 'IP 有主动权 + 顶对应高频下注（下注率 ≥ 60%）', fn: c => pct(c.dist, 'raise') >= 60 },
  { i: 1, name: 'IP 有主动权 + 空气应有一定 c-bet 频率（下注率 ≥ 40%）', fn: c => pct(c.dist, 'raise') >= 40 },
  { i: 12, name: '配对河牌近坚果两对（后位）应近满频下注（下注率 ≥ 90%）', fn: c => pct(c.dist, 'raise') >= 90 },
  { i: 13, name: '翻牌过牌后转牌应高频补注 stab（下注率 ≥ 85%）', fn: c => pct(c.dist, 'raise') >= 85 }
];
let bad = 0;
console.log('\n' + '='.repeat(96));
console.log('回归断言');
console.log('='.repeat(96));
checks.forEach(function (ch) {
  const c = cases[ch.i];
  if (!c) return;
  const ok = ch.fn(c);
  if (!ok) bad++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + ch.name + '  [' + c.dist + ']');
});
console.log('\n' + (bad ? bad + ' 项断言失败' : '全部断言通过'));
process.exit(bad ? 1 : 0);
