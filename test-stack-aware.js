/* ============================================================
   后手感知（stack-aware）回归测试
   ------------------------------------------------------------
   验证 postflop-engine.js 的决策一律以「自身剩余筹码」为基准：
     ① 加注/下注额度绝不超过后手（超了就是全下）
     ② 后手不足以做合法加注时 → 不存在加注选项（没有弃牌率可言）
     ③ 底池赔率按"我实际能投入的钱"算（短码全下跟注吃不到溢出，赔率反而更好）
     ④ 隐含赔率按"跟注后还剩多少后手"折算（跟注即全下 → 隐含赔率 = 0）
     ⑤ MDF 用"下注前底池"作分母（页面 potTotal 传入的 pot 已含对手这一注）
   运行：node test-stack-aware.js
   ============================================================ */
'use strict';

const PF = require('./postflop-engine.js');
const C = require('./core.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; failures.push(msg); console.log('  ✗ ' + msg + (detail ? '  ← ' + detail : '')); }
}

const deck = C.makeDeck();
const card = (r, s) => deck.find(c => c.r === r && c.s === s);

/* 真实引擎（真 equity）与"定值胜率"引擎（受控测试用） */
const realStrat = PF.createPostflop({ estimateWin: C.estimateWin });
function stubStrat(eq) { return PF.createPostflop({ estimateWin: () => eq }); }

const FLOP = [card(12, 2), card(7, 2), card(2, 0)];        // Qh 7h 2c
const NUT_DRAW = [card(14, 2), card(13, 2)];               // AhKh 坚果同花听牌
const WEAK_DRAW = [card(5, 2), card(4, 2)];                // 5h4h
const AIR = [card(3, 0), card(2, 1)];                      // 3c2d 空气

function ctx(o) {
  return Object.assign({
    hole: NUT_DRAW, community: FLOP, nOpp: 1,
    toCall: 200, pot: 300, chips: 200, bb: 1, currentBet: 200, bet: 0,
    posName: 'BTN', pf: {}
  }, o || {});
}
/* 跑 n 次，返回 {type: 次数} */
function dist(strat, o, n) {
  n = n || 400;
  const t = {};
  for (let i = 0; i < n; i++) {
    const a = strat(ctx(o));
    t[a.type] = (t[a.type] || 0) + 1;
  }
  return t;
}
/* 最大加注额度（无限大表示没有加注） */
function maxRaiseTo(strat, o, n) {
  n = n || 400;
  let m = -1;
  for (let i = 0; i < n; i++) {
    const a = strat(ctx(o));
    if ((a.type === 'raise' || a.type === 'bet') && typeof a.to === 'number') m = Math.max(m, a.to);
  }
  return m;
}

/* =========================================================
   ① 加注/下注额度绝不超过后手
   ========================================================= */
console.log('\n--- ① 加注额度以"我的后手"为上限 ---');
{
  const stacks = [20, 50, 100, 200, 400, 1000, 5000, 30.25, 7.75, 199.5];
  const pots = [30, 100, 300, 1000];
  const bets = [10, 50, 200, 800];
  const holes = [NUT_DRAW, WEAK_DRAW, AIR, [card(8, 0), card(8, 1)], [card(12, 0), card(12, 1)]];
  let violations = 0, checked = 0, worst = null;
  for (const chips of stacks) {
    for (const pot of pots) {
      for (const currentBet of bets) {
        for (const hole of holes) {
          const o = { chips, pot, currentBet, bet: 0, hole, toCall: Math.min(currentBet, chips) };
          for (let i = 0; i < 12; i++) {
            const a = realStrat(ctx(o));
            checked++;
            if (typeof a.to === 'number' && a.to > chips + 1e-9) {
              violations++;
              worst = { chips, pot, currentBet, to: a.to, type: a.type };
            }
          }
        }
      }
    }
  }
  ok(violations === 0, '扫描 ' + checked + ' 次决策：加注/下注额无一超过后手',
    violations ? JSON.stringify(worst) : '');
}

/* =========================================================
   ② 后手不够做合法加注 → 不出现加注（没有弃牌率）
   ========================================================= */
console.log('\n--- ② 后手不足以加注时只跟/弃 ---');
{
  // 后手 200，对手已下 200：最小加注须到 400，物理上做不到 → 不允许出现加注
  const d = dist(realStrat, { chips: 200, toCall: 200, pot: 300, currentBet: 200 }, 500);
  ok(!d.raise, '后手 200 面对 200 下注：不出现加注选项（' + JSON.stringify(d) + '）');
  ok(maxRaiseTo(realStrat, { chips: 200, toCall: 200, pot: 300, currentBet: 200 }) === -1,
    '最大加注额度为空（此前会输出"加注至 266"超出后手）');

  // 后手充裕 → 应该存在加注
  const d2 = dist(realStrat, { chips: 1000, toCall: 200, pot: 300, currentBet: 200 }, 500);
  ok(d2.raise > 0, '后手 1000 同一局面：仍有加注（' + JSON.stringify(d2) + '）');
  ok(maxRaiseTo(realStrat, { chips: 1000, toCall: 200, pot: 300, currentBet: 200 }) <= 1000,
    '后手 1000 的加注额度 ≤ 1000');

  // 显式最小加注额（页面会传 minRaiseTo = currentBet + lastRaiseSize）
  const d3 = dist(realStrat, { chips: 300, toCall: 200, pot: 300, currentBet: 200, minRaiseTo: 400 }, 400);
  ok(!d3.raise, '未达最小加注额（后手 300 < minRaiseTo 400）：不出现加注（' + JSON.stringify(d3) + '）');
}

/* =========================================================
   ③ 底池赔率按"我实际能投入的钱"算（短码吃不到溢出 → 赔率更好）
   ========================================================= */
console.log('\n--- ③ 短码全下跟注：按有效底池算赔率 ---');
{
  const S = stubStrat(0.30);   // 固定 30% 胜率
  // 全码跟注：跟 200 赢 300+200=500 → 需 40% ＞ 30% → 弃
  const full = dist(S, { chips: 200, toCall: 200, pot: 300, currentBet: 200 }, 400);
  // 短码全下跟注：跟 50 赢 150+50=200 → 需 25% ＜ 30% → 跟（溢出 150 会退回对手，不算我的赢面）
  const short = dist(S, { chips: 50, toCall: 50, pot: 300, currentBet: 200 }, 400);
  ok(full.fold > full.call, 'eq=30% 全码跟注（需 40%）：多数弃牌（' + JSON.stringify(full) + '）');
  ok(short.call > 300, 'eq=30% 短码全下（只需 25%）：多数跟注（' + JSON.stringify(short) + '）');
  ok(short.raise === undefined || !short.raise, '短码跟不动时不存在加注（' + JSON.stringify(short) + '）');
}

/* =========================================================
   ④ 隐含赔率按剩余后手折算：跟注即全下 → 隐含赔率 = 0
   ========================================================= */
console.log('\n--- ④ 隐含赔率随"跟注后剩余后手"缩放 ---');
{
  const S = stubStrat(0.38);   // 0.38 < 需要 0.42（potOdds 0.4 + 0.02）
  // 深后手：跟注后还剩 800，隐含赔率 > 0 → 0.38+implied > 0.42 → 继续
  const deep = dist(S, { chips: 1000, toCall: 200, pot: 300, currentBet: 200 }, 400);
  // 跟注即全下：没有未来收益 → implied = 0 → 0.38 < 0.42 → 弃
  const allin = dist(S, { chips: 200, toCall: 200, pot: 300, currentBet: 200 }, 400);
  ok(deep.call > 300, '深后手（跟注后还剩 800）：听牌继续投入（' + JSON.stringify(deep) + '）');
  ok(allin.fold > allin.call, '跟注即全下：隐含赔率归零 → 多数弃牌（' + JSON.stringify(allin) + '）');
  ok(deep.call > allin.call, '同一手牌：深后手比"全下跟注"更倾向继续（' + deep.call + ' > ' + allin.call + '）');

  // 河牌无隐含赔率：无论后手多少，都按纯赔率判断
  const RIVER = FLOP.concat([card(11, 0), card(9, 1)]);
  const deepRiver = dist(S, { chips: 1000, toCall: 200, pot: 300, currentBet: 200, community: RIVER }, 400);
  ok(deepRiver.fold > 300, '河牌（无未来街）：深后手也多数弃牌（' + JSON.stringify(deepRiver) + '）');
}

/* =========================================================
   ⑤ MDF 用"下注前底池"作分母（页面 pot 已含对手那一注）
   ========================================================= */
console.log('\n--- ⑤ MDF 口径：防线频率随下注尺度正确变化 ---');
{
  // 空气手 facing 2× 池（pot 传 300 = 下注前 100 + 对手 200）
  const vsOver = dist(realStrat, { hole: AIR, chips: 1000, toCall: 200, pot: 300, currentBet: 200 }, 600);
  // 空气手 facing 半池（pot 传 150 = 下注前 100 + 对手 50）
  const vsHalf = dist(realStrat, { hole: AIR, chips: 1000, toCall: 50, pot: 150, currentBet: 50 }, 600);
  const overCall = (vsOver.call || 0) / 600;
  const halfCall = (vsHalf.call || 0) / 600;
  ok(overCall < 0.20, '空气手 vs 2× 超池：防守频率 < 20%（实际 ' + (overCall * 100).toFixed(1) + '%，'
    + '错误口径下约 20%+，正确 MDF≈11%）');
  ok(halfCall > overCall * 1.5, '下注越小防守越多：半池防守(' + (halfCall * 100).toFixed(1) + '%) > 1.5×超池防守('
    + (overCall * 100).toFixed(1) + '%)');
}

/* =========================================================
   ⑥ 无人下注（check to me）时下注额同样以后手为上限
   ========================================================= */
console.log('\n--- ⑥ 主动下注额不超后手 ---');
{
  const S = stubStrat(0.9);   // 强牌（坚果走价值下注）
  const d = dist(S, { hole: [card(12, 0), card(12, 1)], chips: 30, toCall: 0, pot: 1000, currentBet: 0 }, 400);
  const mx = maxRaiseTo(S, { hole: [card(12, 0), card(12, 1)], chips: 30, toCall: 0, pot: 1000, currentBet: 0 }, 400);
  ok(mx <= 30, '后手 30、底池 1000：下注额被压到 ≤ 30（实际 ' + mx + '）');
  ok((d.raise || 0) > 0, '仍能下注（体现为全下）( ' + JSON.stringify(d) + ' )');
}

/* ========================================================= */
console.log('\n--- ⑧ analyzeBoard().text 拼写（低牌不得走数字加法） ---');
{
  /* 曾出过的 bug：`(RANK_FROM_R[r] || r) + ...` 中 2~9 回落成数字，
     又恰在拼接表达式首位 → `+` 变数值相加（9d9s2c = 9+9+2 = 20，
     7d7s7c = 21）。现改为 rankText() 逐张转字符串再 join。 */
  const T = (a, b, c) => PF.analyzeBoard([card(a, 2), card(b, 1), card(c, 0)]).text;
  const low = PF.analyzeBoard([card(9, 2), card(9, 0), card(2, 3)]);   // 9d 9s 2c
  ok(low.text === '992', '重复低对 9d9s2c → "992"（实际 ' + JSON.stringify(low.text) + '）');
  ok(typeof low.text === 'string', 'text 类型为 string（不是数字 ' + typeof low.text + '）');
  ok(T(9, 8, 2) === '982', '9d8s2c → "982"（实际 ' + JSON.stringify(T(9, 8, 2)) + '）');
  ok(T(4, 3, 2) === '432', '4h3d2c → "432"（实际 ' + JSON.stringify(T(4, 3, 2)) + '）');
  ok(T(7, 7, 7) === '777', '三条 7d7s7c → "777"（实际 ' + JSON.stringify(T(7, 7, 7)) + '）');
  ok(T(14, 13, 2) === 'AK2', '高点：AdKs2c → "AK2"');
  ok(T(14, 14, 2) === 'AA2', '高对：AsAd2h → "AA2"');
  ok(T(10, 9, 2) === 'T92', '10 记为 T：Th9s2c → "T92"');
  const turn = PF.analyzeBoard([card(9, 2), card(9, 0), card(2, 3), card(7, 1), card(3, 2)]); // 9d 9s 2c 7h 3d
  ok(turn.text === '997', '转/河 text 只含最大的 3 张点数字（9d9s2c7h3d → "997"，实际 ' +
    JSON.stringify(turn.text) + '）；key 才是全 5 张以防缓存撞车');
  ok(turn.key.split('-').length === 5,
    'key 含全 5 张（实际 ' + turn.key.split('-').length + ' 段）—— text 撞车由 key 兜住');
  ok(PF.analyzeBoard([]).text === '', '空牌面不抛错、返回空串（实际 ' + JSON.stringify(PF.analyzeBoard([]).text) + '）');
}

/* ========================================================= */
console.log('\n========================================');
console.log('后手感知回归：' + pass + ' 通过, ' + fail + ' 失败');
if (fail) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)); }
console.log('========================================');
process.exit(fail ? 1 : 0);
