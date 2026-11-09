/* test-solver-bridge.js —— 现场解桥接行为测试（2026-10-19）
 *
 * 做法：Node 里起一个「假浏览器」——
 *   · 真内核：solver-kernel-src.js 的 __SOLVER_KERNEL_SRC 在一个假 Worker 里执行；
 *   · 真桥接：postflop-solver-bridge.js 原样加载；
 *   · 假 DOM：只提供 createElement/appendChild/body，够徽标用。
 * 断言：turn 两街解能出结果并按树返回合法动作、路径记录能导航到子节点、
 *       不匹配路径/多人池/代际不符/内核缺失一律返回 null（回退旧引擎）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, name, detail) {
  if (c) { pass++; console.log('  ok ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

/* ---------- 假 DOM ---------- */
function FakeEl(tag) {
  this.tag = tag || 'div'; this.style = {}; this.textContent = ''; this.children = [];
  this.parentNode = null;
}
FakeEl.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; return c; };
FakeEl.prototype.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; };

global.document = {
  body: new FakeEl('body'),
  createElement: function (t) { return new FakeEl(t); }
};

/* ---------- 真内核 + 假 Worker ---------- */
global.window = global;
new Function(fs.readFileSync(path.join(__dirname, 'solver-kernel-src.js'), 'utf8'))();
const KERNEL_SRC = global.__SOLVER_KERNEL_SRC;
ok(typeof KERNEL_SRC === 'string' && KERNEL_SRC.length > 10000, '内核源已就绪', String(KERNEL_SRC && KERNEL_SRC.length));

let workerCount = 0;
function FakeWorker() {
  workerCount++;
  const inst = this;
  /* self 在内核脚本里被赋值 onmessage；内核 emit → 回到实例的 onmessage（桥接挂的） */
  const selfObj = {
    onmessage: null,
    postMessage: function (m) {
      const h = inst.onmessage;
      if (h) setImmediate(function () { h({ data: m }); });
    }
  };
  new Function('self', KERNEL_SRC)(selfObj);
  this.postMessage = function (m) { selfObj.onmessage({ data: m }); };
  this.terminate = function () {};
}
global.Worker = FakeWorker;
/* 不替换 Blob（Node 22 自带，URL 的校验认它）；只把 createObjectURL 打桩。
   也不能整体替换 URL：本机 node 的 fs 垫片用 `instanceof URL` 判路径 */
global.URL.createObjectURL = function () { return 'blob:fake'; };

/* ---------- 真桥接 ---------- */
new Function(fs.readFileSync(path.join(__dirname, 'postflop-solver-bridge.js'), 'utf8'))();
ok(global.SolverBridge && typeof global.SolverBridge.onStreetStart === 'function',
  '桥接模块已加载并暴露 onStreetStart/decideFor');

const SB = global.SolverBridge;
const BB = 2;
const POT_BB = 6.5;

function startTurn(over) {
  const info = Object.assign({
    gen: 1, street: 'turn', mode: 'single',
    boardStr: 'Ah 7d 2c Ts', pfCtx: { raises: 1, opener: 'BTN', firstCaller: 'BB' },
    pot: POT_BB * BB, stack: 97 * BB, nPlayers: 2, bb: BB, seed: 5
  }, over || {});
  SB.onStreetStart(info);
  return info;
}
function waitReady(ms) {
  const t0 = Date.now();
  return new Promise(function (res) {
    (function tick() {
      const st = SB._state();
      if (!st || st.status !== 'solving') return res(st);
      if (Date.now() - t0 > (ms || 30000)) return res(st);
      setTimeout(tick, 60);
    })();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  console.log('\n① 非适用场景直接不工作（回退旧引擎）');
  let info = startTurn({ nPlayers: 3 });
  ok(SB._state() === null, '① 多人池（3 人在手）→ 不起解');
  info = startTurn({ pfCtx: { raises: 0, opener: null } });
  ok(SB._state() === null, '① 无人开池（跛入池）→ 不起解');
  info = startTurn({ boardStr: 'Ah 7d 2c' });
  ok(SB._state() === null, '① flop（3 张）→ 不起解（走查表）');
  info = startTurn({ mode: 'client' });
  ok(SB._state() === null, '① 客机（mode=client）→ 不起解');
  info = startTurn({ gen: 2 });
  ok(await SB.decideFor({ gen: 1, hole: [{ r: 14, s: 0, id: 'Ah' }, { r: 13, s: 1, id: 'Kd' }], posName: 'BB', toCall: 0, myBet: 0, potNow: 13 * BB, bb: BB }) === null,
    '① 代际不符（上一手残留）→ null');

  console.log('\n② turn 两街现场解（BB 先行动）');
  const t0 = Date.now();
  startTurn();
  let st = await waitReady(30000);
  const solveMs = Date.now() - t0;
  ok(st && st.status === 'ready', '② turn 解算完成', '状态 ' + (st && st.status) + ' ' + (st && st.why));
  ok(st && st.oop === 'BB' && st.ip === 'BTN', '② 位置识别 OOP=BB / IP=BTN', st ? st.oop + '/' + st.ip : '');
  console.log('     解算耗时 ' + (solveMs / 1000).toFixed(1) + 's');

  /* 树根 actor=1（OOP/BB）→ AI 拿 BB 的牌决策 */
  const holeBB = [{ r: 12, s: 0, id: 'Qh' }, { r: 11, s: 0, id: 'Jh' }];
  const a1 = await SB.decideFor({ gen: 1, hole: holeBB, posName: 'BB', toCall: 0, myBet: 0, potNow: POT_BB * BB, bb: BB });
  ok(!!a1, '② AI(BB) 在树根拿到策略', a1 ? '' : 'null（未命中，会回退）');
  if (a1) {
    ok(['check', 'raise'].indexOf(a1.a.type) >= 0, '② 树根动作合法（check/下注）', JSON.stringify(a1.a));
    ok(Array.isArray(a1.opts) && a1.opts.length >= 2, '② 附带频率分布 opts', String(a1.opts && a1.opts.length));
    const sum = (a1.opts || []).reduce((s, x) => s + x.prob, 0);
    ok(Math.abs(sum - 1) < 0.08, '② 频率合计 ≈ 1', sum.toFixed(3));
    ok(a1.opts.every(x => x.prob >= 0 && x.prob <= 1.001), '② 单项频率在 [0,1]');
  }

  console.log('\n③ 路径匹配：BB 过牌 → BTN 下注 → BB 面对下注');
  /* BB 记录 check，然后 BTN 下注 33%（bridge 只做记录，实际动作由游戏侧驱动） */
  SB.recordAction({ posName: 'BB', type: 'check', to: 0, toCall: 0 });
  const a2 = await SB.decideFor({ gen: 1, hole: [{ r: 7, s: 1, id: '7h' }, { r: 7, s: 2, id: '7s' }], posName: 'BTN', toCall: 0, myBet: 0, potNow: POT_BB * BB, bb: BB });
  ok(!!a2, '③ 过牌后轮到 IP 拿到策略', a2 ? '' : 'null');
  if (a2) {
    /* 取 33% 那条下注：to = size * pot（树里 bet33 = 0.3077 池 ≈ 2bb） */
    const bet33 = (a2.opts || []).filter(x => x.act.type === 'raise').sort((x, y) => x.act.to - y.act.to)[0];
    ok(!!bet33, '③ 树里有下注尺寸可选', JSON.stringify((a2.opts || []).map(x => x.act)));
    if (bet33) {
      const amtBB = bet33.act.to / BB;
      ok(amtBB > 1 && amtBB < POT_BB, '③ 下注额在 1bb ~ 底池之间', amtBB.toFixed(2) + 'bb');
      SB.recordAction({ posName: 'BTN', type: 'raise', to: bet33.act.to, toCall: 0 });
      const a3 = await SB.decideFor({
        gen: 1, hole: holeBB, posName: 'BB', toCall: bet33.act.to, myBet: 0,
        oppBet: bet33.act.to, potNow: (POT_BB + amtBB) * BB, bb: BB
      });
      ok(!!a3, '③ 面对下注能导航到子节点并出策略', a3 ? '' : 'null（尺寸/路径没对上）');
      if (a3) {
        ok(['fold', 'call', 'raise'].indexOf(a3.a.type) >= 0, '③ 面对下注动作合法（fold/call/raise）', JSON.stringify(a3.a));
        const rz = (a3.opts || []).filter(function (x) { return x.act.type === 'raise'; });
        ok(rz.length === 0 || rz.every(function (x) { return x.act.to > bet33.act.to; }),
          '③ 加注额大于面对的下注额（树里 size 是 to 口径）',
          JSON.stringify(rz.map(function (x) { return x.act.to; })) + ' vs bet ' + bet33.act.to);
      }
      /* 路径不匹配：一个树里不存在的超大加注 */
      SB.recordAction({ posName: 'BB', type: 'raise', to: 900, toCall: bet33.act.to });
      const bad = await SB.decideFor({ gen: 1, hole: holeBB, posName: 'BTN', toCall: 0, myBet: bet33.act.to, potNow: 40 * BB, bb: BB });
      ok(bad === null, '③ 非标尺寸加注 → 路径不匹配，返回 null（回退旧引擎）', bad ? JSON.stringify(bad.a) : '');
    }
  }

  console.log('\n④ river 精确单街');
  const t1 = Date.now();
  startTurn({ gen: 2, street: 'river', boardStr: 'Ah 7d 2c Ts 4h', seed: 11 });
  st = await waitReady(30000);
  const riverMs = Date.now() - t1;
  ok(st && st.status === 'ready', '④ river 解算完成', '状态 ' + (st && st.status) + ' ' + (st && st.why));
  console.log('     解算耗时 ' + (riverMs / 1000).toFixed(1) + 's');
  const a4 = st && st.status === 'ready'
    ? await SB.decideFor({ gen: 2, hole: [{ r: 12, s: 0, id: 'Qh' }, { r: 11, s: 0, id: 'Jh' }], posName: 'BB', toCall: 0, myBet: 0, potNow: 30 * BB, bb: BB })
    : null;
  ok(!!a4, '④ river 拿到策略', a4 ? JSON.stringify(a4.a) : 'null');

  console.log('\n⑤ 内核缺失 / 空状态');
  const saved = global.__SOLVER_KERNEL_SRC;
  global.__SOLVER_KERNEL_SRC = null;
  /* 桥接缓存了 worker，这里改看空状态分支：清掉当前会话 */
  SB.onStreetStart({ gen: 9, street: 'turn', mode: 'single', boardStr: 'Ah 7d 2c Ts', pfCtx: { raises: 1, opener: 'BTN', firstCaller: 'BB' }, pot: 13, stack: 100, nPlayers: 2, bb: 2 });
  ok(SB._state() === null || SB._state().status === 'solving', '⑤ 无内核源时 onStreetStart 不抛异常（静默禁用）');
  global.__SOLVER_KERNEL_SRC = saved;
  ok(await SB.decideFor({ gen: 99, hole: holeBB, posName: 'BB', toCall: 0, myBet: 0, bb: BB }) === null,
    '⑤ 无活跃会话 → null');

  console.log('\n--- 结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('异常:', e);
  process.exit(1);
});
