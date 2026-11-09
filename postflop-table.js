/* ============================================================
   翻后策略表加载与查询（postflop-table.js）
   ------------------------------------------------------------
   数据由 求解器/tools/build-flop-table.js 生成、tools/publish-table.js 打包成
   `postflop-table-data.js`（window.POSTFLOP_TABLE_DATA）。

   口径（与求解器一致，别混）：
     两街 flop+turn ｜ 15 桶 ｜ 转牌 49 张全覆盖 ｜ flop 迭代 2 万
     ⇒ 绝对精度 ±3~5pp（桶化抽象）+ ±1~2pp（种子）

   为什么需要它：postflop-engine.js 的 17 桶 c-bet 常数是**单街口径**（隐含后续街
   不再下注），系统性高估 c-bet 12~25pp。命中表时以表为准，未命中保持原逻辑。

   查询键 = 场景(池型|开注位|跟注位) + 牌面桶 + 桶内最近邻。
   只对 flop（3 张公共牌）、单挑（nOpp===1）、两街覆盖的场景生效。
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  /* ⚠ 同时挂到全局：postflop-engine.js 里用 `typeof PostflopTable !== 'undefined'` 探测，
     在 CommonJS 下模块名不会自动成为全局变量 —— 不挂的话 node 侧永远查不到表。 */
  if (root) root.PostflopTable = api;
  if (typeof global !== 'undefined') global.PostflopTable = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DATA = null;
  var POS_ORDER = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'];

  function load(d) {
    if (!d || !d.scenarios) return false;
    DATA = d;
    return true;
  }

  function ready() { return !!DATA; }

  /* 从 POSTFLOP_TABLE_DATA 里取数据键（打包时已按桶预分组，这里建 面→条目 索引） */
  function scen(key) {
    return DATA && DATA.scenarios ? DATA.scenarios[key] : null;
  }

  function potTypeOf(raises) {
    if (raises >= 3) return null;       // 4-bet 池：表未覆盖
    if (raises === 2) return 'threebet';
    return 'srp';
  }

  /* 场景键：表按 `池型|开注位|跟注位` 存档（跟注位在 3BP 里 = 3-bettor） */
  var PREFIX = { srp: 'SRP', threebet: '3BP' };
  function scenKeyOf(pf, potType) {
    if (!pf) return null;
    var pre = PREFIX[potType];
    if (!pre) return null;
    var opener = pf.opener;
    var caller = potType === 'threebet'
      ? (pf.threeBettor || pf.lastRaiser)
      : (pf.firstCaller || pf.openFirstCaller);
    if (!opener || !caller || opener === caller) return null;
    var k = pre + '|' + opener + '|' + caller;
    if (scen(k)) return k;
    /* 容错：调用方把开注/跟注写反（或 lastRaiser 与 threeBettor 同名）时试一次交换 */
    var k2 = pre + '|' + caller + '|' + opener;
    return scen(k2) ? k2 : null;
  }

  /* 5 维几何特征的距离（与 build-flop-table 存的 feats 同序：
     topRank, wetness, paired, monotone, straighty） */
  function dist(a, b) {
    var w = [1 / 14, 1 / 3, 1, 1, 1];
    var s = 0;
    for (var i = 0; i < 5; i++) {
      var d = ((a[i] || 0) - (b[i] || 0)) * w[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }

  function boardFeats(b) {
    return [b.topRank || 0, b.wetness || 0, b.paired ? 1 : 0, b.monotone ? 1 : 0, b.straighty ? 1 : 0];
  }

  /* 主查询
     o = { pf, posName, board(analyzeBoard 结果), nOpp, toCall, currentBet, myBet }
     返回 null（未覆盖）或
       { freq, size, bySize, oopLead, ipCbet, pick:{face,cls,dist,scenario,node} } */
  function lookup(o) {
    if (!DATA || !o || !o.board) return null;
    if (o.nOpp !== undefined && o.nOpp !== 1) return null;     // 只覆盖单挑
    var pf = o.pf || {};
    var potType = potTypeOf(pf.raises || 0);
    if (!potType) return null;
    var key = scenKeyOf(pf, potType);
    if (!key) return null;
    var s = scen(key);
    if (!s || !s.faces || !s.faces.length) return null;

    /* 桶内最近邻（优先同桶；同桶为空时退化为全场景最近邻）
       ⚠ analyzeBoard() 把桶对象挂在 `board.bucket`（= {id,label,...}），不是字符串 */
    var cls = (o.board.bucket && o.board.bucket.id) || o.board.id || o.board.cls;
    var pool = s.faces.filter(function (f) { return f.cls === cls; });
    if (!pool.length) pool = s.faces;
    var v = boardFeats(o.board);
    var best = null, bd = Infinity;
    for (var i = 0; i < pool.length; i++) {
      var d = dist(v, pool[i].feats);
      if (d < bd) { bd = d; best = pool[i]; }
    }
    if (!best) return null;

    var meIP = (o.posName === best.ipPos);
    var meOOP = (o.posName === best.oopPos);
    var toCall = o.toCall || 0;
    var node = null, freq = null;

    if (meIP && toCall <= 0.001 && best.vsCheck) {
      node = 'vsCheck';                       // IP 面对过牌：c-bet 频率
      freq = best.sum.ipCbet;
    } else if (meOOP && (o.currentBet || 0) <= 0.001 && (o.myBet || 0) <= 0.001) {
      node = 'root';                          // OOP 首个决策：领先下注频率
      freq = best.sum.oopLead;
    } else {
      return null;                            // 面对下注 / 加注等节点表未存
    }
    if (freq == null) return null;

    /* 主导尺寸：按桶的 key 数加权汇总该节点的动作分布，取最大的下注动作。
       （summary 里的 bySize 是全局聚合，这里用逐桶表重算，才能对上 root/vsCheck） */
    var side = (node === 'vsCheck') ? 'ip' : 'oop';
    var mix = sizeMix(best, node, side);
    var size = mix.size;

    /* 逐手牌：hole → key → 桶 → 该桶的动作分布。
       这一层比"手牌分级 × 桶基线"更硬：桶内所有手牌策略本来就相同（桶化的定义），
       直接取桶分布 = 取求解值。 */
    var hk = keyOfHole(o.hole);
    var bk = hk ? bucketOfKey(best, side, hk) : null;
    var handBet = null, handSize = null, handMix = null;
    if (bk != null) {
      var n = best[node];
      handMix = n && n.m ? n.m[bk] : null;
      if (handMix) {
        handBet = 0;
        for (var j = 1; j < handMix.length; j++) handBet += handMix[j];
        var bj = -1, bf = -1;
        for (var j2 = 1; j2 < handMix.length; j2++) {
          if (handMix[j2] > bf) { bf = handMix[j2]; bj = j2; }
        }
        handSize = (n.sizes && typeof n.sizes[bj] === 'number') ? n.sizes[bj] : size;
      }
    }

    return {
      freq: freq,
      size: size,
      bySize: mix.by,
      oopLead: best.sum.oopLead,
      ipCbet: best.sum.ipCbet,
      holeKey: hk,
      bucket: bk,
      handBetFreq: handBet,      // 该手牌（= 该桶）在本节点的下注总频率
      handSize: handSize,        // 该手牌的主导尺寸（名义 fraction）
      handMix: handMix,          // [check, bet33, bet75, bet125] 原始分布
      pick: { face: best.face, cls: best.cls, dist: bd, scenario: key, node: node }
    };
  }

  /* 手牌 → 169 键（与 board-strength / gw-ranges 同序：p{rank} / s{hi}_{lo} / o{hi}_{lo}） */
  function keyOfHole(hole) {
    if (!hole || hole.length < 2) return null;
    var a = hole[0], b = hole[1];
    if (a.r == null || b.r == null) return null;
    var hi = Math.max(a.r, b.r), lo = Math.min(a.r, b.r);
    if (hi === lo) return 'p' + hi;
    return (a.s === b.s ? 's' : 'o') + hi + '_' + lo;
  }

  /* 该节点各下注动作的加权分布（权重 = 该桶里的 key 数，近似组合质量） */
  function sizeMix(face, node, side) {
    var n = face[node];
    var groups = (face.keys && face.keys[side]) || [];
    var out = {}, tot = 0;
    if (n && n.m) {
      for (var b = 0; b < n.m.length; b++) {
        var w = groups[b] ? groups[b].length : 0;
        if (!w) continue;
        var row = n.m[b];
        for (var j = 1; j < row.length; j++) {
          if (!row[j]) continue;
          out[j] = (out[j] || 0) + w * row[j];
          tot += w * row[j];
        }
      }
    }
    var by = {}, bestJ = -1, bestF = -1;
    Object.keys(out).forEach(function (j) {
      var p = out[j] / (tot || 1);
      var nm = n && n.sizes ? n.sizes[j] : null;
      by[(nm != null ? Math.round(nm * 100) : j) + '%'] = +p.toFixed(4);
      if (p > bestF) { bestF = p; bestJ = +j; }
    });
    var size = 0.33;
    if (n && n.sizes && bestJ >= 0 && typeof n.sizes[bestJ] === 'number') size = n.sizes[bestJ];
    return { size: size, by: by, mix: +Math.max(0, bestF).toFixed(4) };
  }

  /* key → 桶（表里按桶存 key 列表） */
  function bucketOfKey(face, side, key) {
    if (!key || !face.keys || !face.keys[side]) return null;
    var g = face.keys[side];
    for (var i = 0; i < g.length; i++) if (g[i].indexOf(key) >= 0) return i;
    return null;
  }

  function meta() { return DATA ? DATA.meta : null; }

  return { load: load, ready: ready, lookup: lookup, meta: meta, bucketOfKey: bucketOfKey };
});
