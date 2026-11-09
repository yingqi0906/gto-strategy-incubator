/* 加入房间重复校验测试
   背景：弱网下连点"加入房间"会发出多个 /api/join 请求，导致同一玩家在房间内被重复分配座位。
   1) 无头 UI：请求进行中忽略重复点击（只发一包）、超时后释放按钮、携带加入令牌、自动重连复用令牌
   2) 服务器 E2E：同一令牌重复加入 → 同一 id/座位且主机只收到一次 joined；
      不同令牌（另一个人/另一浏览器）→ 独立座位；被踢出后同一令牌不得再进（踢人生效） */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REAL_FETCH = global.fetch;   // UI 测试会替换 fetch 桩，E2E 前必须还原

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
  removeEventListener() {}
  setAttribute() {}
  focus() {}
  blur() {}
}

/* ================= 第一部分：无头 UI ================= */
async function uiTests() {
  console.log('--- 无头 UI：加入重复校验 ---');
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
  global.alert = function () {};
  const sessionStore = {};
  global.sessionStorage = { getItem: k => (k in sessionStore ? sessionStore[k] : null), setItem: (k, v) => { sessionStore[k] = String(v); } };
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  global.PokerCore = require('./core.js');

  /* fetch 桩：统计请求；/api/join 由测试控制何时返回（模拟弱网延迟） */
  const calls = [];
  let joinResolvers = [];
  let joinMode = 'pending'; // pending（挂起，模拟弱网）| ok
  global.fetch = function (url, opt) {
    const u = String(url);
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    calls.push({ url: u, body: body });
    if (u.indexOf('/api/join') === 0) {
      if (joinMode === 'pending') return new Promise(function (res) { joinResolvers.push(function (d) { res({ json: () => Promise.resolve(d) }); }); });
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, room: '12345', id: 'C1', seat: 1, phase: 'lobby', duel: false }) });
    }
    if (u.indexOf('/api/poll') === 0) return new Promise(function () {}); // 长轮询挂起
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };

  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

  /* ---------- 源码级 ---------- */
  ok(html.includes('if (joinInFlight) return; // 请求中：忽略重复点击（弱网连点只发一包）'), '加入/创建请求进行中忽略重复点击');
  ok(html.includes("mpApi('/api/join', { room: code, name: nick, token: joinToken() }, 12000)"), '加入房间携带令牌并带 12 秒超时');
  ok(html.includes('token: joinToken()') && html.includes("mpApi('/api/join', { room: MP.room, name: MP.name, token: joinToken() })"),
    '自动重连（tryRejoin）同样复用令牌');
  ok(html.includes("sessionStorage.getItem(k)"), '令牌持久化在 sessionStorage（刷新后仍是同一玩家）');
  ok(!/mpApi\('\/api\/join', \{ room: code, name: nick \}\)/.test(html), '旧的"无令牌加入"调用已移除');

  /* ---------- 行为级：连点只发一包 ---------- */
  const joinBtn = global.document.getElementById('btn-join');
  global.document.getElementById('room-input').value = '12345';
  global.document.getElementById('nick-input').value = '连点玩家';
  const before = calls.filter(c => c.url.indexOf('/api/join') === 0).length;

  joinBtn.onclick();
  joinBtn.onclick(); // 弱网连点
  joinBtn.onclick();
  await sleep(20);
  const joinCalls = calls.filter(c => c.url.indexOf('/api/join') === 0);
  ok(joinCalls.length === before + 1, '弱网下连点"加入房间"只发出 1 个请求（防重入）');
  ok(joinBtn.disabled === true, '请求进行中按钮置灰，避免误触');
  ok(joinCalls[0].body.token && String(joinCalls[0].body.token).length > 4, '请求携带加入令牌');

  /* 失败返回：释放防重入，允许重试 */
  joinResolvers.forEach(fn => fn({ ok: false, err: '房间不存在' }));
  await sleep(20);
  ok(joinBtn.disabled === false, '请求失败后按钮恢复可点（可重试）');
  joinBtn.onclick();
  await sleep(20);
  const joinCalls2 = calls.filter(c => c.url.indexOf('/api/join') === 0);
  ok(joinCalls2.length === before + 2, '失败后可再次发起加入');
  ok(joinCalls2[1].body.token === joinCalls2[0].body.token, '同一标签页重试复用同一令牌（服务端据此去重）');
  joinResolvers.forEach(fn => fn({ ok: true, room: '12345', id: 'C1', seat: 1, phase: 'lobby', duel: false }));
  await sleep(20);
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
  console.log('--- 服务器 E2E：加入幂等去重 ---');
  global.fetch = REAL_FETCH; // 还原真实 fetch（UI 桩仅用于 UI 部分）
  const S = await startServer(18797, {});
  ok(S.up, '服务器启动');
  if (!S.up) { console.error(S.log()); return; }
  const BASE = S.base;
  const post = async (p, body) => (await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  const pollOnce = async (room, id, seq) => (await fetch(BASE + '/api/poll?room=' + room + '&id=' + id + '&seq=' + (seq || 0))).json();

  const host = await post('/api/create', { name: '主机', mode: 'multi' });
  ok(host.ok === true, '创建房间');

  /* ① 同一令牌连续加入 3 次（模拟弱网连点/重试/刷新重进） */
  const j1 = await post('/api/join', { room: host.room, name: '连点玩家', token: 'TK-SAME' });
  const j2 = await post('/api/join', { room: host.room, name: '连点玩家', token: 'TK-SAME' });
  const j3 = await post('/api/join', { room: host.room, name: '连点玩家', token: 'TK-SAME' });
  ok(j1.ok && j2.ok && j3.ok, '同一令牌重复加入均返回成功');
  ok(j2.id === j1.id && j3.id === j1.id, '同一令牌重复加入返回同一客户端 id（不再新建）');
  ok(j2.seat === j1.seat && j3.seat === j1.seat, '同一令牌重复加入返回同一座位（不再占新座位）');
  ok(j2.rejoin === true && j3.rejoin === true, '重复加入标记为 rejoin（客户端据此复用身份）');

  const hb = await pollOnce(host.room, host.id, 0);
  const joinedMsgs = hb.msgs.filter(x => x.type === 'joined');
  ok(joinedMsgs.length === 1 && joinedMsgs[0].seat === j1.seat, '主机只收到 1 条 joined（不会出现同一玩家多次入座）');

  /* ② 并发同时加入（极端弱网：多个请求几乎同时到达） */
  const burst = await Promise.all([
    post('/api/join', { room: host.room, name: '并发玩家', token: 'TK-BURST' }),
    post('/api/join', { room: host.room, name: '并发玩家', token: 'TK-BURST' }),
    post('/api/join', { room: host.room, name: '并发玩家', token: 'TK-BURST' })
  ]);
  ok(burst.every(x => x.ok && x.id === burst[0].id && x.seat === burst[0].seat),
    '并发重复加入也只产生 1 个客户端/1 个座位');
  const hb2 = await pollOnce(host.room, host.id, hb.seq);
  ok(hb2.msgs.filter(x => x.type === 'joined').length === 1, '并发重复加入只向主机推送 1 条 joined');

  /* ③ 不同令牌（另一个人/另一台设备）→ 独立座位，不被误合并 */
  const other = await post('/api/join', { room: host.room, name: '连点玩家', token: 'TK-OTHER' });
  ok(other.ok && other.id !== j1.id && other.seat !== j1.seat, '不同令牌的同名玩家获得独立座位（不做同名合并）');

  /* ④ 换名（同一浏览器改名）仍复用原座位 */
  const ren = await post('/api/join', { room: host.room, name: '改名后', token: 'TK-SAME' });
  ok(ren.id === j1.id && ren.seat === j1.seat, '同一令牌改名后仍复用原座位（身份按浏览器而非昵称）');

  /* ⑤ 被主机踢出后：同一令牌不得再进（踢人生效，不会"踢了又回来"）；
     但座位已释放，换一台设备（新令牌）可正常入座，不留幽灵座位 */
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'kick', seat: j1.seat } });
  await sleep(50);
  const re = await post('/api/join', { room: host.room, name: '连点玩家', token: 'TK-SAME' });
  ok(re.ok === false && re.kicked === true, '被踢出后同一令牌重新加入被拒绝（踢人有效，不会"踢了又回来"）');
  const re2 = await post('/api/join', { room: host.room, name: '另一台设备', token: 'TK-NEW' });
  ok(re2.ok && typeof re2.seat === 'number', '被踢者释放的座位可被其他设备正常使用（不留幽灵座位）');
  const hb3 = await pollOnce(host.room, host.id, hb2.seq);
  ok(hb3.msgs.some(x => x.type === 'joined' && x.seat === re2.seat), '重新加入正常通知主机 joined');
  ok(hb3.msgs.some(x => x.type === 'left' && x.seat === j1.seat),
    '主机同时收到被踢者座位释放通知（本地座位不残留，新玩家才落得下）');

  /* ⑥ 无令牌的老式加入（兼容）→ 正常分配 */
  const legacy = await post('/api/join', { room: host.room, name: '旧客户端' });
  ok(legacy.ok === true && legacy.seat >= 0, '不带令牌的加入请求保持兼容（正常分配座位）');

  S.srv.kill();
}

(async function main() {
  const ui = await uiTests();
  console.log('--- 无头 UI 小计: ' + ui.pass + ' 通过, ' + ui.fail + ' 失败 ---');
  await serverTests();
  console.log('\n=== 加入去重测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
