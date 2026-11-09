/* ============================================================
   翻后策略引擎 (postflop-engine.js)
   ------------------------------------------------------------
   设计原则：「框架先于数字」。每个决策点按固定顺序推理：
     ① 局面分类  —— 主动权 / SPR / 牌面质地 / 人数
     ② 范围判定  —— 谁有范围优势、谁有坚果优势
     ③ 手牌分级  —— 我在自己的范围里处于哪一档
     ④ 尺度选择  —— 由牌面质地与范围优势决定，不由牌力决定
     ⑤ equity 验证 —— 只在边界处兜底，不作为主判据
   替换 core.js 中纯 equity 阈值的 postflopStrategy。

   依赖注入：构造时传入 { estimateWin, handPercentile }，
   避免与 core.js 循环引用。
   ============================================================ */
'use strict';

(function () {
  var RANK_FROM_R = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };
  /* 点数 → 单字符牌面记号（2~10 走数字，且必须返回字符串）。
     注意：不能用 `RANK_FROM_R[r] || r` 直接参与字符串拼接 —— 2~9 时回落到
     数字，若它同时是拼接表达式的**首个**操作数，`+` 会按数值相加
     （9d 9s 2c → 9+9+2 = 20，7d 7s 7c → 21，2c 3d 4h → 9）。 */
  function rankText(r) { return RANK_FROM_R[r] || String(r); }

  /* ---------- 牌面质地分析 ---------- */
  // 返回 { texture, wetness, paired, monotone, twoTone, straighty, highCard, topRank, boardPctl }
  function analyzeBoard(community) {
    var rs = community.map(function (c) { return c.r; });
    var ss = community.map(function (c) { return c.s; });
    var sorted = rs.slice().sort(function (a, b) { return b - a; });
    var top = sorted[0];
    var uniq = Array.from(new Set(rs));

    var suitCount = {};
    ss.forEach(function (s) { suitCount[s] = (suitCount[s] || 0) + 1; });
    var maxSuit = Math.max.apply(null, Object.keys(suitCount).map(function (k) { return suitCount[k]; }));
    var twoTone = maxSuit === 2, monotone = maxSuit >= 3;

    var paired = uniq.length < rs.length;

    // 顺子连通性：任意三张的跨度是否 <= 4（考虑 A 可作 1）
    var straighty = false;
    var asc = uniq.slice().sort(function (a, b) { return a - b; });
    if (asc.length >= 3) {
      for (var i = 0; i + 2 < asc.length; i++) {
        if (asc[i + 2] - asc[i] <= 4) straighty = true;
      }
      // A-2-3 / A-4-5 型
      if (asc.indexOf(14) >= 0 && asc[1] <= 5 && asc[0] <= 3) straighty = true;
    }
    // 三张牌全是间隔 1-2 的高连通（如 789 / TJQ）
    if (asc.length === 3 && (asc[2] - asc[0]) <= 3) straighty = true;

    // 湿润度：0(最干) ~ 3(最湿)
    var wet = 0;
    if (twoTone) wet += 1;
    if (monotone) wet += 2;
    if (straighty) wet += 1;
    if (paired) wet -= 1;
    if (wet < 0) wet = 0; if (wet > 3) wet = 3;

    // 高牌面 / 中牌面 / 低牌面
    var tier;
    if (top >= 12) tier = 'high';       // Q 以上
    else if (top >= 9) tier = 'mid';    // 9~J
    else tier = 'low';                  // 8 以下

    // 牌面百分位（大致：越靠前越偏"高牌面"，高牌面更利于翻前加注者）
    var boardPctl;
    if (tier === 'high') boardPctl = 0.2;
    else if (tier === 'mid') boardPctl = 0.5;
    else boardPctl = 0.8;

    var texture = ['dry', 'dry', 'semi', 'wet'][wet];

    // 点数重复统计：区分"对子面"与"三条面"，并记录对子点数（高/低对子面策略不同）
    var rankCount = {};
    rs.forEach(function (r) { rankCount[r] = (rankCount[r] || 0) + 1; });
    var maxRankCount = 1, pairRank = 0;
    Object.keys(rankCount).forEach(function (k) {
      var n = rankCount[k], rk = +k;
      if (n > maxRankCount) maxRankCount = n;
      if (n >= 2 && rk > pairRank) pairRank = rk;
    });

    var info = {
      topRank: top, topText: rankText(top),
      tier: tier, wetness: wet, texture: texture,
      paired: paired, monotone: monotone, twoTone: twoTone, straighty: straighty,
      maxRankCount: maxRankCount, pairRank: pairRank,
      boardPctl: boardPctl,
      cards: community,   // 原始牌面数组（供范围优势计算复用，避免重复传参）
      // 全 5 张的牌键：仅用 text（只含前 3 张）会在转/河撞缓存
      key: community.map(function (c) { return c.id; }).join('-'),
      // 前 3 张（顺降序）的点数字符，如 'AK2' / '992' / '777'
      text: sorted.slice(0, 3).map(rankText).join('')
    };
    info.bucket = bucketOf(info);
    return info;
  }

  /* ---------- 牌面结构分桶（Board Bucketing）----------
     把"连续公式近似"换成"分类查表"：每个翻牌结构对应一组求解器式策略参数。
     参数含义：
       adv  —— 翻前加注者的范围优势（-1~1，正 = 加注者占优）；跟注者取相反数
       nut  —— 坚果优势（同上）
       cbet —— 范围整体下注频率基准（中等牌 / 听牌 / 空气用）
       vbet —— 价值手下注频率（成手强牌用）
       size —— 主导尺度（池底倍数）
       pol  —— 是否走两极化（大尺度、低频）。false = "范围下注"（小尺度、高频）
     数值来源：公开求解器研究的近似区间（见 翻后GTO校准锚点.md 第 3 部分），
     不是某次具体解算的输出；用 tools/calibrate.js 逐桶校验。
     改这张表 = 改策略，不要再去 if 链里加特例。 */
  var BOARD_BUCKETS = {
    trips:        { id: 'trips',        label: '三条面',      adv: 0.80, nut: 0.85, cbet: 0.78, vbet: 0.90, size: 0.33, pol: false },
    monotone:     { id: 'monotone',     label: '三同花面',    adv: 0.10, nut: 0.25, cbet: 0.38, vbet: 0.62, size: 0.50, pol: true },
    paired_hi:    { id: 'paired_hi',    label: '高对子面',    adv: 0.55, nut: 0.45, cbet: 0.68, vbet: 0.86, size: 0.33, pol: false },
    paired_lo:    { id: 'paired_lo',    label: '低对子面',    adv: 0.40, nut: 0.30, cbet: 0.64, vbet: 0.82, size: 0.33, pol: false },
    A_hi_dry:     { id: 'A_hi_dry',     label: 'A高·干燥',    adv: 0.85, nut: 0.90, cbet: 0.82, vbet: 0.93, size: 0.33, pol: false },
    A_hi_wet:     { id: 'A_hi_wet',     label: 'A高·两同花',  adv: 0.50, nut: 0.70, cbet: 0.56, vbet: 0.80, size: 0.66, pol: true },
    K_hi_dry:     { id: 'K_hi_dry',     label: 'K高·干燥',    adv: 0.70, nut: 0.60, cbet: 0.74, vbet: 0.90, size: 0.33, pol: false },
    K_hi_wet:     { id: 'K_hi_wet',     label: 'K高·两同花',  adv: 0.40, nut: 0.50, cbet: 0.52, vbet: 0.76, size: 0.66, pol: true },
    Q_hi_dry:     { id: 'Q_hi_dry',     label: 'Q/J高·干燥',  adv: 0.55, nut: 0.45, cbet: 0.72, vbet: 0.88, size: 0.33, pol: false },
    Q_hi_wet:     { id: 'Q_hi_wet',     label: 'Q/J高·两同花', adv: 0.30, nut: 0.40, cbet: 0.50, vbet: 0.74, size: 0.66, pol: true },
    conn_hi_dry:  { id: 'conn_hi_dry',  label: '高连通·彩虹(QJT)', adv: 0.05, nut: 0.10, cbet: 0.46, vbet: 0.68, size: 0.66, pol: true },
    conn_hi_wet:  { id: 'conn_hi_wet',  label: '高连通·两同花(T98)', adv: 0.10, nut: 0.15, cbet: 0.56, vbet: 0.74, size: 0.66, pol: true },
    conn_lo:      { id: 'conn_lo',      label: '低连通(765-)', adv: -0.30, nut: -0.25, cbet: 0.40, vbet: 0.58, size: 0.33, pol: false },
    mid_dry:      { id: 'mid_dry',      label: '中牌·干燥',    adv: 0.40, nut: 0.35, cbet: 0.64, vbet: 0.84, size: 0.33, pol: false },
    mid_wet:      { id: 'mid_wet',      label: '中牌·两同花',  adv: 0.20, nut: 0.30, cbet: 0.48, vbet: 0.72, size: 0.66, pol: true },
    lo_dry:       { id: 'lo_dry',       label: '低牌·干燥',    adv: -0.10, nut: -0.05, cbet: 0.50, vbet: 0.70, size: 0.33, pol: false },
    lo_wet:       { id: 'lo_wet',       label: '低牌·两同花',  adv: -0.20, nut: 0.05, cbet: 0.45, vbet: 0.65, size: 0.50, pol: true }
  };

  /* 分类顺序即优先级：三条面 > 三同花 > 对子面 > 连通 > 高牌高低 × 干湿 */
  function bucketOf(board) {
    if (board.maxRankCount >= 3) return BOARD_BUCKETS.trips;
    if (board.monotone) return BOARD_BUCKETS.monotone;
    if (board.paired) return board.pairRank >= 10 ? BOARD_BUCKETS.paired_hi : BOARD_BUCKETS.paired_lo;
    var wet = board.twoTone, top = board.topRank;
    if (board.straighty) {
      if (top >= 10) return wet ? BOARD_BUCKETS.conn_hi_wet : BOARD_BUCKETS.conn_hi_dry;  // QJT / T98
      return BOARD_BUCKETS.conn_lo;                   // 765 / 654 / 543
    }
    if (top === 14) return wet ? BOARD_BUCKETS.A_hi_wet : BOARD_BUCKETS.A_hi_dry;
    if (top === 13) return wet ? BOARD_BUCKETS.K_hi_wet : BOARD_BUCKETS.K_hi_dry;
    if (top >= 11) return wet ? BOARD_BUCKETS.Q_hi_wet : BOARD_BUCKETS.Q_hi_dry;   // Q / J 高
    if (top >= 9) return wet ? BOARD_BUCKETS.mid_wet : BOARD_BUCKETS.mid_dry;      // T / 9 高
    return wet ? BOARD_BUCKETS.lo_wet : BOARD_BUCKETS.lo_dry;                      // 8 以下
  }

  /* ---------- 底池类型（单加池 / 3-bet 池 / 4-bet 池）----------
     桶描述的是"牌面结构"，底池类型是**正交的第二维**：它改变的不是牌面，
     而是"双方范围的宽度与强度"，所以单独成表，作为桶参数的修正层叠加。
     核心机制是**把牌面优势信号整体削弱**（adv 系数），而不是简单乘一个频率：
       3-bet 池里双方范围都更窄更强，牌面给谁优势这件事的分量下降。
       因此桶的 cbet 按 (1 - advMod) 的比例被拉向中性基准 NEUTRAL_CBET：
         · 低连通面（桶里 adv 为负、cbet 只有 0.40）→ 被拉高，因为跟注方
           不再持有大量小同花连张，"跟注者有范围优势"这条单加池结论失效；
         · A/K 高干燥面（桶里 adv 很高、cbet 0.74~0.82）→ 被拉低一点，
           因为跟注方也拿着 AA/AK/QQ 这类牌，优势没有单加池那么绝对。
     数值是近似（公开求解器研究的量级），用 tools/calibrate.js 的 3-bet 对照段校验方向。 */
  var NEUTRAL_CBET = 0.64;   // 中性牌面的下注频率基准（优势信号被完全抹平时的落点）
  var POT_TYPE_MOD = {
    srp:      { id: 'srp',      label: '单加池',   adv: 1.00, vbet: 1.00, size: 1.00 },
    threebet: { id: 'threebet', label: '3-bet 池', adv: 0.65, vbet: 1.08, size: 0.85 },
    fourbet:  { id: 'fourbet',  label: '4-bet 池', adv: 0.50, vbet: 1.12, size: 0.80 }
  };

  /* 桶频率 × 底池类型的实际取值：优势信号按 advMod 削弱后向中性值靠拢 */
  function bucketFreqs(bucket, pmod) {
    return {
      cbet: bucket.cbet + (NEUTRAL_CBET - bucket.cbet) * (1 - pmod.adv),
      vbet: Math.min(0.96, bucket.vbet * pmod.vbet)
    };
  }

  /* 底池类型判定：优先用翻前上下文（加注次数），缺失时按 SPR 兜底 */
  function potTypeOf(o, band) {
    var r = (o && o.pf && o.pf.raises) || 0;
    if (r >= 3) return 'fourbet';
    if (r === 2) return 'threebet';
    if (r === 1) return 'srp';
    // 无加注（跛入池）或上下文缺失：SPR 已经很低说明大概率是大底池
    return (band === 'commit' || band === 'shallow') ? 'threebet' : 'srp';
  }

  /* ============================================================
     【C】范围现算的牌面优势（Range Advantage，数据驱动）
     ------------------------------------------------------------
     动机：桶表把"牌面质地"当作范围优势的**代理**，于是同一个桶里的所有
     牌面（KQ2r / KT2r / K72r）拿到同一组常数 —— 桶内该有的梯度被压平，
     桶与桶之间又被硬切开。牌面质地本来就只是代理；真正决定"该不该高频
     c-bet"的是**谁的范围在这个牌面上更强**。这一层把它直接算出来：
       ① 用翻前上下文（gw-ranges 的真实范围表）取"到达翻牌的双方范围"
       ② 每个手牌类别用 boardStrength 求牌面画像，按范围权重聚合
       ③ 强牌占比 / 坚果占比相减 → 优势分（攻击方视角）
     叠加方式：**只取残差**，不替换桶基准 ——
       残差 = 本牌面优势 − 该桶"典型牌面"的优势
     于是桶值仍是该桶典型牌面的锚（calibrate 的绝对锚点不动），
     残差负责桶内的连续变化：KQ2r 会自己低于 K72r，不用手写。
     数据来源：范围构成 = gw-ranges 真实数据；牌面画像 = boardStrength。
     唯二待标定：RANGE_ADV_GAIN（归一化增益）、ADV_CBET_SLOPE（优势→频率）。
     无范围数据（跛入池 / 注入缺失 / 范围过窄）时整体返回 null，
     引擎自动回退到桶表常数 —— 保证不改变既有行为。
     ============================================================ */
  var RANGE_ADV_GAIN = 3.0;    // 范围强牌占比差 → [-1,1]
  var ADV_NUT_GAIN = 4.0;      // 坚果占比差 → [-1,1]
  var ADV_MISS_GAIN = 2.0;     // 跟注方"漏牌"率 → [-1,1]
  var ADV_W_RANGE = 0.40;      // 合成权重：范围强度差
  var ADV_W_MISS = 0.60;       // 合成权重：跟注方漏牌（c-bet 频率的主驱动）
  var ADV_USE_MC = false;      // 是否改用蒙特卡洛 equity（更直接，但慢且有采样噪声）
  var ADV_ITERS = 600;         // 蒙特卡洛迭代数（仅 ADV_USE_MC 时生效）
  var ADV_CBET_SLOPE = 0.45;   // 优势残差 → 范围 c-bet 频率的斜率（待 GW 数据标定）
  var ADV_VBET_SLOPE = 0.16;   // 优势残差 → 价值手下注频率的斜率（更保守）

  /* 每个桶的"典型牌面"：只用于求残差基准，不参与频率锚点 */
  var BUCKET_CANONICAL = {
    trips: 'Kd Ks 7c', monotone: 'Ks 8s 3s',
    paired_hi: 'Kd Ks 7c', paired_lo: '6d 6s Kc',
    A_hi_dry: 'Ad 7s 2c', A_hi_wet: 'Ad 8d 3c',
    K_hi_dry: 'Kd 7s 2c', K_hi_wet: 'Kd 8d 3c',
    Q_hi_dry: 'Qd 7s 2c', Q_hi_wet: 'Qd 8d 3c',
    conn_hi_dry: 'Qd Js Tc', conn_hi_wet: 'Td 9d 8c',
    conn_lo: '7d 6s 5c', mid_dry: 'Td 6s 2c', mid_wet: 'Td 8d 3c',
    lo_dry: '8d 4s 2c', lo_wet: '8d 5d 3c'
  };
  var CANON_RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
  var CANON_SUIT = { s: 0, h: 1, d: 2, c: 3 };
  function cardsFromStr(str) {
    return String(str).split(' ').filter(Boolean).map(function (t) {
      var r = CANON_RANK[t[0]], s = CANON_SUIT[t[1]];
      return { r: r, s: s, id: r * 4 + s };
    });
  }
  function clampNum(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /* 一个范围在给定牌面上的画像：强牌占比 / 坚果占比 / 平均牌力
     board 可以是 analyzeBoard 的信息对象，也可以是原始牌面数组 */
  function rangeShape(range, board) {
    if (!range) return null;
    var arr = (board && board.cards) ? board.cards : board;
    if (!arr || !arr.length) return null;
    var wsum = 0, strong = 0, nut = 0, conn = 0, scoreSum = 0;
    for (var k in range) {
      var w = range[k];
      if (!(w > 0)) continue;
      var c = w * rangeCombos(k);
      var st = boardStrength(k, arr);
      wsum += c; scoreSum += c * st.score;
      if (st.tier >= 5) nut += c;                        // 三条 / 顺子及以上
      if (st.tier >= 4 || st.outs >= 8) strong += c;     // 超对/两对 或 强听牌
      if (st.tier >= 1 || st.outs >= 8) conn += c;       // 与牌面有实质接触（任意对子或强听）
    }
    if (wsum <= 0) return null;
    return { strongShare: strong / wsum, nutShare: nut / wsum,
             connectShare: conn / wsum, avgScore: scoreSum / wsum, combos: wsum };
  }

  /* 两支范围在该牌面上的**实际 equity 对抗**（蒙特卡洛）。
     这是范围优势最直接、最可解释的度量：把"谁在这个牌面上赢得多"真的算出来，
     而不是再用一个阈值计数去近似。ev = { best7, cmpScore } 由 core.js 注入。 */
  var _DECK = null;
  function fullDeck() {
    if (_DECK) return _DECK;
    _DECK = [];
    for (var r = 2; r <= 14; r++) for (var s = 0; s < 4; s++) _DECK.push({ r: r, s: s, id: r * 4 + s });
    return _DECK;
  }

  function rangeEquityVs(atkRange, calRange, boardArr, iters, ev) {
    if (!ev || !ev.best7 || !ev.cmpScore) return null;
    var need = 5 - boardArr.length;
    if (need < 0) need = 0;
    var used0 = {};
    boardArr.forEach(function (c) { used0[c.id] = true; });
    var rest = fullDeck().filter(function (c) { return !used0[c.id]; });
    var win = 0, n = 0;
    for (var t = 0; t < iters; t++) {
      var used = Object.assign({}, used0);
      var a = sampleFromRange(atkRange, used);
      if (!a) continue;
      used[a[0].id] = true; used[a[1].id] = true;
      var c = sampleFromRange(calRange, used);
      if (!c) continue;
      used[c[0].id] = true; used[c[1].id] = true;
      var pool = rest.filter(function (x) { return !used[x.id]; });
      if (pool.length < need) continue;
      var comm = boardArr.slice();
      for (var i = 0; i < need; i++) {
        var j = i + Math.floor(Math.random() * (pool.length - i));
        var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        comm.push(pool[i]);
      }
      var cmp = ev.cmpScore(ev.best7(a.concat(comm)).score, ev.best7(c.concat(comm)).score);
      if (cmp > 0) win += 1; else if (cmp === 0) win += 0.5;
      n++;
    }
    return n ? win / n : null;
  }

  /* 攻击方视角的牌面优势（[-1,1]）；非攻击方取相反数。
     合成三个可解释的量：
       range  = 范围强牌占比差（"谁的范围更强"）——教科书 range advantage
       nut    = 坚果占比差（"谁握着坚果"）——决定尺度与大注能力
       calMiss= 跟注方"漏牌"率 = 1 − 跟注方与牌面的接触率 − 0.5
       driver = 0.4·range + 0.6·calMiss —— **c-bet 频率的实际驱动量**
     为什么以 calMiss 为主：c-bet 频率的高低取决于"跟注方能继续的手有多少"，
     而不是单纯"谁的范围更强"。KQ2r 上双方都强、跟注方 Qx 大量能继续 → 攻击方
     不能乱开火；K72r 上跟注方大面积漏牌 → 可以范围下注。仅用范围强度差会把
     这两者判反（实测 KQ2 的强度差反而最大）。
     ADV_W_RANGE / ADV_W_MISS 是待标定权重；ADV_USE_MC 打开时 range 改用
     真实 equity 对抗（rangeEquityVs）替代，更直接但有采样噪声。 */
  function boardAdvantage(board, atkRange, calRange, ev) {
    var arr = (board && board.cards) ? board.cards : board;
    if (!arr || !arr.length) return null;
    var a = rangeShape(atkRange, arr), c = rangeShape(calRange, arr);
    if (!a || !c) return null;
    var rangeEdge = clampNum((a.strongShare - c.strongShare) * RANGE_ADV_GAIN, -1, 1);
    var eq = null;
    if (ADV_USE_MC && ev) {
      eq = rangeEquityVs(atkRange, calRange, arr, ADV_ITERS, ev);
      if (eq !== null) rangeEdge = clampNum((eq - 0.5) * 2 * 3, -1, 1);
    }
    var nutEdge = clampNum((a.nutShare - c.nutShare) * ADV_NUT_GAIN, -1, 1);
    var calMiss = clampNum((0.5 - c.connectShare) * ADV_MISS_GAIN, -1, 1);
    return {
      driver: clampNum(ADV_W_RANGE * rangeEdge + ADV_W_MISS * calMiss, -1, 1),
      range: rangeEdge, nut: nutEdge, calMiss: calMiss, eq: eq, atk: a, cal: c
    };
  }

  /* 由翻前上下文重建"到达翻牌的双方范围"。
     单加池：攻击方 = 开注者（RFI 范围），跟注方 = 防守方（面对开注的跟注范围）。
     3bet+：攻击方 = 最后加注者，其范围取自"面对开注"节点的加注部分
            （不能直接用 T3 表 —— gw-ranges 的 chartFor 在该节点返回 null，
             因为 3-bet 者的加注仍然有效、无需再行动）；
            跟注方 = 开注者（面对 3bet 的跟注范围）。
     拿不到范围时返回 null → 引擎回退桶表。 */
  function preflopArrivalRanges(o, deps) {
    if (!deps || !deps.rangeForPreflop) return null;
    var pf = o.pf || {};
    var raises = pf.raises || 0;
    var rfp = deps.rangeForPreflop;
    var atkPos = null, calPos = null, atk = null, cal = null;
    try {
      if (raises === 1) {
        atkPos = pf.opener;
        calPos = pf.firstCaller || (pf.opener === 'BB' ? 'SB' : 'BB');
        if (!atkPos || atkPos === calPos) return null;
        atk = rfp(atkPos, { raises: 0, posName: atkPos }, 'raise');
        cal = rfp(calPos, { raises: 1, opener: atkPos, posName: calPos }, 'call');
      } else if (raises >= 2) {
        atkPos = pf.lastRaiser || pf.threeBettor;
        calPos = pf.opener;
        if (!atkPos || !calPos || atkPos === calPos) return null;
        atk = rfp(atkPos, { raises: 1, opener: calPos, posName: atkPos }, 'raise');
        cal = rfp(calPos, { raises: 2, opener: calPos, threeBettor: atkPos, posName: calPos }, 'call');
      } else {
        return null;   // 跛入池：没有明确的翻前攻击方
      }
    } catch (e) { return null; }
    if (!atk || !cal) return null;
    if (rangeWidth(atk) < 0.02 || rangeWidth(cal) < 0.02) return null;
    return { atk: atk, cal: cal, atkPos: atkPos, calPos: calPos };
  }

  var ADV_CACHE = {};
  function cacheGet(k) { return (k in ADV_CACHE) ? ADV_CACHE[k] : undefined; }
  function cacheSet(k, v) { ADV_CACHE[k] = v; return v; }

  /* 该桶"典型牌面"在同一 spot 下的优势分（残差基准），按 (桶, spot) 缓存 */
  function bucketRefAdvantage(bucket, arrival, ev) {
    if (arrival.custom) return null;   // 自定义范围不做缓存/不做桶基准
    var key = 'REF|' + bucket.id + '|' + arrival.atkPos + '|' + arrival.calPos;
    var hit = cacheGet(key);
    if (hit !== undefined) return hit;
    var str = BUCKET_CANONICAL[bucket.id];
    return cacheSet(key, str ? boardAdvantage(analyzeBoard(cardsFromStr(str)), arrival.atk, arrival.cal, ev) : null);
  }
  function boardAdvantageCached(board, arrival, ev) {
    if (arrival.custom) return boardAdvantage(board, arrival.atk, arrival.cal, ev);
    var key = 'NOW|' + (board.key || board.text) + '|' + arrival.atkPos + '|' + arrival.calPos;
    var hit = cacheGet(key);
    if (hit !== undefined) return hit;
    return cacheSet(key, boardAdvantage(board, arrival.atk, arrival.cal, ev));
  }

  /* 对外主入口：返回**我方视角的优势残差**（相对该桶典型牌面）。
     driver 为 c-bet 频率驱动量的残差；nut 为坚果残差（用于尺度/价值频率）；
     heroRange / heroNut 为绝对优势（用于"是否该领打"等判定）。
     无范围数据时返回 null，调用方保持桶表行为。 */
  function advantageResidual(board, o, deps, hasInitiative, damp) {
    var arrival = (o.atkRange && o.calRange)
      ? { atk: o.atkRange, cal: o.calRange, atkPos: 'custom', calPos: 'custom', custom: true }
      : preflopArrivalRanges(o, deps);
    if (!arrival) return null;
    var now = boardAdvantageCached(board, arrival, deps);
    if (!now) return null;
    var ref = bucketRefAdvantage(board.bucket, arrival, deps);
    if (!ref) return null;
    var sign = hasInitiative ? 1 : -1, d = (damp === undefined ? 1 : damp);
    return {
      driver: clampNum((now.driver - ref.driver) * sign * d, -1, 1),
      nut: clampNum((now.nut - ref.nut) * sign * d, -1, 1),
      heroRange: clampNum(now.range * sign * d, -1, 1),
      heroNut: clampNum(now.nut * sign * d, -1, 1),
      rawDriver: now.driver, refDriver: ref.driver, calMiss: now.calMiss,
      atkPos: arrival.atkPos, calPos: arrival.calPos
    };
  }

  /* 清空优势缓存（测试用；范围或策略改变后可调用） */
  function clearAdvCache() { ADV_CACHE = {}; }

  /* ---------- 范围优势 / 坚果优势 ---------- */
  /* 直接取「牌面桶」里的优势值（查表，不再是逐条加减的公式）：
     一个桶把"高牌面放大加注者优势、低牌面缩小、对子面放大、连通/同花面侵蚀"
     等所有因素一次性定好。翻前跟注者取相反数；多人池按人数衰减。 */
  function rangeAdvantage(board, hasInitiative, isMultiway, advMod) {
    var b = board.bucket || bucketOf(board);
    var sign = hasInitiative ? 1 : -1;
    var damp = (isMultiway ? (hasInitiative ? 0.6 : 0.9) : 1) * (advMod === undefined ? 1 : advMod);
    return {
      range: Math.max(-1, Math.min(1, b.adv * sign * damp)),
      nut: Math.max(-1, Math.min(1, b.nut * sign * damp))
    };
  }

  /* ---------- 手牌在牌面上的角色分级 ---------- */
  /* 用 estimateWin 的结果 + 牌面关系做分级，区分"真价值"和"仅equity高" */
  function classifyHand(hole, board, equity) {
    var rs = board.map(function (c) { return c.r; });
    var boardSorted = rs.slice().sort(function (a, b) { return b - a; });
    var hr = [hole[0].r, hole[1].r].sort(function (a, b) { return b - a; });
    var paired = hole[0].r === hole[1].r;
    var hs = hole[0].s === hole[1].s;

    // 是否击中牌面。手牌中任一张与牌面最高牌相同即为顶对，
    // 另一张决定踢脚；不能只比较 hr[0]（AKo 在 K 高面是顶对顶踢，不是 A 高）。
    var topBoard = boardSorted[0], secondBoard = boardSorted[1];
    var otherRank = -1;
    if (hole[0].r === topBoard) otherRank = hole[1].r;
    else if (hole[1].r === topBoard) otherRank = hole[0].r;
    var hitTop = otherRank >= 0 && rs.indexOf(otherRank) < 0;   // 顶对且非两对
    var topKicker = otherRank >= 0 ? otherRank : hr[0];
    var hitAny = rs.indexOf(hr[0]) >= 0 || rs.indexOf(hr[1]) >= 0;
    var overpair = paired && hr[0] > topBoard;
    var pocketUnder = paired && hr[0] < boardSorted[boardSorted.length - 1];

    // 同花听牌判定
    var suitN = {};
    board.forEach(function (c) { suitN[c.s] = (suitN[c.s] || 0) + 1; });
    var mySuitN = hs ? (suitN[hole[0].s] || 0) + 2 : 0;
    var flushDraw = hs && (suitN[hole[0].s] || 0) === 2 && board.length < 5;
    var madeFlush = hs && (suitN[hole[0].s] || 0) >= 3;

    // 顺子听牌（简化：两侧连张或含 A 的高张）
    var gap = hr[0] - hr[1];
    var connected = gap <= 2 && !paired;
    var straightDraw = connected && board.straighty && board.length < 5;

    // 成手牌级修正：口袋对 × 公对面 结构（原实现完全没覆盖）
    //   AA 在 K-2-T-6-K = 两对 AA+KK（只输 66/Kx），原逻辑按 overpair 分级，
    //   湿面还会掉进 tpgk —— 两对比顶对下注更少的倒挂就是这么来的。
    var bDup = -1;   // 公对面点数（无对子面 = -1）
    for (var bi = 1; bi < boardSorted.length; bi++) {
      if (boardSorted[bi] === boardSorted[bi - 1]) { bDup = boardSorted[bi]; break; }
    }
    var quads = paired && bDup === hr[0] && rs.indexOf(hr[0]) >= 0;   // 口袋对+同点公对面=金刚
    var tripsHit = paired && !quads && rs.indexOf(hr[0]) >= 0;        // 口袋对配一张公牌=三条
    var twoPair = paired
      ? (bDup >= 0 && bDup !== hr[0])                                  // 口袋对 + 异点公对面
      : (rs.indexOf(hr[0]) >= 0 && hr[1] !== hr[0] && rs.indexOf(hr[1]) >= 0); // 两张各配一张

    var cat;
    if (equity > 0.85 && !board.monotone) cat = 'nuts';               // 坚果级（听牌面下同花更硬，但超对已非坚果）
    else if (madeFlush) cat = 'strong';                               // 成同花
    else if (quads) cat = 'nuts';                                     // 金刚
    else if (tripsHit) cat = equity > 0.75 ? 'nuts' : 'strong';       // 三条（口袋对击中公面）
    else if (twoPair) cat = 'strong';                                 // 两对：永远至少是强价值
    else if (hitTop && topKicker === 14) cat = 'strong';              // 顶对顶踢（AK 击中 K 高面）
    else if (overpair && board.wetness <= 1) cat = 'strong';          // 干燥面超对：真价值
    else if (overpair) cat = 'tpgk';                                  // 湿润面超对：仍是价值但需保护，归入高档
    else if (hitTop && topKicker >= 10) cat = 'tpgk';                 // 顶对好踢
    else if (hitTop) cat = 'tpmid';                                   // 顶对弱踢
    else if (hitAny && hr[0] >= 10) cat = 'tpmid';                    // 大张命中（非顶对，如中对）
    else if (paired && hr[0] > boardSorted[1]) cat = 'underpair_mid';
    else if (paired) cat = 'underpair_low';
    else if (flushDraw || (straightDraw && hr[0] >= 9)) cat = 'draw_strong';
    else if (straightDraw) cat = 'draw_weak';
    else if (hr[0] === 14 && !hitAny) cat = 'overcard';
    else cat = 'air';

    return {
      cat: cat, hitTop: hitTop, hitAny: hitAny, overpair: overpair,
      flushDraw: flushDraw, straightDraw: straightDraw, madeFlush: madeFlush,
      twoPair: twoPair, tripsHit: tripsHit, quads: quads,
      isValue: (cat === 'nuts' || cat === 'strong' || cat === 'tpgk'),
      isBluff: (cat === 'air' || cat === 'overcard' || cat === 'underpair_low'),
      isDraw: (cat === 'draw_strong' || cat === 'draw_weak' || flushDraw)
    };
  }

  /* ---------- SPR 分层 ---------- */
  function sprBand(effStack, pot) {
    if (pot <= 0) return 'deep';
    var spr = effStack / pot;
    if (spr <= 2) return 'commit';     // 已承诺，强牌直接打光
    if (spr <= 4) return 'shallow';    // 浅：强牌快打，一次加注后即入池
    if (spr <= 8) return 'medium';
    return 'deep';                     // 深：控制池底，避免用中等牌打大池
  }

  /* ---------- 主策略 ---------- */
  /* deps: { estimateWin, handPercentile }
     o: 与 core.js 原 postflopStrategy 相同，外加：
        hasInitiative (bool) —— 我在翻前是否最后加注者（主动权）
        sprBand (str)        —— 可选，覆盖自动计算 */
  function createPostflop(deps) {
    var estimateWin = deps.estimateWin;

    function strategy(o) {
      var community = o.community || [];
      var toCall = o.toCall || 0;
      var pot = Math.max(o.pot || 1, 1);
      var chips = o.chips || 0;
      var nOpp = Math.max(1, o.nOpp || 1);
      var bb = o.bb || 1;
      var currentBet = o.currentBet || 0;
      var isRiver = community.length === 5;
      var isTurn = community.length === 4;
      var isFlop = community.length === 3;
      var multi = nOpp - 1;
      var isMultiway = nOpp >= 2;

      // 主动权：优先用调用方传入，否则按翻前上下文推断
      var hasInitiative = (o.hasInitiative !== undefined)
        ? !!o.hasInitiative
        : !!(o.pf && o.pf.lastRaiser && o.pf.lastRaiser === o.posName);

      /* 是否本街最后一个行动（有位置）。
         "保护过牌范围"只在后面还有街时才成立；河牌后位一旦过牌即摊牌，
         checking range 无人可利用 —— 该逻辑在河牌后位失效。 */
      var isLastToAct = (o.isLastToAct !== undefined)
        ? !!o.isLastToAct
        : (o.posIdx !== undefined && o.posIdx >= nOpp);

      var board = analyzeBoard(community);
      var effStack = Math.min(chips, o.effStack || chips || pot * 10);
      var band = o.sprBand || sprBand(effStack, pot);
      /* 底池类型：与牌面桶正交的第二维（单加池 / 3-bet 池 / 4-bet 池）。
         它修正的是"双方范围宽度与强度"，不是牌面，所以叠在桶参数之上。 */
      var potType = potTypeOf(o, band);
      var pmod = POT_TYPE_MOD[potType];
      var bfreq = bucketFreqs(board.bucket, pmod);   // 桶频率经底池类型修正后的实际值
      /* ---------- 【C】范围现算的牌面优势：以残差叠加在桶频率上 ----------
         桶值 = 该桶"典型牌面"的锚；残差 = 本牌面相对典型牌面的偏离。
         典型牌面上残差为 0 → calibrate 的绝对锚点不受影响；
         KQ2r / KT2r / K72r 的差异由真实范围自动算出（同桶也能拉开）。 */
      var advDamp = (isMultiway ? (hasInitiative ? 0.6 : 0.9) : 1) * (pmod.adv === undefined ? 1 : pmod.adv);
      var advRes = advantageResidual(board, o, deps, hasInitiative, advDamp);
      if (advRes) {
        bfreq = {
          cbet: clampNum(bfreq.cbet + ADV_CBET_SLOPE * advRes.driver, 0.26, 0.94),
          vbet: clampNum(bfreq.vbet + ADV_VBET_SLOPE * (0.65 * advRes.driver + 0.35 * advRes.nut), 0.34, 0.96)
        };
      }

      /* ---------- 【T】策略表锚定（2026-10-18 接入，两街口径）----------
         表 = `flop + turn` 两街、转牌 49 张全覆盖、15 桶求解出的
              「场景(池型|开注位|跟注位) × 牌面桶内最近邻」聚合频率。
         为什么必须锚定：本文件 BOARD_BUCKETS 里的 c-bet 常数是**单街口径**
         （隐含"后续街不再下注"），实测系统性高估 12~25pp
         （K72r：单街 63.9% vs 两街 51.2%）。
         命中条件很窄 —— 只看 flop、只单挑、只覆盖的场景与节点（IP 面对过牌 / OOP 首个决策）；
         未命中（转牌/河牌、多人池、面对下注、表未覆盖的场景）**完全保持原逻辑**。 */
      var TL = null;
      try {
        if (typeof PostflopTable !== 'undefined' && PostflopTable && PostflopTable.ready()) {
          TL = PostflopTable.lookup({
            pf: o.pf, posName: o.posName, board: board, nOpp: nOpp, hole: o.hole,
            toCall: toCall, currentBet: currentBet, myBet: o.bet || 0
          });
        }
      } catch (e) { TL = null; }
      if (TL && TL.freq != null) {
        var ratio = TL.freq / Math.max(0.06, bfreq.cbet);
        bfreq = {
          cbet: clampNum(TL.freq, 0.05, 0.95),
          vbet: clampNum(bfreq.vbet * ratio, 0.30, 0.97),
          sizeTbl: TL.size,          // flop 尺度由表决定（null 时回落 bucket.size）
          tblPick: TL.pick
        };
      }
      var myBet = o.bet || 0;   // 本街已投入，缺失时按 0 处理（避免 NaN）

      // equity：仍用蒙特卡洛，但只作为验证与分级依据，不单独决定动作
      var eqBoard = community;
      if (o.knownBoard && community.length < 5) {
        var extra = o.knownBoard.filter(function (c) { return !!c; }).slice(0, 5 - community.length);
        if (extra.length) eqBoard = community.concat(extra);
      }
      var eq = estimateWin(o.hole, eqBoard, nOpp, 200, o.oppPctls, o.knownOpps, o.oppRanges);
      var hand = classifyHand(o.hole, community, eq);
      /* 优势判定优先用**现算**的绝对优势（数据驱动）；无范围数据时回退桶表。
         下方只有 OOP 低连通面的小额领打例外会读它（adv.range > 0.25）。 */
      var adv = advRes
        ? { range: advRes.heroRange, nut: advRes.heroNut }
        : rangeAdvantage(board, hasInitiative, isMultiway, pmod.adv);

      var r = Math.random();
      var O = buildOpts();
      var pct = function (f) { return Math.round(f * 100) + '%池'; };
      // 下注额取整到 0.5bb
      var rnd = function (x) { return Math.max(bb, Math.round(x * 2) / 2); };
      var betTo = function (frac) { return rnd(currentBet + pot * frac); };

      /* ---------- 后手（自身剩余筹码）派生量 ----------
         原则：所有赔率、隐含赔率、弃牌率一律按"我实际还能投入多少钱"计算。
         注意 pot 由调用方传入时**已包含本街下注**（页面 potTotal() = 底池 + 各家 bet），
         所以：底池赔率用 pot+myCall，而 MDF 必须把对手这一注从底池里剔出去。 */
      var myCall = Math.min(Math.max(toCall, 0), chips);     // 我实际要投入的跟注额（短码封顶）
      var betOver = Math.max(0, currentBet - myBet);         // 本街对手领先我的额度
      var uncalled = Math.max(0, betOver - myCall);          // 我跟不到的溢出部分（会退回对手）
      // 口径自检：页面 potTotal() 传入的 pot 含本街下注；若 pot 比对手这一注还小，
      // 说明调用方传的是"下注前底池"，此时不做剔除（避免算出 0 或负数底池）。
      var potHasBet = pot >= betOver;
      var effPot = Math.max(1, (nOpp === 1 && potHasBet) ? pot - uncalled : pot); // 单挑才剔除溢出
      var potBeforeBet = potHasBet ? Math.max(1, effPot - betOver) : Math.max(1, pot); // MDF 分母基准
      // 我全下的总额（取整到 0.5bb，但绝不能超过 myBet + chips）
      var allInTo = Math.min(rnd(myBet + chips), myBet + chips);
      var behind = Math.max(0, chips - myCall);              // 跟注后还剩多少后手 → 隐含赔率的基础

      /* ============ 面对下注 ============ */
      if (toCall > 0) {
        // 底池赔率按我实际能投入的钱算（短码全下跟注时，剩多少算多少）
        var potOdds = myCall / (effPot + myCall);
        var raiseFrac = board.wetness >= 2 ? 0.9 : 0.66;   // 湿面加注更大（保护）
        // 加注额不得超过我的后手；等于全下时直接标"全下"
        var raiseAmt = Math.min(betTo(raiseFrac), allInTo);
        var isShove = raiseAmt >= allInTo;
        var raiseLabel = isShove ? ('全下' + allInTo) : ('加注至' + raiseAmt);
        // 合法加注：后手必须够到最小加注额，否则只能跟注（全下跟）或弃牌 → 此时没有弃牌率
        var minRaiseTo = o.minRaiseTo || (currentBet + Math.max(betOver, Math.round(pot * 0.3) || bb));
        var canRaise = (myBet + chips) >= minRaiseTo && chips > myCall + pot * 0.5;

        // 承诺度：SPR 低时强牌直接全下
        var commitNow = (band === 'commit') && hand.isValue;
        var shoveTo = allInTo;

        // --- 强价值：加注（频率由"牌力档 × 牌面质地 × SPR"共同决定）---
        if (hand.isValue) {
          var raiseProb;
          if (hand.cat === 'nuts') {
            // 坚果：干燥面慢打留注，湿面直接做大收钱
            raiseProb = board.wetness >= 2 ? 0.8 : 0.62;
          } else if (hand.cat === 'strong') {
            // 顶对顶踢 / 成同花：湿面加注保护（对手有大量听牌），干面以跟注控池为主
            raiseProb = board.wetness >= 2 ? 0.62 : 0.32;
          } else {
            // tpgk：顶对好踢 / 湿润面超对。超对在听牌面是"必须保护"的强摊牌价值，
            // 不能和普通顶对一样收敛，因此单独提高湿润面的加注频率
            if (hand.overpair) raiseProb = board.wetness >= 2 ? 0.6 : 0.28;
            else raiseProb = board.wetness >= 2 ? 0.4 : 0.2;
          }
          if (multi >= 2) raiseProb = Math.min(0.85, raiseProb + 0.12);   // 多人池更需直接做大
          // 深筹码：中等强度牌收敛；但超对在深筹码下依然是主要价值来源，仅轻微收敛
          if (band === 'deep') {
            if (hand.cat === 'tpgk' && !hand.overpair) raiseProb *= 0.4;
            else if (hand.cat === 'strong' && !hand.overpair) raiseProb *= 0.7;
            else if (hand.overpair) raiseProb *= 0.85;
          }
          // 中浅筹码：SPR 越低越倾向直接把钱放进去
          if (band === 'medium') raiseProb *= 1.15;
          if (band === 'shallow') raiseProb = Math.min(0.95, raiseProb * 1.4 + 0.15);
          if (band === 'commit') raiseProb = 0.95;
          if (!canRaise) raiseProb = 0;
          raiseProb = Math.max(0, Math.min(0.95, raiseProb));

          if (commitNow && canRaise) {
            O.add('全下' + shoveTo, 0.9, { type: 'raise', to: shoveTo });
            O.add('跟注', 0.1, { type: 'call' });
          } else {
            O.add(raiseLabel, raiseProb, { type: 'raise', to: raiseAmt });
            O.add('跟注', 1 - raiseProb, { type: 'call' });
          }
          return O.decide(r);
        }

        // --- 听牌：按隐含赔率与 pot odds 决定，浅筹码/湿面偏加注 ---
        if (hand.isDraw) {
          // 隐含赔率按"跟注后还剩多少后手"折算：全下跟注已无未来收益 → 隐含赔率 = 0，
          // 后手越薄（相对底池）能兑现的隐含赔率越小。原实现是无条件 +0.08（含全下场景），
          // 会让听牌在"跟注即全下"时被高估、该弃不弃。
          var implied = 0;
          if (!isRiver && behind > 0) {
            implied = (band === 'deep' ? 0.13 : 0.08) * Math.min(1, (behind / Math.max(effPot, 1)) * 1.5);
          }
          if (eq + implied > potOdds + 0.02) {
            var semProb = (isTurn || isFlop) && canRaise ? (board.wetness >= 2 ? 0.3 : 0.18) : 0;
            // 半诈唬加注同样必须守住 canRaise（后手不够做合法加注时没有任何弃牌率）
            if (band === 'commit' && canRaise) semProb = Math.max(semProb, 0.4);
            O.add(raiseLabel, semProb, { type: 'raise', to: raiseAmt });
            O.add('跟注', 1 - semProb, { type: 'call' });
            return O.decide(r);
          }
          O.add('跟注', 0.35, { type: 'call' });
          O.add('弃牌', 0.65, { type: 'fold' });
          return O.decide(r);
        }

        // --- 中等牌 / 弱摊牌价值：跟注为主，偶尔加注（平衡）---
        if (hand.cat === 'underpair_mid' || hand.cat === 'tpmid') {
          if (eq > potOdds + 0.03) {
            var mx = canRaise && board.wetness <= 1 && !isRiver ? 0.12 : 0;
            O.add(raiseLabel, mx, { type: 'raise', to: raiseAmt });
            O.add('跟注', 1 - mx, { type: 'call' });
            return O.decide(r);
          }
          O.add('跟注', 0.45, { type: 'call' });
          O.add('弃牌', 0.55, { type: 'fold' });
          return O.decide(r);
        }

        // --- 空气 / 低对：MDF 防守（修正版）---
        // MDF = 下注前底池 / (下注前底池 + 下注额)。真实 MDF 要求"范围整体"防守到该频率，
        // 而空气应在被弃的那一部分。这里按手牌质量给防守权重，
        // 保证范围层面接近 MDF，同时空气优先被弃。
        // 【口径修正】调用方传入的 pot 已含对手这一注，MDF 必须用 potBeforeBet 作分母，
        // 否则 P=100/B=200 会被算成 300/500=60%，而正确值是 100/300=33%（防线虚高近一倍）。
        var mdf = potBeforeBet / (potBeforeBet + betOver);
        var quality = hand.isBluff ? 0.15 : 0.5;   // 空气几乎不防守
        var defend = Math.max(0, Math.min(0.9, mdf * quality * 2.2));
        if (isRiver && hand.cat === 'air') defend = Math.min(defend, 0.12);
        if (multi >= 2) defend *= 0.6;              // 多人池防守收窄
        if (band === 'commit' && !hand.isBluff) defend = Math.max(defend, 0.5);
        // 跟注即全下（我把后手全押进去）：没有加注空间、也没有未来街，只按胜率 vs 底池赔率决策
        if (myCall >= chips) defend = eq > potOdds ? defend : 0;

        var bRaise = (canRaise && !isRiver && board.wetness <= 1 && !hand.isBluff) ? 0.05 : 0;
        if (hand.isBluff && canRaise && !isRiver && board.wetness >= 2 && toCall <= pot * 0.5) bRaise = 0.08;
        O.add('诈唬' + raiseLabel, bRaise, { type: 'raise', to: raiseAmt });
        O.add('跟注', Math.max(0, defend - bRaise), { type: 'call' });
        O.add('弃牌', Math.max(0, 1 - defend - bRaise), { type: 'fold' });
        return O.decide(r);
      }

      /* ============ 无人下注（check to me）============ */
      // 关键修正：主动权决定下注权。无主动权 + 无坚果优势 → 大幅收敛，不出 donk
      var canBet = chips > 0;

      /* 主导尺度由「牌面桶」决定（一个牌面一个主尺度）：价值与诈唬共用同一尺度，
         否则范围会被读出。河牌整体抬到 66% 以上（价值下注区间）。
         3-bet 池的翻牌尺度再乘修正系数（更统一、更小），转牌/河牌不受影响
         —— 低 SPR 下的转牌/河牌差异由 SPR 档（band）承担。 */
      var drawHeavy = board.twoTone || board.monotone;
      var connected = board.straighty;
      var bucket = board.bucket;
      var boardSize = bfreq.sizeTbl || (isRiver ? Math.max(0.66, bucket.size)
        : (isFlop ? bucket.size * pmod.size : bucket.size));

      // 价值下注阈值（比旧版更依赖手牌分级而非纯 equity）
      var wantBet = hand.isValue ||
        (hand.cat === 'overpair' ) ||
        (hand.isDraw && !isRiver);

      if (!wantBet) {
        // 无摊牌价值 / 纯空气：只有在「有主动权 + 有范围优势」时高频小尺度 c-bet
        var bluffProb = 0;
        var bluffFrac = boardSize;
        if (hasInitiative && canBet) {
          if (isRiver) {
            // 河牌无听牌：诈唬频率直接由 alpha 决定（价值:诈唬 = 1:alpha 才让对手无差异）
            bluffProb = bluffFreqFor(bluffFrac, o.selfRange, community, 0.8);
          } else {
            // 翻牌/转牌：空气的下注频率直接取「牌面桶」的 cbet 基准。
            // 干燥面（pol=false）就是"范围下注"——空气跟着整个范围一起下；
            // 两极化桶（pol=true）里纯空气略减，把频率让给有 equity 的听牌。
            var base = bfreq.cbet - multi * 0.16 - (bucket.pol ? 0.10 : 0);
            bluffProb = Math.max(0, Math.min(0.85, base));
          }
          // 空气牌 equity 太低时略降（保留少量纯诈唬以免范围被读）
          if (eq < 0.2) bluffProb *= 0.9;
        } else if (!hasInitiative && adv.range > 0.25 && !isRiver) {
          // 少数例外：OOP 但坚果优势显著（低连通面）→ 允许小额低频领打
          bluffProb = 0.12 * (board.wetness <= 1 ? 1 : 0.5);
        }

        /* 【T】表命中：空气/听牌同样取「该手牌所在桶」的实际下注频率。
           桶化 CFR 里同桶同策略，所以这才是求解值；上面那些只是无表时的经验值。
           ⚠ 必须放在 if/else if **之外**：OOP 无主动权走的是 else-if 分支，
             写进去会让 OOP 的领先频率完全绕开表（实测 11.6% vs 表 29.8%）。 */
        if (TL && TL.handBetFreq != null && canBet) {
          bluffProb = Math.max(0.02, Math.min(0.98, TL.handBetFreq));
          if (TL.handSize) bluffFrac = TL.handSize;
        }

        if (bluffProb > 0.02 && canBet) {
          var bf = bluffFrac;
          // 下注额不得超过后手（不足时即为全下）
          var bluffAmt = Math.min(rnd(pot * bf), allInTo);
          O.add(bluffAmt >= allInTo ? ('全下' + allInTo) : ('下注' + pct(bf)),
            bluffProb, { type: 'raise', to: bluffAmt });
          O.add('过牌', 1 - bluffProb, { type: 'check' });
          return O.decide(r);
        }
        // 无主动权无优势：直接过牌，绝不 donk
        return { type: 'check', opts: [{ label: '过牌', prob: 1, chosen: true, act: { type: 'check' } }] };
      }

      // --- 有下注意图：按牌面质地与范围优势选尺度 ---
      // 干燥 + 有范围优势 → 小尺度（25-33%），高频
      // 湿润 / 极化 → 大尺度（66-75%）
      var sizeFrac, freq;
      var polarized = (hand.cat === 'nuts' || hand.cat === 'strong' ||
        (hand.cat === 'tpgk' && hand.overpair));   // 湿面超对是这个面上的 premium，按极化处理
      var thinValue = (hand.cat === 'tpgk' && !hand.overpair);

      /* 频率决策：尺度已由牌面桶锁定（boardSize），这里只决定"多久下注一次"。
         价值手取桶的 vbet；听牌 / 中等价值取 cbet 基准。再乘底池类型修正
         （3-bet 池双方范围更价值密集、SPR 更低 → 频率更高、价值手更敢下）。
         范围优势、干湿、连通的影响已经写进桶里，这里不重复扣减。 */
      sizeFrac = boardSize;
      freq = polarized ? bfreq.vbet : bfreq.cbet;
      /* 【T】逐手牌命中策略表：桶化 CFR 里**同桶手牌策略相同**，所以直接取该桶在
         本节点的下注总频率 = 求解值，不再经过"极化/分级"的经验调制。
         这一层是 2026-10-18 接表的关键：只换聚合基线（bfreq.cbet）时，
         引擎的逐手牌调制会把聚合值再推偏 ~7pp（实测 45.1% vs 表 52.4%）。 */
      var tblHand = false;
      if (TL && TL.handBetFreq != null) {
        freq = clampNum(TL.handBetFreq, 0.02, 0.98);
        if (TL.handSize) sizeFrac = TL.handSize;
        tblHand = true;
      }

      // 深筹码控制池底：中等牌降低频率、缩小尺度
      if (band === 'deep' && thinValue) { freq *= 0.7; sizeFrac = Math.min(sizeFrac, 0.5); }
      // 多人池：价值下注更实、更少诈唬
      if (multi >= 2) { freq = polarized ? freq : freq * 0.75; }
      // 无主动权时降低下注频率（仍然可以下注，因为已经是有价值的牌，但更谨慎）
      if (!hasInitiative) freq *= 0.8;

      /* 手牌档位对频率的调节已写进桶的 vbet / cbet 两个数里：
         价值手 → vbet（更高），听牌与中等价值 → cbet（基准）。
         这里不再叠加按档位的乘除，避免双重扣减。 */
      // 河牌没有听牌保护需求，价值牌过牌应当罕见（留少量给均衡）
      if (isRiver && polarized) freq = Math.min(0.92, freq + 0.12);
      /* 河牌 + 有位置：近坚果必须下注（近乎满频）。
         河牌后位过牌 = 直接摊牌，checking range 没有任何保护价值，
         而对手已经在前位示弱 —— 此时过掉能够被更差牌跟注的成手牌是纯 EV 损失。
         求解器在后位河牌对近坚果的下注频率约 95-100%，过牌只出现在
         阻断牌导致"下注拿不到任何更差牌跟注"的边缘局面（引擎不建模阻断牌）。 */
      if (isRiver && isLastToAct &&
        (hand.cat === 'nuts' || hand.twoPair || hand.tripsHit || hand.quads || hand.madeFlush)) {
        freq = Math.max(freq, 0.95);
      }
      /* 多街计划：有主动权且本手翻后已经过牌过 → 本街高频补注（stab）。
         这是消除"每街独立掷骰"的关键：GTO 的 check 是有后续计划的，
         check 过翻牌的强牌在转牌的下注频率应显著高于无计划抽样的结果 */
      if (hasInitiative && (o.myChecks || 0) > 0) freq = Math.min(0.96, freq + 0.2);

      /* 【T】表命中时，上面这些经验修正（深筹码减频、无主动权打折、河牌抬价…）
         一律不再生效 —— 它们是为"没有表"的经验值服务的，叠加在求解值上只会把
         已收敛的频率再推偏（实测深筹码 ×0.7 会把 52% 推到 36%）。 */
      if (tblHand) {
        freq = clampNum(TL.handBetFreq, 0.02, 0.98);
        if (TL.handSize) sizeFrac = TL.handSize;
      }

      // 下注/全下额一律以「我的后手」为上限：尺度公式只决定"想下多少"，后手决定"能下多少"
      var toBet = Math.min(rnd(pot * sizeFrac), allInTo);
      var shoveAll = allInTo;
      var betLabel = toBet >= allInTo ? ('全下' + allInTo) : ('下注' + pct(sizeFrac));
      var bigTo = Math.min(rnd(pot * 1.25), allInTo);
      if (band === 'commit' && polarized && canBet) {
        O.add('全下' + shoveAll, 0.85, { type: 'raise', to: shoveAll });
        O.add(betLabel, 0.05, { type: 'raise', to: toBet });
        O.add('过牌', 0.1, { type: 'check' });
      } else {
        // 概率钳制：上限 0.96（保留少量过牌作为均衡残留），下限 0
        freq = Math.max(0, Math.min(tblHand ? 0.995 : 0.96, freq));
        /* 【T】表命中时不加"偶尔超大尺度"那 8% —— 求解值已经确定了尺寸分布，
           再叠一个 extraBig 会让下注概率之和突破 1（实测出现 104%）。 */
        var extraBig = (polarized && !isRiver && !tblHand) ? 0.08 : 0;
        O.add(betLabel, freq, { type: 'raise', to: toBet });
        // 极强牌偶尔用超大尺度（同样受后手封顶）
        if (extraBig > 0) O.add(bigTo >= allInTo ? ('全下' + allInTo) : ('下注' + pct(1.25)),
          extraBig, { type: 'raise', to: bigTo });
        O.add('过牌', Math.max(0, 1 - freq - extraBig), { type: 'check' });
      }
      return O.decide(r);
    }

    return strategy;
  }

  /* ============================================================
     范围权重表（Range Weight Table）
     ------------------------------------------------------------
     取代原有的"单一百分位标量"。一个范围 = { handKey: weight }，weight ∈ [0,1]。
     这样翻后可以按牌面与行动真正地"过滤"范围，而不是统一乘一个常数。
     ============================================================ */
  var RANKS_DESC = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  var RANGE_KEYS = (function () {
    var ks = [];
    RANKS_DESC.forEach(function (r) { ks.push('p' + r); });
    for (var i = 0; i < 13; i++) for (var j = i + 1; j < 13; j++) ks.push('s' + RANKS_DESC[i] + '_' + RANKS_DESC[j]);
    for (var i2 = 0; i2 < 13; i2++) for (var j2 = i2 + 1; j2 < 13; j2++) ks.push('o' + RANKS_DESC[i2] + '_' + RANKS_DESC[j2]);
    return ks;
  })();
  var TOTAL_COMBOS = 1326;

  function rangeCombos(key) { return key[0] === 'p' ? 6 : (key[0] === 's' ? 4 : 12); }

  function keyOf(h1, h2) {
    var hi = Math.max(h1.r, h2.r), lo = Math.min(h1.r, h2.r);
    if (hi === lo) return 'p' + hi;
    return (h1.s === h2.s ? 's' : 'o') + hi + '_' + lo;
  }

  /* 展开一个 handKey 的所有具体组合（用于按权重采样） */
  function combosOfCards(key) {
    var out = [];
    if (key[0] === 'p') {
      var r = +key.slice(1);
      for (var a = 0; a < 4; a++) for (var b = a + 1; b < 4; b++)
        out.push([{ r: r, s: a, id: r * 4 + a }, { r: r, s: b, id: r * 4 + b }]);
    } else if (key[0] === 's') {
      var p = key.slice(1).split('_'), hi = +p[0], lo = +p[1];
      for (var s = 0; s < 4; s++)
        out.push([{ r: hi, s: s, id: hi * 4 + s }, { r: lo, s: s, id: lo * 4 + s }]);
    } else {
      var p2 = key.slice(1).split('_'), hi2 = +p2[0], lo2 = +p2[1];
      for (var sa = 0; sa < 4; sa++) for (var sb = 0; sb < 4; sb++) if (sa !== sb)
        out.push([{ r: hi2, s: sa, id: hi2 * 4 + sa }, { r: lo2, s: sb, id: lo2 * 4 + sb }]);
    }
    return out;
  }

  function makeFullRange() { var r = {}; RANGE_KEYS.forEach(function (k) { r[k] = 1; }); return r; }
  function makeEmptyRange() { var r = {}; RANGE_KEYS.forEach(function (k) { r[k] = 0; }); return r; }

  /* 组合加权宽度（0~1，1 = 任意两张牌） */
  function rangeWidth(range) {
    var c = 0;
    for (var k in range) { if (range[k] > 0) c += range[k] * rangeCombos(k); }
    return c / TOTAL_COMBOS;
  }

  /* 某手牌类别在给定牌面上的"牌力画像"。
     返回 { tier, outs, score, made, draw }
       tier: 0 空气 / 1 弱对 / 2 中对 / 3 顶对 / 4 超对或两对 / 5 三条或顺 / 6 同花及以上
       outs: 听牌补张估算（同花听牌 9、两头顺 8、卡顺 4、双高张 3） */
  function boardStrength(key, board) {
    var combos = combosOfCards(key);
    var h = combos[0];
    var h1 = h[0], h2 = h[1];
    var rs = board.map(function (c) { return c.r; });
    var sorted = rs.slice().sort(function (a, b) { return b - a; });
    var top = sorted[0] || 0;
    var uniq = Array.from(new Set(rs));
    var pairHole = h1.r === h2.r;
    var suit = h1.s === h2.s;
    var hiR = Math.max(h1.r, h2.r), loR = Math.min(h1.r, h2.r);
    var hiHit = rs.indexOf(hiR) >= 0, loHit = rs.indexOf(loR) >= 0;

    var tier = 0;
    if (pairHole) {
      if (rs.indexOf(h1.r) >= 0) tier = 5;
      else if (h1.r > top) tier = 4;
      else tier = 1;
    } else if (hiHit && loHit) {
      tier = 4;
    } else if (hiHit) {
      tier = (hiR === top) ? 3 : 1;
    } else if (loHit) {
      tier = (loR === top) ? 3 : 1;
    }
    // 同花：成牌或听牌
    var outs = 0;
    if (suit) {
      var sc = board.filter(function (c) { return c.s === h1.s; }).length;
      if (sc >= 3) tier = Math.max(tier, 6);
      else if (sc === 2 && board.length <= 4) outs += 9;
    }
    // 顺子听牌（简化连通性判定）
    if (board.length <= 4) {
      var u = Array.from(new Set(rs.concat([h1.r, h2.r]))).sort(function (a, b) { return a - b; });
      var run = 1, maxRun = 1;
      for (var i = 1; i < u.length; i++) {
        if (u[i] - u[i - 1] === 1) { run++; if (run > maxRun) maxRun = run; }
        else if (u[i] - u[i - 1] !== 0) run = 1;
      }
      if (maxRun >= 4) outs += 8;
      else if (maxRun === 3) outs += 4;
    }
    // 双高张未中牌给一点点出路
    if (tier === 0 && hiR >= 13 && loR >= 10) outs += 3;

    return { tier: tier, outs: outs, score: tier * 10 + outs, made: tier >= 1, draw: outs >= 4 };
  }

  /* 各行动下的"保留意愿" g ∈ [0,1]：牌越强越接近 1。
     这是范围过滤的形态函数——call 走"紧缩"，bet/raise 走"极化"。 */
  function strengthKeep(st, action) {
    if (action === 'call') {
      if (st.tier >= 5) return 1;
      if (st.tier >= 4) return 0.95;
      if (st.tier === 3) return 0.85;
      if (st.outs >= 8) return 0.8;
      if (st.tier === 2) return 0.6;
      if (st.outs >= 4) return 0.5;
      if (st.tier === 1) return 0.4;
      if (st.score >= 3) return 0.25;
      return 0.12;
    }
    if (action === 'bet' || action === 'raise') {
      if (st.tier >= 5) return 0.95;
      if (st.tier === 4) return 0.85;
      if (st.outs >= 8) return 0.75;
      if (st.tier === 3) return 0.6;
      if (st.tier === 2) return 0.2;
      if (st.tier === 1) return 0.55;
      if (st.outs >= 4) return 0.45;
      return 0.3;
    }
    // check
    if (st.tier >= 5) return 0.4;
    if (st.tier === 4) return 0.6;
    return 1;
  }

  /* ---------- Alpha 闭环 ---------- */
  /* 下注尺度 s（底池倍数）对应的求解器"诈唬占下注范围比例" b = s/(1+2s)。
     s=1/3 → 20%；s=1/2 → 25%；s=2/3 → 28.6%；s=1 → 33%；s=1.5 → 37.5%。
     这是让对手对"跟注/弃牌"无差异的理论比例。 */
  function alphaRatio(sizeFrac) {
    if (!(sizeFrac > 0)) return 0;
    return sizeFrac / (1 + 2 * sizeFrac);
  }

  /* 反推"持空气时下注的概率"，使命中整个下注范围的 价值:诈唬 比符合 alpha。
     有 selfRange（我方范围权重表）时按真实构成算；没有时退回 alpha 近似。 */
  function bluffFreqFor(sizeFrac, selfRange, board, valueFreq) {
    var alpha = alphaRatio(sizeFrac);
    var fallback = Math.min(0.9, alpha * 1.6);
    if (!selfRange || !RANGE_KEYS.length) return fallback;
    var vC = 0, aC = 0;
    for (var k in selfRange) {
      var w = selfRange[k];
      if (!(w > 0)) continue;
      var st = boardStrength(k, board);
      var c = w * rangeCombos(k);
      if (st.tier >= 3 || st.outs >= 8) vC += c;          // 价值 + 强听牌
      else if (st.tier <= 1 && st.outs < 4) aC += c;      // 空气
    }
    if (aC <= 0) return fallback;
    var p = alpha * (vC * (valueFreq || 0.7)) / aC;
    return Math.max(0, Math.min(0.9, p));
  }

  /* 按行动过滤范围。
     - call：紧缩。先按牌力排序找出"防守到 MDF 所需的牌力阈值"，
       再以该阈值为中心做平滑保留——因此**注额越大、阈值越高、弃得越多**，
       且范围整体恰好防守到 MDF = 1/(1+注额倍数)。
     - bet/raise：极化。保留强价值与诈唬（含半诈唬），压缩中间牌。
     - check：几乎全保留，顶端略降（顶端会去下注）。 */
  function filterRange(range, board, action, ctx) {
    ctx = ctx || {};
    var entries = [], origW = 0;
    for (var k in range) {
      var w = range[k];
      if (!(w > 0)) continue;
      var st = boardStrength(k, board);
      var c = w * rangeCombos(k);
      entries.push({ k: k, w: w, st: st, c: c });
      origW += c;
    }
    var out = {};

    if (action === 'call') {
      var mdf = 1 / (1 + (ctx.potFrac || 0.6));
      var targetC = mdf * origW;
      // 按牌力降序累积，找到"刚好凑够 MDF"的牌力阈值
      var sorted = entries.slice().sort(function (a, b) { return b.st.score - a.st.score; });
      var acc = 0, cutoff = sorted.length ? sorted[0].st.score : 0;
      for (var i = 0; i < sorted.length; i++) {
        acc += sorted[i].c;
        cutoff = sorted[i].st.score;
        if (acc >= targetC) break;
      }
      // 以阈值为中心平滑保留
      var soft = 6, kept = 0, gs = {};
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        var x = (e.st.score - cutoff) / soft;
        var g = 1 / (1 + Math.exp(-x));
        if (e.st.outs >= 8) g = Math.max(g, 0.6);   // 强听牌保底（其价值不完全体现在 score 里）
        gs[e.k] = g;
        kept += e.w * g * rangeCombos(e.k);
      }
      // 轻量校正：确保整体不超过 MDF
      var corr = kept > targetC && kept > 0 ? targetC / kept : 1;
      for (var m = 0; m < entries.length; m++) {
        out[entries[m].k] = Math.min(1, entries[m].w * gs[entries[m].k] * corr);
      }
      return out;
    }

    for (var n = 0; n < entries.length; n++) {
      var en = entries[n];
      out[en.k] = Math.min(1, en.w * strengthKeep(en.st, action));
    }
    return out;
  }

  /* 从加权范围采样一手具体牌（避开已占用的牌） */
  function sampleFromRange(range, usedIds) {
    var total = 0, ks = [];
    for (var k in range) {
      var w = range[k];
      if (!(w > 0)) continue;
      var c = w * rangeCombos(k);
      ks.push([k, c]); total += c;
    }
    if (total <= 0) return null;
    var r = Math.random() * total, acc = 0, pick = ks[ks.length - 1][0];
    for (var i = 0; i < ks.length; i++) { acc += ks[i][1]; if (r < acc) { pick = ks[i][0]; break; } }
    var combos = combosOfCards(pick);
    var avail = usedIds ? combos.filter(function (c) {
      return !usedIds[c[0].id] && !usedIds[c[1].id];
    }) : combos;
    if (!avail.length) return null;
    return avail[Math.floor(Math.random() * avail.length)];
  }

  /* ---------- 选项混合器（与 core.js 同构） ---------- */
  function buildOpts() {
    var list = [];
    return {
      add: function (label, prob, result) {
        if (prob > 0.001) list.push({ label: label, prob: prob, result: result });
      },
      decide: function (r) {
        if (!list.length) return { type: 'check', opts: [{ label: '过牌', prob: 1, chosen: true, act: { type: 'check' } }] };
        var acc = 0;
        var chosen = list[list.length - 1];
        for (var i = 0; i < list.length; i++) {
          acc += list[i].prob;
          if (r < acc) { chosen = list[i]; break; }
        }
        var out = chosen.result;
        out.opts = list.map(function (o) {
          return { label: o.label, prob: o.prob, chosen: o === chosen,
                   act: { type: o.result.type, to: o.result.to } };
        });
        return out;
      }
    };
  }

  var api = { createPostflop: createPostflop, analyzeBoard: analyzeBoard,
              rangeAdvantage: rangeAdvantage, classifyHand: classifyHand, sprBand: sprBand,
              BOARD_BUCKETS: BOARD_BUCKETS, bucketOf: bucketOf,
              POT_TYPE_MOD: POT_TYPE_MOD, potTypeOf: potTypeOf, bucketFreqs: bucketFreqs,
              rangeShape: rangeShape, boardAdvantage: boardAdvantage, rangeEquityVs: rangeEquityVs,
              preflopArrivalRanges: preflopArrivalRanges, advantageResidual: advantageResidual,
              bucketRefAdvantage: bucketRefAdvantage, clearAdvCache: clearAdvCache,
              cardsFromStr: cardsFromStr, BUCKET_CANONICAL: BUCKET_CANONICAL,
              RANGE_ADV_GAIN: RANGE_ADV_GAIN, ADV_CBET_SLOPE: ADV_CBET_SLOPE,
              ADV_W_RANGE: ADV_W_RANGE, ADV_W_MISS: ADV_W_MISS, ADV_VBET_SLOPE: ADV_VBET_SLOPE,
              RANGE_KEYS: RANGE_KEYS, rangeCombos: rangeCombos, rangeWidth: rangeWidth,
              makeFullRange: makeFullRange, makeEmptyRange: makeEmptyRange,
              keyOf: keyOf, combosOfCards: combosOfCards, boardStrength: boardStrength,
              filterRange: filterRange, strengthKeep: strengthKeep, sampleFromRange: sampleFromRange,
              alphaRatio: alphaRatio, bluffFreqFor: bluffFreqFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (typeof self !== 'undefined' ? self : this).PostflopEngine = api;
})();
