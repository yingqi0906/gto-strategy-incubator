/* 客机（手机端）行动条健壮性测试
   复现并防回归："超能力单挑时客机按钮全灰无法操作"（手机反复切屏触发）
   1) 无头 UI：快照→行动条状态对齐、动作可靠投递（重发/去重/超时兜底）、切屏恢复
   2) 服务器 E2E：动作序号中继、已除名客户端明确回执、超时除名后可同名重新加入、轮询中断不残留 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REAL_FETCH = global.fetch;   // UI 测试会替换 fetch 桩，E2E 前必须还原

/* ================= 第一部分：无头 UI ================= */
async function uiTests() {
  console.log('--- 无头 UI：客机行动条健壮性 ---');
  class FakeEl {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this._class = new Set();
      this.style = {};
      this.parentNode = null;
      this.textContent = '';
      this._innerHTML = '';
      this.disabled = false;
      this.value = '';
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.onclick = null;
      this._qs = {};
      this._listeners = {};
    }
    get classList() {
      const self = this;
      return {
        add: c => self._class.add(c),
        remove: c => self._class.delete(c),
        toggle: (c, f) => {
          if (f === undefined) { self._class.has(c) ? self._class.delete(c) : self._class.add(c); }
          else if (f) self._class.add(c); else self._class.delete(c);
        },
        contains: c => self._class.has(c)
      };
    }
    appendChild(ch) { ch.parentNode = this; this.children.push(ch); return ch; }
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; }
    get className() { return [...this._class].join(' '); }
    set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) { this._innerHTML = v; this.children = []; }
    querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
    querySelectorAll() { return []; }
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
    removeEventListener(ev, fn) { const a = this._listeners[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    setAttribute() {}
    focus() {}
    blur() {}
  }
  const byId = {};
  global.document = {
    hidden: false,
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(tag); },
    querySelector(sel) { if (!byId[sel]) byId[sel] = new FakeEl(); return byId[sel]; },
    addEventListener() {}
  };
  global.window = global;
  if (typeof global.addEventListener !== 'function') global.addEventListener = function () {};
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  global.PokerCore = require('./core.js');

  /* fetch 桩：/api/msg 可控失败；/api/poll 模拟长轮询（延迟返回） */
  const calls = [];
  let failMsg = false;
  global.fetch = function (url, opt) {
    const u = String(url);
    calls.push({ url: u, body: opt && opt.body ? JSON.parse(opt.body) : null });
    if (u.indexOf('/api/poll') === 0) {
      return new Promise(function (res, rej) {
        const signal = opt && opt.signal;
        const t = setTimeout(function () {
          res({ json: () => Promise.resolve({ ok: true, seq: calls.filter(c => c.url.indexOf('/api/poll') === 0).length, msgs: [] }) });
        }, 150);
        if (signal && signal.addEventListener) signal.addEventListener('abort', function () { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
    if (u.indexOf('/api/msg') === 0) {
      if (failMsg) return Promise.reject(new Error('network interrupted'));
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };

  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  eval(js);
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const T = global.window.__PokerTest;
  const bar = () => byId['action-bar'];
  const msg = () => byId['table-msg'];
  const snap = (o) => Object.assign({
    phase: 'playing', handNo: 1, street: 'preflop', board: [], actingIdx: 1,
    seats: [
      { name: '主机', type: 'host', chips: 100, bet: 1, inHand: true, hole: [] },
      { name: '手机客机', type: 'client', chips: 99, bet: 1, inHand: true, hole: [] }
    ],
    log: [], hist: [], exited: []
  }, o || {});

  /* --- 源码级 --- */
  ok(/function syncClientActionBar/.test(js), '行动条状态对齐函数（幂等）');
  ok(/pendingAction/.test(js) && /clientActionSeq/.test(js), '客机动作带自增序号与在途标记');
  ok(/function retryClientAction/.test(js), '动作投递失败自动重发');
  ok(/function clientWatchdog/.test(js) && /7000/.test(js), '看门狗含动作超时兜底（7 秒）');
  ok(/visibilitychange/.test(js) && /pageshow/.test(js) && /function onPageResume/.test(js), '切屏恢复已接入（visibilitychange / pageshow）');
  ok(/function kickPoll/.test(js) && /AbortController/.test(js), '可中断在途长轮询并立即重连');
  ok(/function tryRejoin/.test(js), '掉线后自动同名重新加入房间');
  ok(/seq: msg\.seq/.test(serverSrc), '服务端中继客机动作序号（主机据此幂等去重）');
  ok(/gone: true/.test(serverSrc), '服务端对已除名客户端明确回执（不再静默成功）');

  /* --- 客机行动条：轮到我 → 启用 --- */
  T.client.setMode('client', 1, '手机客机');
  T.client.setRoom('12345', 'C1');
  T.client.applySnapshot(snap({ actingIdx: 1 }));
  ok(T.client.actingIdx() === 1, '快照同步当前行动座位');
  ok(T.client.canAct() === true && !bar().classList.contains('disabled'), '轮到我行动 → 行动条启用（不再是灰态）');
  ok(T.client.tapGuard() === true, '轮到我行动 → 允许点击');

  /* --- 非我行动 → 禁用，点击被忽略 --- */
  T.client.applySnapshot(snap({ actingIdx: 0 }));
  ok(T.client.canAct() === false && bar().classList.contains('disabled'), '非我方行动 → 行动条禁用');
  ok(T.client.tapGuard() === false, '非我方行动 → 忽略按钮点击');

  /* --- 盲注位徽章：客机此前只拿 snap.blinds 算战绩、未回填本地盲注座位，
         导致座位上的 S/B 标识在客机端永远不亮 --- */
  T.debug.buildSeats();
  T.client.applySnapshot(snap({ actingIdx: 0, blinds: { sbSeat: 0, bbSeat: 1 } }));
  ok(T.blindSeats().sb === 0 && T.blindSeats().bb === 1, '客机由快照恢复盲注座位（sb=0、bb=1）');
  ok(T.players[0].seatEl && T.players[0].seatEl.classList.contains('has-sb'), '客机：S 徽章亮在小盲座位');
  ok(T.players[1].seatEl && T.players[1].seatEl.classList.contains('has-bb'), '客机：B 徽章亮在大盲座位');
  ok(!T.players[0].seatEl.classList.contains('has-bb') && !T.players[1].seatEl.classList.contains('has-sb'),
    '客机：S/B 不串座（小盲不误挂 B，大盲不误挂 S）');
  T.client.applySnapshot(snap({ actingIdx: 0, handNo: 0, blinds: { sbSeat: 0, bbSeat: 1 } }));
  ok(!T.players[0].seatEl.classList.contains('has-sb'), '客机：局间（handNo=0）S/B 收起');

  /* --- 提交动作：请求被中断（手机切屏）→ 保持在途、自动重发 --- */
  T.client.applySnapshot(snap({ actingIdx: 1 }));
  failMsg = true;
  const beforeMsg = calls.filter(c => c.url === '/api/msg').length;
  T.client.submit({ type: 'call' });
  ok(T.client.pending() && T.client.pending().seq === 1, '提交动作 → 进入在途状态（序号 1）');
  ok(bar().classList.contains('disabled'), '在途期间行动条禁用（防重复提交）');
  ok(T.client.tapGuard() === false, '在途期间忽略重复点击');
  await sleep(1200);
  ok(calls.filter(c => c.url === '/api/msg').length > beforeMsg, '投递失败后自动重发（' +
    calls.filter(c => c.url === '/api/msg').length + ' 次尝试）');

  /* --- 主机处理完成（行动座位推进）→ 在途标记清空 --- */
  failMsg = false;
  T.client.applySnapshot(snap({ actingIdx: 0 }));
  ok(T.client.pending() === null, '主机推进后清空在途标记');

  /* --- 超时兜底：动作始终未送达主机 → 自动恢复行动条 --- */
  T.client.applySnapshot(snap({ actingIdx: 1 }));
  failMsg = true;
  T.client.submit({ type: 'check' });
  const pa = T.client.pending();
  ok(!!pa, '再次提交动作进入在途状态');
  pa.at = Date.now() - 8000;             // 快进 8 秒（主机仍未推进）
  T.client.watchdog();
  ok(T.client.pending() === null, '动作长时间未送达 → 清空在途标记');
  ok(!bar().classList.contains('disabled') && T.client.canAct(), '动作长时间未送达 → 行动条恢复可操作');
  ok(String(msg().textContent).indexOf('失败') >= 0, '给出"动作发送失败，请重新选择"提示');

  /* --- 状态不一致兜底：轮到我但行动条被残留禁用 → 看门狗修复 --- */
  failMsg = false;
  T.client.clearPending();
  T.client.applySnapshot(snap({ actingIdx: 1 }));
  bar().classList.add('disabled');       // 人为制造不一致（模拟渲染异常残留）
  T.client.watchdog();
  ok(!bar().classList.contains('disabled'), '看门狗修复"轮到我但行动条灰态"的不一致状态');

  /* --- 切屏恢复：本地重放快照 + 立即重连 + 补投未确认动作 --- */
  T.client.applySnapshot(snap({ actingIdx: 1 }));
  ok(T.client.lastSnap() && T.client.lastSnap().actingIdx === 1, '保留最近快照（切屏恢复用）');
  bar().classList.add('disabled');       // 模拟切屏后界面状态错乱
  const pollsBefore = calls.filter(c => c.url.indexOf('/api/poll') === 0).length;
  global.document.hidden = false;
  T.client.reconnect();
  ok(!bar().classList.contains('disabled'), '切屏回来 → 本地重放快照，行动条立即恢复（无需等网络）');
  ok(calls.filter(c => c.url.indexOf('/api/poll') === 0).length > pollsBefore, '切屏回来 → 立即重启轮询拉取最新状态');

  failMsg = true;
  T.client.clearPending();
  T.client.submit({ type: 'call' });
  const msgBefore = calls.filter(c => c.url === '/api/msg').length;
  T.client.reconnect();
  ok(calls.filter(c => c.url === '/api/msg').length > msgBefore, '切屏回来 → 自动补投未确认的动作');
  failMsg = false;
  T.client.clearPending();

  /* --- 轮询停滞 → 主动重连 --- */
  T.client.poll.bump(60000);             // 假装 60 秒没有成功轮询
  const pollsBefore2 = calls.filter(c => c.url.indexOf('/api/poll') === 0).length;
  T.client.watchdog();
  ok(calls.filter(c => c.url.indexOf('/api/poll') === 0).length > pollsBefore2, '轮询停滞 45 秒以上 → 主动重连');

  /* --- 在途动作确认：①主机序号回执 ②局面已推进 --- */
  failMsg = false;
  T.client.applySnapshot(snap({ actingIdx: 1, street: 'preflop', currentBet: 2 }));
  T.client.submit({ type: 'call' });
  ok(!!T.client.pending(), '提交动作（局面：翻牌前、面对 2 下注）');
  T.client.applySnapshot(snap({ actingIdx: 1, street: 'preflop', currentBet: 2, actSeq: [0, T.client.pending().seq] }));
  ok(T.client.pending() === null, '主机快照带回动作序号回执 → 立即确认（即使仍轮到我）');
  T.client.submit({ type: 'check' });
  T.client.applySnapshot(snap({ actingIdx: 1, street: 'flop', currentBet: 0 }));
  ok(T.client.pending() === null, '局面已推进（进入翻牌圈）→ 确认动作已生效');
  ok(!bar().classList.contains('disabled') && T.client.canAct(), '确认后仍轮到我 → 行动条保持可用');
  ok(/actSeq: players\.map/.test(js), '主机快照带各座位已处理动作序号（actSeq）');

  /* --- 主机侧动作幂等去重（重发不重复执行） --- */
  const a1 = T.client.hostAction({ type: 'action', seat: 3, action: { type: 'call' }, seq: 7 });
  ok(a1 && a1.type === 'call', '主机执行客机动作（序号 7）');
  const a2 = T.client.hostAction({ type: 'action', seat: 3, action: { type: 'call' }, seq: 7 });
  ok(a2 === null, '同一动作重发（同序号）→ 主机忽略，不重复执行');
  const a3 = T.client.hostAction({ type: 'action', seat: 3, action: { type: 'raise', to: 6 }, seq: 8 });
  ok(a3 && a3.type === 'raise' && a3.to === 6, '序号递增的新动作正常执行');
  const a4 = T.client.hostAction({ type: 'action', seat: 4, action: { type: 'call' }, seq: 0 });
  ok(a4 && a4.type === 'call', '无序号的老客户端消息仍按原逻辑执行（兼容）');

  global.fetch = REAL_FETCH;             // 还原真实 fetch，供 E2E 使用
  return { pass, fail };
}

/* ================= 第二部分：服务器 E2E ================= */
async function startServer(port, env) {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, env || {}, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => log += d);
  srv.stderr.on('data', d => log += d);
  const base = 'http://localhost:' + port;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { await fetch(base + '/'); up = true; } catch (e) { await sleep(100); }
  }
  return { srv, base, up, log: () => log };
}

async function serverTests() {
  console.log('--- 服务器 E2E：动作回执与轮询中断 ---');
  const S = await startServer(18794, {});
  ok(S.up, '服务器启动');
  if (!S.up) { console.error(S.log()); return; }
  const BASE = S.base;
  const post = async (p, body) => (await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  const pollOnce = async (room, id, seq) => (await fetch(BASE + '/api/poll?room=' + room + '&id=' + id + '&seq=' + (seq || 0))).json();
  const SNAP = { phase: 'playing', seats: [], log: [], hist: [], exited: [] };

  const host = await post('/api/create', { name: '主机', mode: 'duel' });
  const c1 = await post('/api/join', { room: host.room, name: '手机客机' });
  ok(c1.ok, '客机加入超能力单挑房');

  /* 动作中继带序号（主机据此幂等去重） */
  await post('/api/msg', { room: host.room, id: c1.id, msg: { type: 'action', action: { type: 'call' }, seq: 5 } });
  const hb = await pollOnce(host.room, host.id, 0);
  const acts = hb.msgs.filter(x => x.type === 'action');
  ok(acts.length === 1 && acts[0].seq === 5 && acts[0].seat === c1.seat && acts[0].action.type === 'call',
    '主机收到动作中继（含座位号与序号）');

  /* 未知/已除名客户端 → 明确回执（不再静默成功；静默成功是"按钮卡灰"的根源之一） */
  const ghost = await post('/api/msg', { room: host.room, id: 'C-GHOST', msg: { type: 'action', action: { type: 'call' }, seq: 6 } });
  ok(ghost.ok === false && ghost.gone === true, '未知客户端提交动作 → 返回 gone（客户端据此自动重新加入）');

  /* 长轮询被中断（手机切屏）→ 服务器不崩溃、无残留、后续仍可正常收消息 */
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'state', snap: SNAP } });
  const cb0 = await pollOnce(host.room, c1.id, 0);   // 立即返回（箱内已有快照），记下序号
  ok(cb0.ok === true && cb0.msgs.some(x => x.type === 'state'), '客机收到主机快照');
  const ac = new AbortController();
  const held = fetch(BASE + '/api/poll?room=' + host.room + '&id=' + c1.id + '&seq=' + cb0.seq, { signal: ac.signal })
    .then(() => 'done').catch(() => 'aborted');
  await sleep(200);                                   // 无新消息 → 服务器挂起该长轮询
  ac.abort();
  ok((await held) === 'aborted', '在途长轮询可被中断（模拟手机切屏）');
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'state', snap: SNAP } });
  const after = await pollOnce(host.room, c1.id, cb0.seq);
  ok(after.ok === true && after.msgs.some(x => x.type === 'state'), '中断后服务器正常：仍能收到新快照');
  S.srv.kill();
  await sleep(150);

  /* 超时除名 → 同名重新加入（客户端 tryRejoin 走的就是这条路径） */
  console.log('--- 服务器 E2E：超时除名与自动重连 ---');
  const S2 = await startServer(18795, { MP_CLIENT_TIMEOUT: '1200', MP_SWEEP: '300' });
  ok(S2.up, '服务器启动（短超时）');
  if (!S2.up) { console.error(S2.log()); return; }
  const B2 = S2.base;
  const post2 = async (p, body) => (await fetch(B2 + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  const poll2 = async (room, id, seq) => (await fetch(B2 + '/api/poll?room=' + room + '&id=' + id + '&seq=' + (seq || 0))).json();

  const h2 = await post2('/api/create', { name: '主机', mode: 'duel' });
  const k2 = await post2('/api/join', { room: h2.room, name: '手机客机' });
  ok(k2.ok, '客机加入房间（短超时服务器）');
  await sleep(1800);   // 超过 MP_CLIENT_TIMEOUT=1200ms 未轮询
  const gone = await poll2(h2.room, k2.id, 0);
  ok(gone.ok === false && gone.closed === true, '客机超时未轮询 → 服务器除名（poll 返回 closed）');
  const leftMsg = await poll2(h2.room, h2.id, 0);
  ok(leftMsg.msgs.some(x => x.type === 'left' && x.seat === k2.seat), '主机收到该座位掉线通知（座位空出）');
  const re = await post2('/api/join', { room: h2.room, name: '手机客机' });
  ok(re.ok === true && typeof re.seat === 'number', '同名重新加入成功（自动重连路径可用）');
  const reAct = await post2('/api/msg', { room: h2.room, id: re.id, msg: { type: 'action', action: { type: 'call' }, seq: 1 } });
  ok(reAct.ok === true && !reAct.gone, '重新加入后可正常提交动作');
  const hb2 = await poll2(h2.room, h2.id, leftMsg.seq);
  ok(hb2.msgs.some(x => x.type === 'action' && x.seq === 1), '主机收到重连后客机的动作（序号 1）');

  S2.srv.kill();
  await sleep(150);
}

(async function main() {
  const ui = await uiTests();
  console.log('--- 无头 UI 小计: ' + ui.pass + ' 通过, ' + ui.fail + ' 失败 ---');
  await serverTests();
  console.log('\n=== 客机行动条健壮性测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
