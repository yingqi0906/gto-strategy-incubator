/* 核心逻辑自动化测试 */
const C = require('./core.js');
let pass = 0, fail = 0;

function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + msg); }
}

// 用文字构造牌：如 "As" = 黑桃A, "Hh" 不对 -> 用 s/h/d/c 后缀
function card(txt) {
  const rankMap = { A: 14, K: 13, Q: 12, J: 11, '10': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };
  const suitMap = { s: 0, h: 1, d: 2, c: 3 };
  const r = rankMap[txt.slice(0, -1)];
  const s = suitMap[txt.slice(-1)];
  return { r: r, s: s, id: r * 4 + s };
}
function hand(str) { return str.split(' ').map(card); }

/* --- 牌型评估 --- */
// 皇家同花顺
let s = C.best7(hand('As Ks Qs Js 10s 2h 3d')).score;
assert(C.cmpScore(s, [8, 14]) === 0, '皇家同花顺 识别, got ' + JSON.stringify(s));
// 同花顺
s = C.best7(hand('9h 8h 7h 6h 5h 2c 2d')).score;
assert(C.cmpScore(s, [8, 9]) === 0, '同花顺 识别, got ' + JSON.stringify(s));
// 四条 > 葫芦
s = C.best7(hand('9c 9d 9h 9s Ac Ad Ah 2c'.split(' ').slice(0, 7).join(' '))).score;
// 9 四条 + A 踢脚
assert(C.cmpScore(s, [7, 9, 14]) === 0, '四条9带A踢脚, got ' + JSON.stringify(s));
// 葫芦
s = C.best7(hand('Kc Kd Kh 5c 5d 2h 3s')).score;
assert(C.cmpScore(s, [6, 13, 5]) === 0, '葫芦 KKK55, got ' + JSON.stringify(s));
// 同花
s = C.best7(hand('Ad 9d 6d 4d 2d Kc Kd'.split(' ').slice(0, 7).join(' '))).score;
assert(s[0] === 5, '同花, got ' + JSON.stringify(s));
// 顺子（A2345 最小顺子）
s = C.best7(hand('Ah 2c 3d 4s 5h Kc Qd')).score;
assert(C.cmpScore(s, [4, 5]) === 0, 'A2345 顺子, got ' + JSON.stringify(s));
// 两对 + kicker
s = C.best7(hand('Ah Ad 3c 3d Kc 2h 2d'.split(' ').slice(0, 7).join(' '))).score;
// 上面 7 张: AA 33 22 K -> 最优两对 AA33 + K 踢脚
assert(C.cmpScore(s, [2, 14, 3, 13]) === 0, '两对 AA33K, got ' + JSON.stringify(s));
// 一对
s = C.best7(hand('7h 7d Kc 9d 4s 2h 3d')).score;
assert(C.cmpScore(s, [1, 7, 13, 9, 4]) === 0, '一对 7, got ' + JSON.stringify(s));
// 高牌
s = C.best7(hand('Ah Kd 9c 5s 3h 2c Jd')).score;
assert(C.cmpScore(s, [0, 14, 13, 11, 9, 5]) === 0, '高牌 A K J 9 5, got ' + JSON.stringify(s));

/* --- 大小比较 --- */
assert(C.cmpScore([1, 7], [1, 7]) === 0, '相等对');
assert(C.cmpScore([1, 8], [1, 7]) > 0, '大对 > 小对');
assert(C.cmpScore([4, 8], [3, 14]) > 0, '顺子 > 三条');
assert(C.cmpScore([5, 13], [4, 14]) > 0, '同花 > 顺子');

/* --- 边池计算 --- */
// 场景: 3人, A 投300弃牌, B 投300, C 投300 -> 单池900
let pots = C.buildPots([300, 300, 300], [false, true, true]);
assert(pots.length === 1 && pots[0].amount === 900 && pots[0].eligible.length === 2, '单池3人1弃');
// 场景: A 全下100, B/C 各投300 -> 主池300(3人) + 边池400(B,C)
pots = C.buildPots([100, 300, 300], [true, true, true]);
assert(pots.length === 2, '两池, got ' + pots.length);
assert(pots[0].amount === 300 && pots[0].eligible.length === 3, '主池 300 三人');
assert(pots[1].amount === 400 && pots[1].eligible.length === 2, '边池 400 两人');
// 场景: A 投500弃牌, B 投1000, C 投1000 -> B/C 无 all-in 差异，死钱并入单池 2500
pots = C.buildPots([500, 1000, 1000], [false, true, true]);
assert(pots.length === 1, '弃牌者死钱并入单池, got ' + pots.length);
assert(pots[0].amount === 2500, '单池 2500, got ' + pots[0].amount);
assert(pots[0].eligible.length === 2, '单池两人');
// 总额守恒
const total = [120, 340, 1000, 1000, 0, 55];
pots = C.buildPots(total, [true, true, true, false, false, true]);
const sum = pots.reduce(function (s2, p) { return s2 + p.amount; }, 0);
assert(sum === total.reduce(function (a, b) { return a + b; }, 0), '边池总额守恒, got ' + sum);

/* --- 胜率估算合理性 --- */
const aa = C.estimateWin(hand('Ah Ad'), [], 1, 300);
assert(aa > 0.75 && aa < 0.95, 'AA 对1人单挑胜率约85%, got ' + aa);
const trash = C.estimateWin(hand('7h 2d'), [], 1, 300);
assert(trash > 0.25 && trash < 0.5, '72o 单挑胜率约35%, got ' + trash);
const multi = C.estimateWin(hand('Ah Ad'), [], 5, 300);
assert(multi < aa, '对手越多 AA 胜率越低');

/* --- AI 决策 fuzz: 返回类型必须合法 --- */
let ok = true;
for (let t = 0; t < 300; t++) {
  const hole = hand('Ah Ad');
  const boardLen = [0, 3, 4, 5][t % 4];
  const community = boardLen === 0 ? [] : hand('2c 7d 9h'.split(' ').slice(0, boardLen).join(' '));
  const a = C.aiDecide({
    hole: hole, community: community, nOpp: 1 + (t % 4),
    toCall: [0, 20, 100, 500, 2000][t % 5], pot: [30, 200, 800][t % 3],
    chips: [200, 2000][t % 2], minRaiseTo: 40
  });
  if (['fold', 'check', 'call', 'raise'].indexOf(a.type) === -1) { ok = false; break; }
  if (a.type === 'raise' && !(a.to > 0)) { ok = false; break; }
}
assert(ok, 'AI 决策 fuzz 通过');

console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
