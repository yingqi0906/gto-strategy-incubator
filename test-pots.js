/* 多路 allin 分池结构与筹码守恒验证（buildPots + 标签语义） */
const C = require('./core.js');
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + msg); }
}
function eq(a, b, msg) { assert(Math.abs(a - b) < 1e-9, msg + '（期望 ' + b + ' 实际 ' + a + '）'); }

/* 标签语义（与 showdown 内规则一致）：
   主池 = 所有未弃牌玩家均有资格；边池 = ≥2 名未弃牌玩家；仅1人 = 未遇注 */
function labelOf(pot, inHandTotal, multi) {
  if (!multi) return '';
  if (pot.eligible.length >= inHandTotal) return '主池';
  if (pot.eligible.length >= 2) return '边池';
  return '未遇注';
}

function runCase(name, contribs, inHand, expect) {
  const pots = C.buildPots(contribs, inHand);
  const inHandTotal = inHand.filter(Boolean).length;
  const total = pots.reduce(function (s, p) { return s + p.amount; }, 0);
  const contribSum = contribs.reduce(function (s, c) { return s + c; }, 0);
  eq(total, contribSum, name + '：分池总额=总投入');
  assert(pots.length === expect.length, name + '：池数（期望 ' + expect.length + ' 实际 ' + pots.length + '）');
  pots.forEach(function (p, i) {
    const e = expect[i];
    eq(p.amount, e.amount, name + '：池' + i + ' 金额');
    assert(JSON.stringify(p.eligible) === JSON.stringify(e.elig),
      name + '：池' + i + ' 资格（期望 [' + e.elig + '] 实际 [' + p.eligible + ']）');
    const lbl = labelOf(p, inHandTotal, pots.length > 1);
    assert(lbl === e.label, name + '：池' + i + ' 标签（期望 ' + e.label + ' 实际 ' + lbl + '）');
    // 均分守恒：share×n + 余量 = 池额
    if (e.winners) {
      const share = Math.floor((p.amount / e.winners.length) * 2) / 2;
      const rem = p.amount - share * e.winners.length;
      eq(share * e.winners.length + rem, p.amount, name + '：池' + i + ' 均分守恒');
    }
  });
  return pots;
}

/* 场景1：经典三路 allin（50/100/200，后手不同） */
runCase('三路allin', [50, 100, 200], [1, 1, 1], [
  { amount: 150, elig: [0, 1, 2], label: '主池' },
  { amount: 100, elig: [1, 2], label: '边池' },
  { amount: 100, elig: [2], label: '未遇注' } // 超出部分无人跟注 → 返还性质，不算边池
]);

/* 场景2：单人 allin 被更短码跟注 → 只有主池 + 未遇注，不应出现边池 */
runCase('短码allin', [50, 80], [1, 1], [
  { amount: 100, elig: [0, 1], label: '主池' },
  { amount: 30, elig: [1], label: '未遇注' }
]);

/* 场景3：中途弃牌留死钱 + 两路 allin（两个仅剩1人的相邻层合并为一条未遇注） */
runCase('死钱+两路allin', [50, 80, 200], [1, 0, 1], [
  { amount: 150, elig: [0, 2], label: '主池' },
  { amount: 180, elig: [2], label: '未遇注' }
]);

/* 场景4：四人全部 allin 同额 → 单池无标签 */
runCase('同额allin单池', [100, 100, 100, 100], [1, 1, 1, 1], [
  { amount: 400, elig: [0, 1, 2, 3], label: '' }
]);

/* 场景5：四人两档 allin（50/50/150/150）→ 主池200 + 边池200 */
runCase('四人两档allin', [50, 50, 150, 150], [1, 1, 1, 1], [
  { amount: 200, elig: [0, 1, 2, 3], label: '主池' },
  { amount: 200, elig: [2, 3], label: '边池' }
]);

/* 场景6：三人同额 allin 被第4人超额跟注（第4人弃牌？不行——未弃牌才相关。
   改为：三路 allin 100，第4人 allin 150 → 主池400 + 未遇注50 */
runCase('三路allin+超额', [100, 100, 100, 150], [1, 1, 1, 1], [
  { amount: 400, elig: [0, 1, 2, 3], label: '主池' },
  { amount: 50, elig: [3], label: '未遇注' }
]);

/* 场景7：0.5 粒度拆层（8.5/8.5/8 → 24 主池三人均分 + 1.0 两人边池） */
runCase('奇数平分', [8.5, 8.5, 8], [1, 1, 1], [
  { amount: 24, elig: [0, 1, 2], label: '主池', winners: [0, 1, 2] },
  { amount: 1.0, elig: [0, 1], label: '边池', winners: [0, 1] }
]);

console.log('共 ' + (pass + fail) + ' 项断言，通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
