/* 翻前练习发牌 / 行动场景测试（2026-10-17 重构版）
   ① 源码挂接：先给玩家发牌、AI 不发真牌、按场景挑按钮位、场景预置在行动之前
   ② trainOpenUnion：5 个 RFI 位置并集 = 96 种手牌（剔除 73 种纯垃圾）
   ③ trainHoleKeys：无 spec = 并集按组合数加权；有 spec = 该位置该动作的真实频率
   ④ drawTrainHole：500 次抽样合规、两张不重复、避开已占用的牌、垃圾牌堆退化 null
   ⑤ 场景设置：4 个场景按钮 + 默认随机的 + 本地持久化读回
   ⑥ 场景注入逻辑：vs3bet 3bet 标记、rfi/vsopen 前位预置、免费过牌不弃牌 */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/gto策略培养皿.html', 'utf8');
const GW = require('./gw-ranges.js');
const C = require('./core.js');
global.GWPreflop = GW;
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; failures.push(msg); console.log('  ✗ ' + msg); }
}

/* ---------- ① 源码挂接 ---------- */
ok(/function trainHoleKeys\(spec\)/.test(html) && /function trainPickKey\(weights\)/.test(html) &&
  /function trainConcreteHole\(key, pool, used\)/.test(html) && /function drawTrainHole\(dk, spec\)/.test(html),
  '① 手牌抽样四件套存在（trainHoleKeys/trainPickKey/trainConcreteHole/drawTrainHole(dk,spec)）');

ok(/const meSeat = \(isTrain && act\.indexOf\(MP\.mySeat\) >= 0\) \? MP\.mySeat : -1;/.test(html),
  '① 先给玩家发牌（meSeat 在牌堆完整时确定）');
ok(/if \(!isTrain\) \{\s*\n\s*act\.forEach\(function \(seat\) \{/.test(html),
  '① AI 只在非训练模式发真牌（训练模式不占牌堆）');
ok(/deck = deck\.filter\(function \(c\) \{ return c\.id !== h\[0\]\.id && c\.id !== h\[1\]\.id; \}\);/.test(html),
  '① 玩家手牌抽走后从牌堆移除（公共牌不会重复）');
ok(/if \(updateTarget === 0\)/.test(html) === false && /const spec = trainScenario === 'vs3bet'/.test(html),
  '① vs3bet 场景用「本位置会开池」口径发玩家手牌');

/* AI 按行为反推手牌 */
ok(/function trainAssignHole\(p, actionType\)/.test(html) &&
  /if \(MP\.mode === 'train'\) \{\s*\n\s*const ta = trainAiAct\(p\);/.test(html),
  '① aiDecideAction 在训练模式优先走 trainAiAct（按频率行动 + 反推手牌）');
ok(/if \(MP\.mode === 'train' && p\.seatType && p\.inHand && !p\.hole\.length\)/.test(html),
  '① 训练模式 AI 未行动前渲染牌背占位（真牌为空的视觉兜底）');
ok(/if \(MP\.mode === 'single'\) \{\s*\n\s*players\.forEach\(function \(q\) \{/.test(html),
  '① AI 手牌日志只在单机模式打印（训练模式不再空手牌日志）');

/* 场景预置时序：必须在 bettingRound 之前 */
const iPre = html.indexOf('applyTrainScenarioPre();');
const iRound = html.indexOf('const r = await bettingRound(utgSeat);');
ok(iPre > 0 && iRound > 0 && iPre < iRound,
  '① 场景预置在首个行动者开跑之前（之后 AI 已经行动过就晚了）');
ok(/isTrain \? pickTrainButton\(\) : nextActive\(buttonIdx \+ 1\)/.test(html),
  '① 训练模式按钮位走 pickTrainButton（按场景避开不能坐的位置）');

/* ---------- ② trainOpenUnion ---------- */
const mUnion = html.match(/function trainOpenUnion\(\)[\s\S]*?\n  \}/);
const mCombo = html.match(/function trainComboCount\(h\)[\s\S]*?\n  \}/);
const mKeys = html.match(/function trainHoleKeys\(spec\)[\s\S]*?\n  \}/);
const mPick = html.match(/function trainPickKey\(weights\)[\s\S]*?\n  \}/);
const mConc = html.match(/function trainConcreteHole\(key, pool, used\)[\s\S]*?\n  \}/);
const mDraw = html.match(/function drawTrainHole\(dk, spec\)[\s\S]*?\n  \}/);
ok(!!mUnion && !!mCombo && !!mKeys && !!mPick && !!mConc && !!mDraw, '② 能从源码提取 6 个函数体');

const sandbox = new Function('GWPreflop', 'return (function(){' +
  ' var trainOpenUnionCache = null; var trainUsedIds = {};' +
  '\n' + mUnion[0] + '\n' + mCombo[0] + '\n' + mKeys[0] + '\n' + mPick[0] + '\n' + mConc[0] + '\n' + mDraw[0] +
  '\n return { trainOpenUnion: trainOpenUnion, trainComboCount: trainComboCount, trainHoleKeys: trainHoleKeys,' +
  ' trainConcreteHole: trainConcreteHole, drawTrainHole: drawTrainHole,' +
  ' used: function () { return trainUsedIds; }, resetUsed: function () { trainUsedIds = {}; },' +
  ' cache: function () { return trainOpenUnionCache; } }; })()')(GW);

const union = sandbox.trainOpenUnion();
const unionKeys = Object.keys(union);
ok(unionKeys.length === 96, '② 并集 = 96 种手牌（169 中剔除 73 种纯垃圾）');
ok(union['AA'] === 1 && union['AKo'] === 1 && union['T9s'] === 1 && union['A2s'] === 1,
  '② 强牌/边缘可玩牌在并集中（AA/AKo/T9s/A2s）');
ok(!union['72o'] && !union['82o'] && !union['Q2o'] && !union['J2o'] && !union['32o'],
  '② 任意位置都不开的组合不在并集（72o/82o/Q2o/J2o/32o）');
ok(!union['J2s'] && !union['72s'] && !union['43s'],
  '② 6max 各位置都不开的 suited 垃圾也不在并集（J2s/72s/43s）');
ok(sandbox.trainOpenUnion() === union && !!sandbox.cache(), '② 并集结果缓存（不重复遍历范围表）');

/* ---------- ③ trainHoleKeys ---------- */
const wAll = sandbox.trainHoleKeys(null);
ok(Object.keys(wAll).length === 96, '③ 无 spec = 5 位置并集（96 种）');
ok(wAll['AA'] === 6 && wAll['AKs'] === 4 && wAll['AKo'] === 12,
  '③ 并集权重 = 组合数（AA 6 / AKs 4 / AKo 12）');

const wUtg = sandbox.trainHoleKeys({ pos: 'UTG', action: 'raise' });
ok(Object.keys(wUtg).length === 48, '③ UTG 加注范围 = 48 种（GTO 表真实口径）');
ok(Math.abs(wUtg['AA'] - 6) < 1e-9, '③ UTG AA 100% 加注 → 权重 6');
ok(Math.abs((wUtg['T9s'] || 0) - 4 * 8 / 100) < 1e-9, '③ UTG T9s 8% 加注 → 权重 4×0.08');
ok(!wUtg['72o'] && !wUtg['32o'], '③ UTG 范围不含纯垃圾（72o/32o）');
ok(Object.keys(sandbox.trainHoleKeys({ pos: 'UTG', action: 'call' })).length === 0,
  '③ UTG 无跟注频率 → 跟注集合为空（调用方回退开池范围）');
ok(Object.keys(sandbox.trainHoleKeys({ pos: 'XXX', action: 'raise' })).length === 0 &&
  Object.keys(sandbox.trainHoleKeys({ pos: 'BTN', action: 'raise' })).length > 0,
  '③ 非法位置返回空表、BTN 正常有范围');
ok(sandbox.trainComboCount('AA') === 6 && sandbox.trainComboCount('AKs') === 4 &&
  sandbox.trainComboCount('AKo') === 12 && sandbox.trainComboCount('') === 0,
  '③ trainComboCount：对子 6 / 同花 4 / 异花 12 / 空 0');

/* ---------- ④ drawTrainHole ---------- */
let bad = 0, dup = 0, samples = 0;
for (let t = 0; t < 500; t++) {
  sandbox.resetUsed();
  const deck = C.shuffle(C.makeDeck());
  const h = sandbox.drawTrainHole(deck, null);
  if (!h) { bad++; continue; }
  samples++;
  if (h[0].id === h[1].id) dup++;
  if (!union[GW.handKeyOf(h)]) bad++;
}
ok(bad === 0, '④ 500 次抽样全部命中「至少一个位置会开池」的手牌（0 违规、0 抽空）');
ok(dup === 0, '④ 抽出的两张牌从不重复');
ok(samples === 500, '④ 牌堆完整时不会退化为 null（500/500）');

let badUtg = 0, nUtg = 0;
for (let t = 0; t < 300; t++) {
  sandbox.resetUsed();
  const deck = C.shuffle(C.makeDeck());
  const h = sandbox.drawTrainHole(deck, { pos: 'UTG', action: 'raise' });
  if (!h) continue;
  nUtg++;
  if (!wUtg[GW.handKeyOf(h)]) badUtg++;
}
ok(badUtg === 0 && nUtg === 300, '④ 指定 UTG 开池口径时 300/300 都在 UTG 加注范围内');

/* 已占用的牌不会被再发出来 */
sandbox.resetUsed();
const deckU = C.shuffle(C.makeDeck());
const first = sandbox.drawTrainHole(deckU, null);
sandbox.used()[first[0].id] = 1; sandbox.used()[first[1].id] = 1;
let clash = 0;
for (let t = 0; t < 200; t++) {
  const h = sandbox.drawTrainHole(deckU, null);
  if (!h) continue;
  if (h[0].id === first[0].id || h[0].id === first[1].id || h[1].id === first[0].id || h[1].id === first[1].id) clash++;
  sandbox.used()[h[0].id] = 1; sandbox.used()[h[1].id] = 1;
}
ok(clash === 0, '④ 200 次连抽不与玩家手牌/已反推的 AI 手牌撞牌');

/* trainConcreteHole 的三种形态 */
const deck2 = C.makeDeck();
const pp = sandbox.trainConcreteHole('AA', deck2, {});
ok(pp && pp[0].r === 14 && pp[1].r === 14 && pp[0].s !== pp[1].s, '④ AA → 两张 A 且花色不同');
const su = sandbox.trainConcreteHole('AKs', deck2, {});
ok(su && su[0].s === su[1].s && su[0].r === 14 && su[1].r === 13, '④ AKs → 同花色 A+K');
const of = sandbox.trainConcreteHole('AKo', deck2, {});
ok(of && of[0].s !== of[1].s && of[0].r === 14 && of[1].r === 13, '④ AKo → 不同花色 A+K');
ok(sandbox.trainConcreteHole('72o', [{ r: 7, s: 0, id: 1 }], {}) === null,
  '④ 牌池不足两张时返回 null（不崩）');

/* 垃圾牌堆：7s/2c/3d 三张任意两张都是被剔除的组合（72o/73o/23o）→ 退化为 null */
const junk = [{ r: 7, s: 0, id: 28 }, { r: 2, s: 3, id: 11 }, { r: 3, s: 1, id: 13 }];
ok(sandbox.drawTrainHole(junk, null) === null, '④ 牌堆只剩垃圾牌时返回 null（退化为常规发牌，不崩）');
ok(sandbox.drawTrainHole([], null) === null && sandbox.drawTrainHole(null, null) === null,
  '④ 空牌堆/null 防御');

/* ---------- ⑤ 场景设置 UI / 持久化 ---------- */
ok(/let trainScenario = 'random';/.test(html), '⑤ trainScenario 默认 random');
ok(/\{ key: 'random', label: '随机的'/.test(html) && /\{ key: 'rfi', label: '加注开池'/.test(html) &&
  /\{ key: 'vsopen', label: '面对加注'/.test(html) && /\{ key: 'vs3bet', label: '面对 3bet'/.test(html),
  '⑤ 4 个场景定义齐全（随机的/加注开池/面对加注/面对 3bet）');
['random', 'rfi', 'vsopen', 'vs3bet'].forEach(function (k) {
  ok(new RegExp('<button class="btn scene-btn" id="btn-scene-' + k + '" data-scene="' + k + '">').test(html),
    '⑤ 场景「' + k + '」是一个独立按钮');
});
ok(/trainScene: 'random'/.test(html) && /if \(typeof o\.trainScene === 'string'\) s\.trainScene = o\.trainScene;/.test(html),
  '⑤ 场景写入 APP_SETTINGS 并持久化读回（默认随机的）');
ok(/const ok = TRAIN_SCENES\.some\(function \(x\) \{ return x\.key === APP_SETTINGS\.trainScene; \}\);/.test(html),
  '⑤ 启动读回时校验合法值（非法值回落随机的）');
ok(/function syncTrainSceneUI\(\)/.test(html) && /classList\.toggle\('active', sc\.key === cur\)/.test(html),
  '⑤ openSettings 回填 active 态 + 场景说明文案');
ok(/function selectTrainScene\(key\)/.test(html) &&
  /if \(MP\.mode === 'train'\) \{\s*\n\s*\$\('settings-modal'\)\.classList\.add\('hidden'\);\s*\n\s*playHand\(null\);/.test(html),
  '⑤ 训练中点场景 → 关掉设置并 playHand(null) 按新场景重新发牌');
ok(/startLocal\('train', nick\);/.test(html) && /const ov = \$\('overlay'\);/.test(html),
  '⑤ 主菜单点场景 → 直接以该场景进入训练模式');
ok(/#train-scene-row \{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; \}/.test(html),
  '⑤ 场景按钮 2×2 栅格（手机上点得到）');

/* ---------- ⑥ 场景注入逻辑 ---------- */
ok(/if \(trainScenario === 'vs3bet' && pf\.raises === 1 && trainState\.threeBettor >= 0\)/.test(html),
  '⑥ vs3bet：玩家开池后由指定座位 3bet');
ok(/if \(p\.idx !== trainState\.threeBettor\) \{\s*\n\s*trainAssignHole\(p, 'fold'\);/.test(html),
  '⑥ vs3bet：中间的 AI 让位弃牌');
ok(/trainState\.threeBettor = -1;/.test(html), '⑥ 3bet 执行后清空标记（本手只触发一次）');
ok(/const before = order\.slice\(0, myPos\);/.test(html) && /before\.forEach\(function \(s\) \{ trainForceFold\(players\[s\]\); \}\);/.test(html),
  '⑥ rfi：玩家之前的 AI 全部弃牌（含玩家不在大盲的座位保证）');
ok(/const opener = players\[before\[Math\.floor\(Math\.random\(\) \* before\.length\)\]\];/.test(html),
  '⑥ vsopen：前位随机一人开池');
ok(/const after = order\.slice\(myPos \+ 1\);/.test(html) && /trainState\.threeBettor = after\[Math\.floor\(Math\.random\(\) \* after\.length\)\];/.test(html),
  '⑥ vs3bet：从玩家之后随机挑一人做 3bet');
ok(/const forbid = trainScenario === 'rfi' \? \['BB'\]/.test(html) &&
  /trainScenario === 'vsopen' \? \['UTG'\]/.test(html) &&
  /trainScenario === 'vs3bet' \? \['BB'\]/.test(html),
  '⑥ 按钮位避让：rfi/vs3bet 不坐大盲、vsopen 不坐枪口');
ok(/wFold = Math\.max\(0, 1326 - wRaise - wCall\)/.test(html),
  '⑥ 弃牌权重 = 1326 − 加注量 − 跟注量（按位置总体频率行动）');
ok(/if \(toCall <= 0\) \{ trainAssignHole\(p, 'call'\); return \{ type: 'check' \}; \}/.test(html),
  '⑥ 可免费过牌时不弃牌（BB 无人加注的选项）');
ok(/function trainForceOpen\(p\)/.test(html) && /pfCtx\.raises = 1;/.test(html) && /pfCtx\.opener = pn;/.test(html),
  '⑥ 强制开池会写翻前上下文（后续 AI / 玩家查表口径正确）');

/* ---------- 汇总 ---------- */
console.log('--- 翻前练习发牌/行动场景测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
if (fail) { console.log('失败项：'); failures.forEach(function (f) { console.log(' - ' + f); }); process.exit(1); }
