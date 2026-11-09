/* postflop-solver-bridge.js —— app 的 turn/river 现场解桥接（2026-10-19）
 *
 * 职责：
 *   1. 用 Blob Worker 实例化求解内核（源来自 solver-kernel-src.js 的 __SOLVER_KERNEL_SRC）；
 *   2. turn/river 街开始时后台起「现场解」：turn = turn+river 两街（48 张河牌全覆盖，
 *      内核 solveFlopMulti 以 4 张牌面为根，实测 ~6s）；river = 终街精确单街（~2s）；
 *   3. AI 决策时把「本街已发生的动作路径」匹配回求解树节点，取该手牌所在桶的策略分布，
 *      按频率采样动作；任何不匹配（非标尺寸/加注链断裂/超时/多人池）→ 返回 null，
 *      调用方回退原引擎（postflop-engine）。
 *   4. 解算期间在桌面显示「AI 解算中」徽标。
 *
 * 口径：无 rake；15 桶；flop 迭代 2 万；子街 400 迭代 / 深街分桶 400；尺寸 [33%,75%,125%]。
 * 范围：worker 内按 pfCtx 从 gw-ranges 行动线重建（与求解器壳/翻后表同源）。
 * 只在 heads-up（2 人在手）启用；多人池直接回退。
 *
 * 游戏侧钩子（html 内 4 处）：
 *   SolverBridge.onStreetStart({gen,street,mode,boardStr,pfCtx,pot,stack,nPlayers,bb,seed})
 *   SolverBridge.recordAction({posName,type,to,toCall})     （applyAction 内）
 *   const sv = await SolverBridge.decideFor({gen,hole,posName,toCall,myBet,oppBet,potNow,bb})
 *   调用点 aiDecideAction 改 await。
 */
(function (global) {
  'use strict';

  var W = global;
  var DEBUG = false;
  var S = {
    worker: null, seq: 0,
    cur: null,          // 当前街的解算状态
    badge: null
  };

  /* ---------------- 徽标 ---------------- */
  function badgeShow(txt) {
    if (!S.badge) {
      var d = document.createElement('div');
      d.id = 'solverBadge';
      d.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'background:rgba(20,22,26,.88);color:#ffd76a;font:600 13px/1.4 system-ui,sans-serif;' +
        'padding:7px 16px;border-radius:20px;box-shadow:0 2px 12px rgba(0,0,0,.4);' +
        'pointer-events:none;display:none;letter-spacing:.5px;';
      document.body.appendChild(d);
      S.badge = d;
    }
    S.badge.textContent = txt || '🧮 AI 解算中…';
    S.badge.style.display = 'block';
  }
  function badgeHide() { if (S.badge) S.badge.style.display = 'none'; }

  /* ---------------- worker ---------------- */
  function ensureWorker() {
    if (S.worker) return S.worker;
    if (!W.__SOLVER_KERNEL_SRC) return null;   // 内核源脚本未加载 → 桥接静默禁用
    var blob = new Blob([W.__SOLVER_KERNEL_SRC], { type: 'application/javascript' });
    var w = new Worker(URL.createObjectURL(blob));
    w.onmessage = function (ev) { onMsg(ev.data); };
    w.onerror = function () { failCur('worker error'); };
    S.worker = w;
    return w;
  }
  function send(msg) {
    var w = ensureWorker();
    if (!w) { failCur('内核不可用'); return; }
    w.postMessage(msg);
  }
  function onMsg(m) {
    var c = S.cur; if (!c || !m) return;
    if (m.type === 'preset' && m.id === c.preId) { afterPreset(c, m); return; }
    if (m.id !== c.solveId) return;
    if (m.type === 'progress') {
      badgeShow('🧮 AI 解算中 ' + m.stage + ' ' + m.cur + '/' + m.tot);
    } else if (m.type === 'result') {
      c.status = 'ready';
      c.data = m.result;
      badgeHide();
      if (c.resolve) c.resolve();
    } else if (m.type === 'error') {
      failCur(m.error && m.error.split('\n')[0]);
    }
  }
  function failCur(why) {
    var c = S.cur; if (!c) { try { console.warn('[SolverBridge] 失败（无会话）：', why); } catch (e2) { } return; }
    c.status = 'none'; c.why = why;
    badgeHide();
    if (c.resolve) c.resolve();
    try { console.warn('[SolverBridge] 弃用现场解：', why); } catch (e) { }
  }

  /* ---------------- 街开始：起解 ---------------- */
  function onStreetStart(info) {
    S.cur = null;
    badgeHide();
    try {
      if (!info || (info.mode !== 'single' && info.mode !== 'train')) return;
      if (info.nPlayers !== 2) return;                 // 只解 heads-up
      if (!info.pfCtx || !info.pfCtx.opener) return;   // 无人开池（跛入池）不在范围表覆盖内
      var nCards = (info.boardStr || '').trim().split(/\s+/).length;
      if (nCards !== 4 && nCards !== 5) return;        // flop 走查表，这里只管 turn/river
      if (!ensureWorker()) return;

      var c = {
        solveId: 'sv' + (++S.seq), preId: 'pre' + S.seq,
        gen: info.gen, street: info.street, boardStr: info.boardStr,
        bb: info.bb || 1, pot0bb: info.pot / (info.bb || 1),
        stackBB: info.stack / (info.bb || 1), seed: info.seed || 5,
        status: 'solving', data: null, why: null, resolve: null, path: [],
        oopPos: null, ipPos: null,
        /* turn 两街 = 48 张河牌全覆盖；river = 终街精确单街 */
        jobStreets: nCards === 4 ? 2 : 1
      };
      S.cur = c;
      badgeShow('🧮 AI 解算中…');
      /* worker 收到脚本执行前的 postMessage 会自动排队，presets/solve 可连续发 */
      S.worker.postMessage({ type: 'preset', id: c.preId, pf: {
        raises: info.pfCtx.raises || 0,
        opener: info.pfCtx.opener,
        firstCaller: info.pfCtx.firstCaller || info.pfCtx.openFirstCaller || null,
        threeBettor: info.pfCtx.threeBettor || null,
        lastRaiser: info.pfCtx.lastRaiser || info.pfCtx.threeBettor || null
      }});
    } catch (e) { failCur(String(e)); }
  }

  function afterPreset(c, m) {
    if (!m || !m.ok) { failCur('行动线不在范围表内'); return; }
    c.oopPos = m.oop.pos; c.ipPos = m.ip.pos;
    send({
      type: 'solve', id: c.solveId,
      job: {
        boardStr: c.boardStr, pot: c.pot0bb, stack: c.stackBB,
        sizes: [0.33, 0.75, 1.25], maxRaises: 2, allinAllowed: 'auto', rake: false,
        buckets: 15, eqSamples: 800, payoffSamples: 300, iters: 20000,
        seed: c.seed || 5, payoffSeed: (c.seed || 5) + 1013,
        oopPos: m.oop.pos, ipPos: m.ip.pos,
        oop: { scalar: m.oop.scalar, comboW: {} },
        ip: { scalar: m.ip.scalar, comboW: {} },
        streets: c.jobStreets,
        turnCards: c.jobStreets === 2 ? 48 : 0,   /* turn 起点：该参数 = 河牌张数 */
        turnIters: 400, turnSamples: 200,
        bucketSamples: 800, deepBucketSamples: 400
      }
    });
  }

  /* ---------------- 本街动作记录 ---------------- */
  function sideOf(posName) {
    var c = S.cur; if (!c || !c.oopPos) return null;
    if (posName === c.oopPos) return 'oop';
    if (posName === c.ipPos) return 'ip';
    return null;
  }
  function recordAction(a) {
    var c = S.cur; if (!c || c.status !== 'solving' && c.status !== 'ready') return;
    var side = sideOf(a.posName);
    c.path.push({
      side: side, type: a.type, to: a.to || 0, toCall: a.toCall || 0,
      ok: !!side
    });
  }

  /* ---------------- 决策：匹配节点 + 逐手牌采样 ---------------- */
  function keyOfHole(hole) {
    if (!hole || hole.length < 2 || hole[0].r == null) return null;
    var hi = Math.max(hole[0].r, hole[1].r), lo = Math.min(hole[0].r, hole[1].r);
    if (hi === lo) return 'p' + hi;
    return (hole[0].s === hole[1].s ? 's' : 'o') + hi + '_' + lo;
  }
  /* 尺寸匹配：取树内同 kind 动作里「金额最近」的一个，差值 ≤ max(0.35bb, 10%) 才算命中。
     （树内 chipRound=1bb 取整，游戏内 0.5bb 步进；阈值太松会把 40% 池吸附到 33% 桶） */
  function amtEq(a, b, bb) {
    var d = Math.abs(a - b);
    return d <= Math.max(0.35 * bb, 0.10 * Math.max(a, b));
  }
  /* 沿记录路径把树走到当前节点；返回 {node, meta, totals} 或 null */
  function matchNode(c) {
    var d = c.data; if (!d) return null;
    var byId = {}; d.nodeMeta.forEach(function (m) { byId[m.id] = m; });
    var node = d.nodeMeta.filter(function (m) { return m.parent === null; })[0];
    if (!node) return null;
    var totals = { oop: 0, ip: 0 };    // 各自本街投入（**筹码**口径，与 game 的 bet 对齐）
    for (var i = 0; i < c.path.length; i++) {
      var rec = c.path[i];
      if (!rec.ok) return null;
      if ((node.actor === 1 ? 'oop' : 'ip') !== rec.side) return null;
      var act = null;
      if (rec.type === 'check' || rec.type === 'call' || rec.type === 'fold') {
        var wantKind = rec.type;
        for (var j = 0; j < node.actions.length; j++) {
          if (node.actions[j].kind === wantKind) { act = node.actions[j]; break; }
        }
      } else if (rec.type === 'raise') {
        /* bet（无人在我面前下注）或 raise（面对下注加注）：最近邻匹配 */
        var bestD = Infinity;
        for (var j2 = 0; j2 < node.actions.length; j2++) {
          var A2 = node.actions[j2];
          if (A2.kind !== 'bet' && A2.kind !== 'raise') continue;
          if (A2.kind === 'bet' && rec.toCall > 0) continue;       // 树里是开注，游戏里是面对下注
          if (A2.kind === 'raise' && rec.toCall <= 0) continue;    // 反之亦然
          /* 单位统一：树里 size 是「底池比例」，游戏里 rec.to 是筹码 → 必须 ×pot×bb 再比 */
          var amt = A2.size * c.pot0bb * c.bb;
          var dCur = Math.abs(amt - rec.to);
          if (dCur < bestD) { bestD = dCur; act = A2; }
        }
        if (act && !amtEq(act.size * c.pot0bb * c.bb, rec.to, c.bb)) act = null;   // 最近邻也不够近 → 不匹配
      }
      if (!act) return null;
      /* 本街累计投入（筹码）：下注/加注 to 是"到多少"，跟注按 toCall 累加 */
      if (rec.type === 'raise') totals[rec.side] = rec.to;
      else if (rec.type === 'call') totals[rec.side] += rec.toCall;
      /* 走到子节点（与求解器壳导航同法：parent + via） */
      var label = act.label;
      var child = null;
      if (!d.nodeMeta) { if (DEBUG) console.log('[dbg] d.nodeMeta 缺失，d keys=', Object.keys(d).join(',')); return null; }
      for (var k = 0; k < d.nodeMeta.length; k++) {
        var m2 = d.nodeMeta[k];
        if (m2.parent === node.id && m2.via === label) { child = m2; break; }
      }
      if (!child) return null;
      node = child;
    }
    return { node: node, meta: byId, totals: totals };
  }

  function decideFor(o) {
    var c = S.cur;
    if (!c || c.gen !== o.gen) return Promise.resolve(null);
    if (c.status === 'solving') {
      badgeShow('🧮 AI 解算中…');
      var p = new Promise(function (res) { c.resolve = res; });
      var timeout = new Promise(function (res) { setTimeout(res, 25000); });
      return Promise.race([p, timeout]).then(function () {
        badgeHide();
        return decideNow(c, o);
      });
    }
    if (c.status !== 'ready') return Promise.resolve(null);
    return Promise.resolve(decideNow(c, o));
  }

  function decideNow(c, o) {
    try {
      if (DEBUG) console.log('[dbg] decideNow gen=' + c.gen + ' status=' + c.status + ' dataKeys=' + (c.data ? Object.keys(c.data).join('|') : 'null') + ' wantGen=' + o.gen);
      if (c.status !== 'ready' || !c.data) { if (DEBUG) console.log('[dbg] status', c.status); return null; }
      var side = sideOf(o.posName);
      if (!side) return null;
      var hit = matchNode(c);
      if (!hit) { if (DEBUG) console.log('[dbg] 路径未匹配'); return null; }
      if ((hit.node.actor === 1 ? 'oop' : 'ip') !== side) { if (DEBUG) console.log('[dbg] actor 侧不符', hit.node.actor, side); return null; }
      /* 街投入一致性：树上走到该节点的累计投入 ≈ 游戏内实际投入（防止路径漏记） */
      var myT = hit.totals[side];
      if (o.myBet > 0 && !amtEq(myT, o.myBet, c.bb)) { if (DEBUG) console.log('[dbg] 投入不符', myT, o.myBet); return null; }

      var key = keyOfHole(o.hole); if (!key) return null;
      var entry = null;
      var ks = c.data.keys[side === 'oop' ? 'oop' : 'ip'];
      for (var i = 0; i < ks.length; i++) if (ks[i].key === key) { entry = ks[i]; break; }
      if (!entry) { if (DEBUG) console.log('[dbg] 手牌 key 不在范围', key); return null; }
      var row = null;
      var out = c.data.nodeOut.filter(function (n) { return n.id === hit.node.id; })[0];
      if (!out) return null;
      for (var j = 0; j < out.perBucket.length; j++) {
        if (out.perBucket[j].bucket === entry.b) { row = out.perBucket[j]; break; }
      }
      if (!row || !row.probs) return null;

      /* 按频率采样动作 */
      var names = Object.keys(row.probs), tot = 0, r = Math.random();
      names.forEach(function (nm) { tot += row.probs[nm]; });
      if (!(tot > 0.01)) return null;
      var pick = names[0], acc = 0;
      r *= tot;
      for (var k = 0; k < names.length; k++) {
        acc += row.probs[names[k]];
        if (r <= acc) { pick = names[k]; break; }
      }
      var A = null;
      for (var k2 = 0; k2 < hit.node.actions.length; k2++) {
        if (hit.node.actions[k2].name === pick) { A = hit.node.actions[k2]; break; }
      }
      if (!A) return null;
      var a;
      if (A.kind === 'check') a = { type: o.toCall > 0 ? 'call' : 'check' };
      else if (A.kind === 'call') a = { type: 'call' };
      else if (A.kind === 'fold') a = { type: 'fold' };
      else {
        var amtChips = Math.round(A.size * c.pot0bb * c.bb * 2) / 2;
        var to = (A.kind === 'bet') ? o.myBet + amtChips : amtChips;
        a = { type: 'raise', to: to };
      }
      /* 展示用 opts（频率条与 remarkChosen 兼容） */
      var opts = hit.node.actions.map(function (A2) {
        var pr = row.probs[A2.name] || 0;
        var act2;
        if (A2.kind === 'check') act2 = { type: o.toCall > 0 ? 'call' : 'check' };
        else if (A2.kind === 'call') act2 = { type: 'call' };
        else if (A2.kind === 'fold') act2 = { type: 'fold' };
        else {
          var amt2 = Math.round(A2.size * c.pot0bb * c.bb * 2) / 2;
          act2 = { type: 'raise', to: (A2.kind === 'bet') ? o.myBet + amt2 : amt2 };
        }
        return { act: act2, prob: pr };
      }).filter(function (x) { return x.prob > 0.005; });
      return { a: a, opts: opts, from: 'solver' };
    } catch (e) {
      try { console.warn('[SolverBridge] decideNow 异常，回退引擎', e); } catch (e2) { }
      return null;
    }
  }

  W.SolverBridge = {
    onStreetStart: onStreetStart,
    recordAction: recordAction,
    decideFor: decideFor,
    /* 诊断用 */
    _debug: function () { DEBUG = true; },
    _state: function () { return S.cur ? { status: S.cur.status, why: S.cur.why, path: S.cur.path, oop: S.cur.oopPos, ip: S.cur.ipPos, street: S.cur.street } : null; }
  };
})(typeof window !== 'undefined' ? window : this);
