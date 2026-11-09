/* test-postflop-table.js —— 翻后策略表（flop 查表）回归（2026-10-19）
 *
 * 覆盖：
 *   ① 数据包完整（场景数、每面字段、桶数、尺寸）
 *   ② 真实查询：SRP BTN vs BB 的 flop 面 → IP 面对过牌拿到 c-bet 频率；OOP 拿到领先下注频率
 *   ③ 未覆盖场景返回 null（多人池 / 4-bet 池 / 翻牌前）
 *   ④ postflop-engine 在表就绪时的接入（c-bet 频率不再被单街常数高估）
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, name, detail) {
  if (c) { pass++; console.log('  ok ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

global.window = global;
require('./postflop-table-data.js');
const PT = require('./postflop-table.js');
const C = require('./core.js');
global.PokerCore = C;
const PF = require('./postflop-engine.js');   /* analyzeBoard 在翻后引擎里，不在 core */
global.PostflopEngine = PF;

const D = global.POSTFLOP_TABLE_DATA;
console.log('\n① 数据包');
ok(!!D && !!D.meta && !!D.scenarios, '数据包已加载');
const scenKeys = Object.keys(D.scenarios || {});
ok(scenKeys.length >= 8, '场景数 ≥ 8（SRP + 3BP 常见组合）', String(scenKeys.length));
ok(scenKeys.some(k => k.indexOf('3BP|') === 0), '包含 3-bet 池场景', scenKeys.filter(k => k.indexOf('3BP|') === 0).join(','));
ok(D.meta.buckets === 15 && D.meta.iters >= 10000, '口径：15 桶 / 迭代 ≥ 1 万', JSON.stringify(D.meta));
const f0 = D.scenarios[scenKeys[0]].faces[0];
ok(Array.isArray(f0.root.m) && f0.root.m.length === 15, '每面 15 桶 × 动作分布', String(f0.root.m && f0.root.m.length));
ok(PT.load(D) === true, 'PostflopTable.load() 接受数据包');
ok(PT.ready() === true, 'ready() = true');

console.log('\n② 真实查询（SRP BTN vs BB）');
const hole = [{ r: 13, s: 0, id: 'Kh' }, { r: 12, s: 1, id: 'Qd' }];
const board = [
  { r: 14, s: 0, id: 'Ah' }, { r: 8, s: 1, id: '8d' }, { r: 3, s: 2, id: '3c' }
];
const bd = PF.analyzeBoard(board);
ok(!!bd && !!bd.bucket, 'analyzeBoard 给出牌面桶', bd && JSON.stringify(bd.bucket));
const pf = { raises: 1, opener: 'BTN', firstCaller: 'BB', threeBettor: null, lastRaiser: 'BTN' };
const rIP = PT.lookup({ pf: pf, posName: 'BTN', board: bd, nOpp: 1, toCall: 0, currentBet: 0, myBet: 0, hole: hole });
ok(!!rIP, 'IP 面对过牌命中策略表');
if (rIP) {
  ok(typeof rIP.freq === 'number' && rIP.freq >= 0 && rIP.freq <= 1, 'c-bet 频率在 [0,1]', String(rIP.freq));
  ok(typeof rIP.size === 'number' && rIP.size > 0 && rIP.size <= 2, '主导尺寸是合理底池比例', String(rIP.size));
  ok(!!rIP.holeKey && rIP.bucket != null, '逐手牌映射到桶', rIP.holeKey + ' → 桶 ' + rIP.bucket);
  console.log('     IP c-bet=' + (rIP.freq * 100).toFixed(0) + '% 主尺寸=' + (rIP.size * 100).toFixed(0) + '% 桶=' + rIP.bucket + ' / ' + rIP.holeKey);
}
const rOOP = PT.lookup({ pf: pf, posName: 'BB', board: bd, nOpp: 1, toCall: 0, currentBet: 0, myBet: 0, hole: hole });
ok(!!rOOP, 'OOP 首个决策命中策略表');
if (rOOP) {
  ok(rOOP.freq >= 0 && rOOP.freq <= 1, '领先下注频率在 [0,1]', String(rOOP.freq));
  console.log('     OOP lead=' + (rOOP.freq * 100).toFixed(0) + '%');
}

console.log('\n③ 未覆盖场景 = null（不猜）');
ok(PT.lookup({ pf: pf, posName: 'BTN', board: bd, nOpp: 3, toCall: 0, currentBet: 0, myBet: 0, hole }) === null,
  '多人池 → null');
ok(PT.lookup({ pf: { raises: 3, opener: 'BTN', firstCaller: 'BB', threeBettor: 'BB' }, posName: 'BTN', board: bd, nOpp: 1, toCall: 0, currentBet: 0, myBet: 0, hole }) === null,
  '4-bet 池（raises=3）→ null');
ok(PT.lookup({ pf: pf, posName: 'BTN', board: bd, nOpp: 1, toCall: 40, currentBet: 40, myBet: 0, hole }) === null,
  '面对下注（表未存该节点）→ null');
ok(PT.lookup({ pf: pf, posName: 'CO', board: bd, nOpp: 1, toCall: 0, currentBet: 0, myBet: 0, hole }) === null,
  '位置与场景不符 → null');
ok(PT.lookup(null) === null && PT.lookup({}) === null, '空参数防御');

console.log('\n④ 与翻后引擎的接入');
const eng = fs.readFileSync(path.join(__dirname, 'postflop-engine.js'), 'utf8');
ok(/typeof PostflopTable !== 'undefined'[\s\S]{0,120}PostflopTable\.ready\(\)/.test(eng),
  'postflop-engine 探测 PostflopTable.ready()');
ok(/PostflopTable\.lookup\(/.test(eng), 'postflop-engine 调用 lookup()');
ok(/if \(TL && TL\.freq != null\)/.test(eng) && /cbet: clampNum\(TL\.freq/.test(eng), '命中表时才覆盖 c-bet 常数（未命中保持原逻辑）');
ok(/sizeTbl: TL\.size/.test(eng), 'flop 下注尺寸也由表决定（sizeTbl）');
ok(typeof PF.createPostflop === 'function', 'postflop-engine 可创建策略器');

console.log('\n--- 结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
process.exit(fail ? 1 : 0);
