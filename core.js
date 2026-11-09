/* 德州扑克核心逻辑：牌堆、牌型评估、胜率估算、AI 决策、边池计算 */
(function (global) {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANK_TEXT = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };

  function makeDeck() {
    const deck = [];
    for (let r = 2; r <= 14; r++) {
      for (let s = 0; s < 4; s++) {
        deck.push({ r: r, s: s, id: r * 4 + s });
      }
    }
    return deck;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function cardText(c) {
    return RANK_TEXT[c.r] + SUITS[c.s];
  }

  function isRed(c) {
    return c.s === 1 || c.s === 2; // ♥ ♦
  }

  /* 评估 5 张牌，返回可比较的分值数组 [类别, 决胜张...] */
  function score5(cards) {
    const ranks = cards.map(function (c) { return c.r; }).sort(function (a, b) { return b - a; });
    const flush = cards.every(function (c) { return c.s === cards[0].s; });
    const uniq = Array.from(new Set(ranks));
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // A2345
    }
    const counts = {};
    ranks.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
    const groups = Object.keys(counts).map(function (k) { return [+k, counts[k]]; })
      .sort(function (a, b) { return b[1] - a[1] || b[0] - a[0]; });

    if (flush && straightHigh) return [8, straightHigh];
    if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
    if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
    if (flush) return [5].concat(ranks);
    if (straightHigh) return [4, straightHigh];
    if (groups[0][1] === 3) return [3, groups[0][0], groups[1][0], groups[2][0]];
    if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
    if (groups[0][1] === 2) return [1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
    return [0].concat(ranks);
  }

  function cmpScore(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  /* 从 n 张（n>=5）里选最优 5 张 */
  function best7(cards) {
    const n = cards.length;
    if (n < 5) return null;
    if (n === 5) return { score: score5(cards), cards: cards.slice() };
    const idx = [0, 1, 2, 3, 4];
    let best = null, bestCards = null;

    function tryCombo() {
      const five = idx.map(function (i) { return cards[i]; });
      const s = score5(five);
      if (!best || cmpScore(s, best) > 0) { best = s; bestCards = five; }
    }

    function comb(start, d) {
      if (d === 5) { tryCombo(); return; }
      for (let i = start; i <= n - (5 - d); i++) {
        idx[d] = i;
        comb(i + 1, d + 1);
      }
    }
    comb(0, 0);
    return { score: best, cards: bestCards };
  }

  function handName(score) {
    switch (score[0]) {
      case 8: return score[1] === 14 ? '皇家同花顺' : '同花顺';
      case 7: return '四条';
      case 6: return '葫芦';
      case 5: return '同花';
      case 4: return '顺子';
      case 3: return '三条';
      case 2: return '两对';
      case 1: return '一对';
      default: return '高牌';
    }
  }

  /* 蒙特卡洛估算胜率：当前手牌面对 nOpp 个对手的获胜概率。
     oppPctls（可选）：每个对手的翻前范围百分位阈值（0~1，1 = 任意两张牌）。
     范围内的对手通过拒绝采样抽取手牌（胜率不再按"任意两张牌"估算）
     knownOpps（可选）：已知的对手手牌（超能力A），knownOpps[o] 为该对手的两张牌，命中则不再随机抽
     oppRanges（可选）：每个对手的范围权重表（postflop-engine 的 filterRange 产出）。
       给出时优先按权重采样，这比百分位拒绝采样精确得多——能反映牌面过滤后的真实范围构成。 */
  function estimateWin(hole, community, nOpp, iters, oppPctls, knownOpps, oppRanges) {
    iters = iters || 150;
    if (nOpp <= 0) return 1;
    const pctls = [];
    let anyRanged = false;
    for (let o = 0; o < nOpp; o++) {
      const v = oppPctls && oppPctls[o] !== undefined ? Math.min(1, Math.max(0, oppPctls[o])) : 1;
      if (v < 1) anyRanged = true;
      pctls.push(v);
    }
    const knownIds = {};
    hole.concat(community).forEach(function (c) { knownIds[c.id] = true; });
    if (knownOpps) {
      knownOpps.forEach(function (kh) {
        if (kh) kh.forEach(function (c) { if (c) knownIds[c.id] = true; });
      });
    }
    const base = makeDeck().filter(function (c) { return !knownIds[c.id]; });
    const need = 5 - community.length;
    // 范围权重表模式：每个对手独立维护"已占用牌"集合，按权重采样
    const rangeMode = !!(oppRanges && oppRanges.length &&
      oppRanges.some(function (r) { return r && Object.keys(r).length; }));
    let win = 0;
    for (let t = 0; t < iters; t++) {
      shuffle(base);
      let di = 0;
      const comm = community.concat(base.slice(di, di + need));
      di += need;
      const opps = [];
      // 本轮的占用表（范围采样需要知道哪些牌已被拿走）
      const used = {};
      comm.forEach(function (c) { used[c.id] = true; });
      for (let o = 0; o < nOpp; o++) {
        if (knownOpps && knownOpps[o] && knownOpps[o][0] && knownOpps[o][1]) {
          opps.push(knownOpps[o]); // 超能力A：已知对手底牌，直接使用
          used[knownOpps[o][0].id] = true; used[knownOpps[o][1].id] = true;
          continue;
        }
        // 优先：范围权重表采样
        if (rangeMode && oppRanges[o] && PF && PF.sampleFromRange) {
          const pick = PF.sampleFromRange(oppRanges[o], used);
          if (pick) {
            used[pick[0].id] = true; used[pick[1].id] = true;
            opps.push(pick);
            continue;
          }
        }
        if (!anyRanged || pctls[o] >= 1) {
          opps.push([base[di++], base[di++]]);
          continue;
        }
        // 拒绝采样：从剩余牌中抽取百分位 ≤ 阈值 的手牌（即对手范围内手牌）
        let h = null;
        const remain = base.length - di;
        for (let tries = 0; tries < 60; tries++) {
          if (remain < 2) break;
          const i = di + Math.floor(Math.random() * (base.length - di));
          let j = di + Math.floor(Math.random() * (base.length - di));
          if (i === j) continue;
          const cand = [base[i], base[j]];
          if (handPercentile(cand) <= pctls[o]) {
            // 把选中的两张移到队首占位，保持后续发牌不重叠
            let tmp = base[di]; base[di] = base[i]; base[i] = tmp;
            j = (j === di) ? i : j;
            tmp = base[di + 1]; base[di + 1] = base[j]; base[j] = tmp;
            di += 2;
            h = cand;
            break;
          }
        }
        opps.push(h || [base[di++], base[di++]]); // 60 次抽不到（超窄范围）则退化为随机
      }
      const my = best7(hole.concat(comm)).score;
      let isBest = true, tie = false;
      for (let o = 0; o < opps.length; o++) {
        const os = best7(opps[o].concat(comm)).score;
        const c = cmpScore(my, os);
        if (c < 0) { isBest = false; break; }
        if (c === 0) tie = true;
      }
      if (isBest) win += tie ? 0.5 : 1;
    }
    return win / iters;
  }

  /* ---------- GTO 风格策略 ---------- */

  // 预生成 169 种起手牌的强度百分位（0 = 最强，1 = 最弱）
  // 采用手工校准的 GTO 排序表（近似 GTO Wizard / 求解器的可玩性排序），
  // 保证 AKo/AQs/AKs 等顶档牌与中等对子的相对位置正确（旧启发式公式曾把 66 排在 AKo 之上导致策略错位）。
  function handScore(hi, lo, suited) { // 仅用于尾部残牌的粗排
    if (hi === lo) return 20 + hi;
    let s = hi + lo * 0.6;
    if (suited) s += 3;
    const gap = hi - lo;
    if (gap === 1) s += 2;
    else if (gap === 2) s += 1;
    else if (gap >= 5) s -= 2;
    if (hi === 14) s += 2;
    return s;
  }

  /* 手牌记法 → 内部键：'AA'→p14, 'AKs'→s14_13, '72o'→o7_2 */
  function rankOf(c) { return c === 'A' ? 14 : c === 'K' ? 13 : c === 'Q' ? 12 : c === 'J' ? 11 : c === 'T' ? 10 : +c; }
  function handKey(code) {
    const hi = rankOf(code[0]), lo = rankOf(code[1]);
    if (hi === lo) return 'p' + hi;
    return code[2] === 's' ? 's' + hi + '_' + lo : 'o' + hi + '_' + lo;
  }

  /* GTO 排序表（前 ~110 名精确校准，尾部残牌由公式粗排，不影响任何策略闸门） */
  const HAND_ORDER_TOP = [
    'AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', '99', 'AQs', 'AJs', 'AKo',
    'ATs', 'KQs', '88', 'QJs', 'KJs', 'A9s', 'QTs', 'KTs', 'AJo', '77',
    'JTs', 'AQo', 'A8s', 'KQo', 'K9s', 'Q9s', 'ATo', 'A5s', 'J9s', 'KJo',
    'A7s', '66', 'QJo', 'A4s', 'KTo', 'A3s', 'A6s', 'QTo', 'A2s', 'K8s',
    'Q8s', 'JTo', 'K9o', '55', 'A9o', 'T9s', 'J8s', 'A8o', 'K7s', 'K6s',
    '98s', 'A7o', 'T8s', '87s', 'K7o', '97s', 'J8o', 'Q7s', 'K5s', '86s',
    'Q6s', 'A6o', '76s', 'K6o', 'Q8o', 'J7s', 'T7s', 'A5o', '44', 'K5o',
    '96s', 'Q5s', 'J6s', 'A4o', '65s', '33', 'K4s', 'Q4s', '98o', 'J6o',
    '87o', 'T6s', 'K3s', '97o', '85s', 'K3o', 'A3o', 'J5s', 'T5s', '95s',
    'K2s', '76o', 'Q2s', 'J5o', '75s', '84s', 'T4s', 'J4s', 'K2o', '74s',
    'T5o', '65o', '54s', '86o', '22', 'J3s', 'T3s', '94s', '64s', 'J2s',
    '83s', 'A2o', '82s', 'T2s', '93s', '53s', '73s', '63s', '43s', '92s',
    '54o', '52s', '42s', '73o', '63o', '72s', '62s', '32s', '43o', '84o'
  ];

  const HAND_PCTL = (function () {
    const used = {};
    HAND_ORDER_TOP.forEach(function (c) { used[handKey(c)] = true; });
    const rest = [];
    for (let hi = 14; hi >= 2; hi--) {
      rest.push({ k: 'p' + hi, s: 20 + hi });
      for (let lo = hi - 1; lo >= 2; lo--) {
        rest.push({ k: 's' + hi + '_' + lo, s: handScore(hi, lo, true) });
        rest.push({ k: 'o' + hi + '_' + lo, s: handScore(hi, lo, false) });
      }
    }
    rest.sort(function (a, b) { return b.s - a.s; });
    const order = HAND_ORDER_TOP.map(handKey)
      .concat(rest.filter(function (e) { return !used[e.k]; }).map(function (e) { return e.k; }));
    const map = {};
    order.forEach(function (k, i) { map[k] = (i + 0.5) / order.length; });
    return map;
  })();

  function handPercentile(hole) {
    const hi = Math.max(hole[0].r, hole[1].r);
    const lo = Math.min(hole[0].r, hole[1].r);
    const k = hole[0].r === hole[1].r ? 'p' + hi
      : (hole[0].s === hole[1].s ? 's' + hi + '_' + lo : 'o' + hi + '_' + lo);
    return HAND_PCTL[k] !== undefined ? HAND_PCTL[k] : 0.5;
  }

  /* 选项混合器：记录每个候选动作及其频率，随机选中其一 */
  function buildOpts() {
    const list = [];
    return {
      add: function (label, prob, result) {
        if (prob > 0.001) list.push({ label: label, prob: prob, result: result });
      },
      decide: function (r) {
        let acc = 0;
        let chosen = list[list.length - 1];
        for (let i = 0; i < list.length; i++) {
          acc += list[i].prob;
          if (r < acc) { chosen = list[i]; break; }
        }
        const out = chosen.result;
        out.opts = list.map(function (o) {
          return { label: o.label, prob: o.prob, chosen: o === chosen,
                   act: { type: o.result.type, to: o.result.to } };
        });
        return out;
      }
    };
  }

  /* ===== GTO 翻前策略：直接查表（gw-ranges.js）=====
     数据逐格提取自 GTO Wizard Cash6mGeneral_6mNL25R25（100bb 无前注）解算截图，
     覆盖 RFI / 面对开注 / 开注者面对3bet / 冷4bet / 面对4bet 全部行动线及混合频率 */
  const GWP = (typeof module !== 'undefined' && module.exports)
    ? require('./gw-ranges.js')
    : global.GWPreflop;

  /* 翻牌前策略：完全由 GTO 范围表驱动（含逐手牌混合频率）
     o 需携带: hole, posName, pf(翻前行动上下文), bb, bet, chips
     超能力A（o.knownOpps 给出对手底牌）时做利用性修正：牌面碾压则不再弃牌、被碾压则不再跟注 */
  function preflopStrategy(o) {
    const base = GWP.decide({
      hole: o.hole, posName: o.posName, pf: o.pf || {},
      bb: o.bb || 1, bet: o.bet || 0, chips: o.chips
    });
    const ko = o.knownOpps && o.knownOpps[0];
    if (!ko || !ko[0] || !ko[1]) return base;
    const e = estimateWin(o.hole, [], 1, 160, null, [ko]);
    if (base.type === 'fold' && e > 0.58) return { type: 'call' };      // 已知领先：改为入池
    if (base.type === 'call' && e < 0.40) return { type: 'fold' };     // 已知被压：及时放弃
    return base;
  }


  /* 翻牌后：由 postflop-engine.js 提供（框架先于数字）。
     该模块在浏览器中通过 <script> 先于 core.js 加载，在 Node 中通过 require 加载。
     若不可用（旧缓存），退回下面的内联实现以保证降级可用。 */
  var PF = (typeof module !== 'undefined' && module.exports)
    ? require('./postflop-engine.js')
    : global.PostflopEngine;

  var postflopImpl = null;
  if (PF && PF.createPostflop) {
    /* 注入 rangeForPreflop：让 postflop-engine 能把"翻前到达翻牌的真实范围"
       【C】拿去做范围优势现算（boardAdvantage）。函数声明会提升，此处可安全引用。 */
    postflopImpl = PF.createPostflop({
      estimateWin: estimateWin,
      handPercentile: handPercentile,
      rangeForPreflop: rangeForPreflop,
      best7: best7,
      cmpScore: cmpScore
    });
  }

  /* 内联降级实现（仅在 postflop-engine.js 缺失时启用）*/
  function postflopLegacy(o) {
    const community = o.community;
    const toCall = o.toCall, pot = o.pot;
    const nOpp = Math.max(1, o.nOpp);
    const e = estimateWin(o.hole, community, nOpp, 220, o.oppPctls, o.knownOpps);
    const r = Math.random();
    const rnd = function (x) { return Math.max(o.bb || 1, Math.round(x * 2) / 2); };
    const O = buildOpts();
    if (toCall <= 0) {
      if (e > 0.7) {
        O.add('下注66%池', 0.75, { type: 'raise', to: rnd(pot * 0.66) });
        O.add('过牌', 0.25, { type: 'check' });
      } else {
        O.add('过牌', 1, { type: 'check' });
      }
      return O.decide(r);
    }
    const potOdds = toCall / (pot + toCall);
    if (e > potOdds + 0.05) { O.add('跟注', 1, { type: 'call' }); return O.decide(r); }
    O.add('跟注', 0.3, { type: 'call' });
    O.add('弃牌', 0.7, { type: 'fold' });
    return O.decide(r);
  }

  function postflopStrategy(o) {
    if (postflopImpl) return postflopImpl(o);
    return postflopLegacy(o);
  }

  /* ---------- 范围权重表构建与更新 ----------
     翻前由 GTO 范围表精确构建；翻后按"行动 × 牌面"过滤。
     这是取代"单一百分位标量"的核心设施。 */
  function rangeWidthOf(range) {
    return (PF && PF.rangeWidth) ? PF.rangeWidth(range) : 0;
  }

  /* 翻前：某玩家在给定节点、给定动作下的范围权重表
     actionType: 'raise' | 'call' | 'check' */
  function rangeForPreflop(posName, pf, actionType) {
    const w = {};
    if (!PF || !PF.RANGE_KEYS) return w;
    PF.RANGE_KEYS.forEach(function (k) { w[k] = 0; });
    let chart = null;
    try { chart = GWP.chartFor(posName, pf || {}); } catch (e) { chart = null; }
    const hands = chart && chart.hands;
    if (hands) {
      Object.keys(hands).forEach(function (code) {
        const v = hands[code];
        let pct = 0;
        if (actionType === 'raise') pct = (v[0] || 0) + (v[2] || 0); // 加注 + 全下
        else if (actionType === 'call') pct = v[1] || 0;
        else pct = 100; // 过牌选项：保留全部（表里没列的也是这样）
        const key = handKey(code);
        if (w[key] !== undefined && pct > 0) w[key] = Math.max(w[key], Math.min(1, pct / 100));
      });
    }
    // 表缺失或过窄（如 BB 面对无加注的过牌选项）→ 过牌用宽范围兜底
    if (actionType === 'check' && rangeWidthOf(w) < 0.05) {
      PF.RANGE_KEYS.forEach(function (k) { w[k] = 1; });
    }
    return w;
  }

  /* 翻后：按行动过滤范围（call 紧缩 / bet·raise 极化 / check 保留） */
  function filterRangeOnAction(range, board, action, potFrac) {
    if (!PF || !PF.filterRange) return range;
    return PF.filterRange(range, board, action, { potFrac: potFrac });
  }

  /* AI 决策总入口 */
  function aiDecide(o) {
    if ((o.community || []).length === 0) return preflopStrategy(o);
    return postflopStrategy(o);
  }

  /* 按玩家累计投入构建主池与边池。contribs: 累计投入数组；inHand: 未弃牌标记 */
  function buildPots(contribs, inHand) {
    const pots = [];
    const rem = contribs.slice();
    while (true) {
      let lv = Infinity;
      for (let i = 0; i < rem.length; i++) {
        if (rem[i] > 0 && rem[i] < lv) lv = rem[i];
      }
      if (!isFinite(lv)) break;
      let amt = 0;
      const elig = [];
      for (let i = 0; i < rem.length; i++) {
        if (rem[i] <= 0) continue;
        const take = Math.min(rem[i], lv);
        amt += take;
        rem[i] -= take;
        if (inHand[i]) elig.push(i);
      }
      if (amt > 0 && elig.length > 0) pots.push({ amount: amt, eligible: elig });
      else if (amt > 0 && pots.length > 0) pots[pots.length - 1].amount += amt;
      else if (amt > 0) pots.push({ amount: amt, eligible: [] });
    }
    /* 合并资格相同的相邻池：弃牌者的中间残差层会把"人人都相关"的池拆成多条，
       导致摊牌时出现多条"主池"；合并后主池唯一、结构符合传统展示 */
    for (let i = pots.length - 1; i > 0; i--) {
      if (JSON.stringify(pots[i].eligible) === JSON.stringify(pots[i - 1].eligible)) {
        pots[i - 1].amount += pots[i].amount;
        pots.splice(i, 1);
      }
    }
    return pots;
  }

  const api = {
    SUITS: SUITS,
    RANK_TEXT: RANK_TEXT,
    makeDeck: makeDeck,
    shuffle: shuffle,
    cardText: cardText,
    isRed: isRed,
    score5: score5,
    cmpScore: cmpScore,
    best7: best7,
    handName: handName,
    estimateWin: estimateWin,
    handPercentile: handPercentile,
    aiDecide: aiDecide,
    raiseSizeFor: GWP.raiseSizeFor,
    buildPots: buildPots,
    rangeForPreflop: rangeForPreflop,
    filterRangeOnAction: filterRangeOnAction,
    rangeWidthOf: rangeWidthOf,
    RANGE_KEYS: (PF && PF.RANGE_KEYS) || []
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PokerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
