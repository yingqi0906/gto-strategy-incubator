/* 翻前策略 GTO 表一致性验证：
   1) 关键场景逐手牌决策 vs 表数据
   2) 全 169 手枚举采样宽度 vs 表期望宽度
   3) 挤压 / 冷4bet / 面对4bet 行动线抽查 */
const C = require('./core.js');
const GWP = require('./gw-ranges.js');
const GW = GWP.GW;

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
}
function holeOf(code) {
  const m = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  const r = (c) => m[c] || +c;
  const suited = code[2] === 's';
  return [{ r: r(code[0]), s: suited ? 0 : 0 }, { r: r(code[1]), s: suited ? 0 : 1 }];
}
/* 采样某手牌在给定 pf 下的动作分布 */
function dist(code, posName, pf, n) {
  n = n || 400;
  const hole = holeOf(code);
  const cnt = { raise: 0, call: 0, check: 0, fold: 0 };
  for (let t = 0; t < n; t++) {
    const a = C.aiDecide({ hole: hole, community: [], nOpp: 3, toCall: 1.5, pot: 3.5,
      chips: 98, bb: 1, currentBet: pf.raises ? pf.lastSize : 1, posName: posName, pf: pf, bet: 1, posIdx: 3 });
    cnt[a.type]++;
  }
  return cnt;
}
const pct = (x, n) => Math.round(100 * x / n);

console.log('== 1. 关键场景 ==');
let pf1 = { raises: 1, opener: 'UTG', threeBettor: null, lastRaiser: 'UTG', lastSize: 2.5, callers: 0, firstCaller: null, limper: null };
let d = dist('AKo', 'HJ', pf1);
chk('AKo(HJ) vs UTG open: 3bet ~96%', Math.abs(pct(d.raise, 400) - 96) <= 4, '实测 3bet ' + pct(d.raise, 400) + '%');
d = dist('A5s', 'HJ', pf1);
chk('A5s(HJ) vs UTG open: 3bet 67%/call 10%（表混合）', Math.abs(pct(d.raise, 400) - 67) <= 7, '实测 ' + pct(d.raise, 400) + '%');
d = dist('72o', 'HJ', pf1);
chk('72o(HJ) vs UTG open: 100% 弃牌', d.fold === 400);
d = dist('72o', 'UTG', { raises: 0 });
chk('72o UTG RFI: 100% 弃牌', d.fold === 400);
d = dist('AA', 'UTG', { raises: 0 });
chk('AA UTG RFI: 100% 加注', d.raise === 400);
d = dist('77', 'UTG', { raises: 0 });
chk('77 UTG RFI: 加注 76%/弃牌 24%（GTO Wizard 混合）', Math.abs(pct(d.raise, 400) - 76) <= 8, '实测 ' + pct(d.raise, 400) + '%');

/* 加注尺度与训练模式按钮同源校验：
   pf 必须携带 posName，raiseSizeFor 才能区分 SB 3bb / 其他 2.5bb（训练结算依赖此一致性） */
function raiseToOf(code, posName, pf) {
  const a = C.aiDecide({ hole: holeOf(code), community: [], nOpp: 3, toCall: pf.raises ? pf.lastSize - 1 : 1.5,
    pot: 3.5, chips: 98, bb: 1, currentBet: pf.raises ? pf.lastSize : 1,
    posName: posName, pf: Object.assign({}, pf, { posName: posName }), bet: 1, posIdx: 3 });
  return a.type === 'raise' ? a.to : null;
}
let to = raiseToOf('AA', 'SB', { raises: 0 });
chk('AA(SB) RFI 开池尺度 = 3.5bb（策略树 SIZE_OPEN.SB）', to === 3.5, '实测 ' + to);
to = raiseToOf('AA', 'UTG', { raises: 0 });
chk('AA(UTG) RFI 开池尺度 = 2.5bb', to === 2.5, '实测 ' + to);
to = raiseToOf('AA', 'BB', { raises: 0, limper: 'UTG', callers: 1, firstCaller: 'UTG' });
// BB 面对跛入：强牌 80% 加注 / 20% 过牌 → 采样多次取加注额度
{
  let hit = null;
  for (let i = 0; i < 60 && hit === null; i++) {
    const t = raiseToOf('AA', 'BB', { raises: 0, limper: 'UTG', callers: 1, firstCaller: 'UTG' });
    if (t !== null) hit = t;
  }
  chk('AA(BB) 超过跛入的加注尺度 = 4bb', hit === 4, '实测 ' + hit);
}
chk('raiseSizeFor 已导出（训练按钮同源依赖）', typeof C.raiseSizeFor === 'function');

/* ===== 加注尺度按位置查表（与「6max翻前范围表」策略树逐项对齐）===== */
console.log('== 1b. 加注尺度：不同位置不同尺度 ==');
const rs = GWP.raiseSizeFor;
chk('RFI SB = 3.5bb', rs({ raises: 0, posName: 'SB' }) === 3.5);
chk('RFI BTN = 2.5bb', rs({ raises: 0, posName: 'BTN' }) === 2.5);
chk('RFI UTG = 2.5bb', rs({ raises: 0, posName: 'UTG' }) === 2.5);
const pf3b = (opener) => ({ raises: 1, opener: opener, lastSize: opener === 'SB' ? 3.5 : 2.5, callers: 0, firstCaller: null });
chk('3bet BTN vs UTG open = 8bb', rs(Object.assign({ posName: 'BTN' }, pf3b('UTG'))) === 8);
chk('3bet CO vs UTG open = 8bb', rs(Object.assign({ posName: 'CO' }, pf3b('UTG'))) === 8);
chk('3bet SB vs BTN open = 11bb', rs(Object.assign({ posName: 'SB' }, pf3b('BTN'))) === 11);
chk('3bet BB vs UTG open = 13.5bb', rs(Object.assign({ posName: 'BB' }, pf3b('UTG'))) === 13.5);
chk('3bet BB vs SB open = 10.5bb（SB 开池更小）', rs(Object.assign({ posName: 'BB' }, pf3b('SB'))) === 10.5);
const pfSq = { raises: 1, opener: 'UTG', lastSize: 2.5, callers: 1, firstCaller: 'HJ' };
chk('挤压 3bet BTN = 11bb（有跟注者）', rs(Object.assign({ posName: 'BTN' }, pfSq)) === 11);
chk('挤压 3bet SB = 14bb', rs(Object.assign({ posName: 'SB' }, pfSq)) === 14);
chk('挤压 3bet BB = 14bb', rs(Object.assign({ posName: 'BB' }, pfSq)) === 14);
const pf4b = (tb) => ({ raises: 2, opener: 'UTG', lastSize: tb, callers: 0, firstCaller: null });
chk('4bet 开注者 @8bb 3bet = 21.5bb', rs(Object.assign({ posName: 'UTG' }, pf4b(8))) === 21.5);
chk('4bet 开注者 @10.5bb 3bet = 22bb', rs(Object.assign({ posName: 'UTG' }, pf4b(10.5))) === 22);
chk('4bet 开注者 @11bb 3bet = 23bb', rs(Object.assign({ posName: 'UTG' }, pf4b(11))) === 23);
chk('4bet 开注者 @13.5bb 3bet = 28.5bb', rs(Object.assign({ posName: 'UTG' }, pf4b(13.5))) === 28.5);
chk('4bet 开注者 @14bb 3bet = 29.5bb', rs(Object.assign({ posName: 'UTG' }, pf4b(14))) === 29.5);
chk('冷 4bet BTN @8bb 3bet = 17.5bb', rs(Object.assign({ posName: 'BTN' }, pf4b(8))) === 17.5);
chk('冷 4bet SB @8bb 3bet = 20bb', rs(Object.assign({ posName: 'SB' }, pf4b(8))) === 20);
chk('冷 4bet BTN @11bb 3bet = 24bb', rs(Object.assign({ posName: 'BTN' }, pf4b(11))) === 24);
chk('挤压线冷 4bet BTN @11bb = 24bb', rs({ raises: 2, posName: 'BTN', opener: 'UTG', lastSize: 11, callers: 1, firstCaller: 'HJ' }) === 24);
chk('挤压线冷 4bet CO @11bb = 27.5bb', rs({ raises: 2, posName: 'CO', opener: 'UTG', lastSize: 11, callers: 1, firstCaller: 'HJ' }) === 27.5);
chk('挤压线冷 4bet @14bb = 31bb（对 SB/BB 挤压，不分位置）',
  rs({ raises: 2, posName: 'CO', opener: 'UTG', lastSize: 14, callers: 1, firstCaller: 'HJ' }) === 31 &&
  rs({ raises: 2, posName: 'BTN', opener: 'UTG', lastSize: 14, callers: 1, firstCaller: 'HJ' }) === 31);
chk('5bet = 全下（100bb）', rs({ raises: 3, posName: 'SB', lastSize: 21.5 }) === 100);
chk('未知位置兜底 = 2.5bb', rs({ raises: 0, posName: 'XX' }) === 2.5);
/* 决策链路同样带位置尺度：aiDecide 在 SB 开池返回 3.5bb */
chk('aiDecide(SB RFI) 用 3.5bb', raiseToOf('AA', 'SB', { raises: 0 }) === 3.5);

console.log('== 2. 开注者面对 3bet（T3 表）==');
let pf2 = { raises: 2, opener: 'UTG', threeBettor: 'BTN', lastRaiser: 'BTN', lastSize: 8.5, callers: 0, firstCaller: null, limper: null };
d = dist('KK', 'UTG', pf2);
chk('KK(UTG) vs BTN 3bet: 4bet 100%', d.raise === 400);
d = dist('A5s', 'UTG', pf2);
chk('A5s(UTG) vs BTN 3bet: 4bet 26%/call 16%（表混合）', Math.abs(pct(d.raise, 400) - 26) <= 8, '实测 ' + pct(d.raise, 400) + '%');
d = dist('72o', 'UTG', pf2);
chk('72o(UTG) vs 3bet: 100% 弃牌', d.fold === 400);

console.log('== 3. 冷位置面对开注+3bet（CD 表）==');
let pf3 = { raises: 2, opener: 'UTG', threeBettor: 'CO', lastRaiser: 'CO', lastSize: 8.5, callers: 0, firstCaller: null, limper: null };
d = dist('AKs', 'BTN', pf3);
chk('AKs(BTN) 面对开注+3bet: 冷4bet 或弃牌（冷跟≈0）', d.call <= 20, '实测 call ' + pct(d.call, 400) + '%');
d = dist('JJ', 'BTN', pf3);
chk('JJ(BTN) 面对开注+3bet: 弃牌为主', pct(d.fold, 400) >= 60, '实测 fold ' + pct(d.fold, 400) + '%');

console.log('== 4. 开注+跟注后的第三方（OC 精确表）==');
let pf4 = { raises: 1, opener: 'UTG', threeBettor: null, lastRaiser: 'UTG', lastSize: 2.5, callers: 1, firstCaller: 'HJ', limper: null };
d = dist('AQs', 'BTN', pf4);
chk('AQs(BTN) UTG open + HJ 跟注：跟注为主、少量挤压（OC 表 12/88）',
  pct(d.call, 400) >= 70 && pct(d.raise, 400) >= 3 && pct(d.raise, 400) <= 25,
  '实测 raise ' + pct(d.raise, 400) + '% / call ' + pct(d.call, 400) + '%');
d = dist('JJ', 'BTN', pf4);
chk('JJ(BTN)：跟注为主（OC 表 0/100）', pct(d.call, 400) >= 90, '实测 call ' + pct(d.call, 400) + '%');
d = dist('77', 'BTN', pf4);
chk('77(BTN)：多数弃牌（OC 表跟注 26%）', pct(d.fold, 400) >= 60, '实测 fold ' + pct(d.fold, 400) + '%');
/* 尺度：有跟注者时走挤压尺度表（非 ×3 启发式） */
chk('挤压尺度 BTN = 11bb（UTG open + HJ 跟注）',
  (() => { const a = C.aiDecide({ hole: holeOf('AA'), community: [], nOpp: 3, toCall: 1.5, pot: 4.5, chips: 98, bb: 1,
    currentBet: 2.5, posName: 'BTN', pf: Object.assign({}, pf4, { posName: 'BTN' }), bet: 0, posIdx: 3 });
    return a.type === 'raise' && a.to === 11; })(), '挤压尺度应为 11bb');

console.log('== 5. 面对 4bet（V4 表）==');
let pf5 = { raises: 3, opener: 'UTG', threeBettor: 'BTN', lastRaiser: 'UTG', lastSize: 18.5, callers: 0, firstCaller: null, limper: null };
d = dist('QQ', 'BTN', pf5);
chk('QQ(BTN 3bet者) vs 4bet: 按表（call 或弃牌，少 5bet）', d.raise + d.call >= 300, '实测 继续 ' + pct(d.raise + d.call, 400) + '%');
d = dist('A5s', 'BTN', pf5);
chk('A5s(BTN 3bet者) vs 4bet: 弃牌为主（A5 型诈唬被 4bet 打走）', pct(d.fold, 400) >= 70, '实测 fold ' + pct(d.fold, 400) + '%');

console.log('== 6. 全 169 手枚举宽度 vs 表期望（组合加权）==');
function tableWidth(key) {
  const t = GW[key]; if (!t) return 0;
  let w = 0;
  for (const h in t) { const c = h[0] === h[1] ? 6 : (h[2] === 's' ? 4 : 12); w += c * (t[h][0] + t[h][1] + t[h][2]) / 100; }
  return w / 1326;
}
function enumWidth(posName, pf, iters) {
  iters = iters || 60;
  const RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  let def = 0, tot = 0;
  const bb = pf.raises ? pf.lastSize : 1;
  for (let i = 0; i < 13; i++) for (let j = i; j < 13; j++) {
    const pair = i === j;
    const suitPairs = pair ? [[0, 1]] : [[0, 1], [0, 0]]; // [不同花色=杂色, 相同花色=同花]
    for (const sp of suitPairs) {
      const cb = pair ? 6 : (sp[0] === sp[1] ? 4 : 12);
      const hole = [{ r: RANKS[i], s: sp[0] }, { r: RANKS[j], s: sp[1] }];
      let d2 = 0;
      for (let t = 0; t < iters; t++) {
        const a = C.aiDecide({ hole: hole, community: [], nOpp: 3, toCall: bb - 1, pot: 2 * bb,
          chips: 100 - bb, bb: 1, currentBet: bb, posName: posName, pf: pf, bet: 1, posIdx: 3 });
        if (a.type !== 'fold') d2++;
      }
      def += d2 / iters * cb; tot += cb;
    }
  }
  return def / tot;
}
const cases = [
  ['UTG RFI', 'UTG', { raises: 0 }, 'RFI|UTG'],
  ['HJ RFI', 'HJ', { raises: 0 }, 'RFI|HJ'],
  ['CO RFI', 'CO', { raises: 0 }, 'RFI|CO'],
  ['BTN RFI', 'BTN', { raises: 0 }, 'RFI|BTN'],
  ['BB vs BTN open', 'BB', { raises: 1, opener: 'BTN', lastRaiser: 'BTN', lastSize: 2.5, callers: 0, firstCaller: null }, 'VS|BTN|BB'],
  ['BB vs UTG open', 'BB', { raises: 1, opener: 'UTG', lastRaiser: 'UTG', lastSize: 2.5, callers: 0, firstCaller: null }, 'VS|UTG|BB'],
  ['SB vs BTN open', 'SB', { raises: 1, opener: 'BTN', lastRaiser: 'BTN', lastSize: 2.5, callers: 0, firstCaller: null }, 'VS|BTN|SB'],
  ['BTN vs UTG open', 'BTN', { raises: 1, opener: 'UTG', lastRaiser: 'UTG', lastSize: 2.5, callers: 0, firstCaller: null }, 'VS|UTG|BTN']
];
for (const [name, pos, pf, key] of cases) {
  const expect = tableWidth(key), got = enumWidth(pos, pf);
  chk(name + ': 采样 ' + (100 * got).toFixed(1) + '% ≈ 表 ' + (100 * expect).toFixed(1) + '%', Math.abs(got - expect) <= 0.03);
}

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
