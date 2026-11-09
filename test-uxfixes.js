/* test-uxfixes.js — 2026-10-11 三个体验修复回归
   ① 聊天按钮可拖动（位置记忆 / 拖动与点击区分 / 手机竖屏默认位避让手牌）
   ② 客机"等待 AI 行动"卡死防御：硬计时器 Worker（后台不被节流）
      + 客机快照保鲜心跳（sync_req）+ 主机轮询停滞看门狗
   ③ 鱿鱼游戏：牌桌中间"剩余未发放标记数"（🦑 ×n）
   用法：node test-uxfixes.js */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; failures.push(msg + (extra ? '   [' + extra + ']' : '')); }
}

/* ---------- 极简 DOM stub（与 harness.js 同源，但 addEventListener 记录监听） ---------- */
class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div';
    this.children = [];
    this._class = new Set();
    this.style = {};
    this.parentNode = null;
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.value = '';
    this.min = ''; this.max = ''; this.step = '';
    this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null;
    this._qs = {}; this._listeners = {};
  }
  get classList() {
    const s = this;
    return {
      add: c => s._class.add(c),
      remove: c => s._class.delete(c),
      toggle: (c, f) => { if (f === undefined) { s._class.has(c) ? s._class.delete(c) : s._class.add(c); } else if (f) s._class.add(c); else s._class.delete(c); },
      contains: c => s._class.has(c)
    };
  }
  appendChild(ch) { ch.parentNode = this; this.children.push(ch); return ch; }
  removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener(ev, fn) { const a = this._listeners[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  fire(ev, arg) { (this._listeners[ev] || []).forEach(fn => fn(arg || {})); }
  focus() {}
}
const byId = {};
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(t) { return new FakeEl(t); },
  addEventListener() {},
  body: new FakeEl('body'), documentElement: new FakeEl('html'), hidden: false
};
global.window = global;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { return setImmediate(fn); };

require('./core.js');
global.PokerCore = module.require('./core.js');

const file = path.join(__dirname, 'gto策略培养皿.html');
const html = fs.readFileSync(file, 'utf8');
const sm = html.match(/<script>([\s\S]*?)<\/script>/);
if (!sm) { console.error('未找到内嵌脚本'); process.exit(1); }
eval(sm[1]);

const $ = id => byId[id];
const tick = (ms) => new Promise(r => realSetTimeout(r, ms || 0));

/* fetch 桩：/api/poll 挂起（避免轮询热循环），/api/msg 记录 POST 内容 */
const posts = []; let pollCalls = 0;
global.fetch = function (url, init) {
  if (String(url).indexOf('/api/poll') === 0) { pollCalls++; return new Promise(function () {}); }
  let body = {};
  try { body = JSON.parse(init.body); } catch (e) {}
  posts.push({ url: String(url), body: body });
  return Promise.resolve({ json: function () { return Promise.resolve({ ok: true }); } });
};

(async function main() {
  const T = window.__PokerTest;

  /* ================= 1) 静态检查 ================= */
  ok(/#chat-toggle\s*\{[^}]*touch-action:\s*none/.test(html), 'CSS：聊天按钮 touch-action:none（拖动不滚动页面）');
  ok(/@media \(max-width:\s*820px\) and \(orientation: portrait\)\s*\{[^@]*?#chat-toggle\s*\{[^}]*right:\s*12px/.test(html),
    'CSS：手机竖屏默认位改到右下（不再压住左下手牌）');
  ok(html.indexOf('id="squid-left"') >= 0, 'HTML：牌桌中间有 #squid-left 容器');
  ok(html.indexOf('#squid-left.show') >= 0, 'CSS：#squid-left 显隐样式就位');
  ok(/let hardWorker = null;/.test(html) && /function hardSetTimeout\(/.test(html), '硬计时器基础设施就位');
  ok(/sync_req/.test(html), '快照保鲜心跳（sync_req）就位');

  /* ================= 2) 硬计时器 ================= */
  {
    // 还原真实 setTimeout：harness 桩会把所有延时变 setImmediate（立即执行），测不了时序
    const stubST = global.setTimeout;
    global.setTimeout = realSetTimeout;
    try {
      let fired = 0;
      T.debug.hardTimer.set(function () { fired++; }, 20);
      await tick(120);
      ok(fired === 1, '硬计时器：到点触发（回退路径）', 'fired=' + fired);

      let cancelled = 0;
      const id = T.debug.hardTimer.set(function () { cancelled++; }, 20);
      T.debug.hardTimer.clear(id);
      await tick(120);
      ok(cancelled === 0, '硬计时器：clear 后不再触发', 'cancelled=' + cancelled);

      const t0 = Date.now();
      await T.debug.hardTimer.sleep(30);
      ok(Date.now() - t0 >= 25, '硬计时器：hardSleep 等待真实时长');
    } finally { global.setTimeout = stubST; }
    ok(T.debug.hardTimer.worker() === false, 'Node 测试环境：Worker 不可用自动回退 setTimeout');
  }

  /* ================= 3) 聊天按钮拖动 ================= */
  const fab = $('chat-toggle');
  ok(fab._listeners['pointerdown'] && fab._listeners['pointerdown'].length >= 1, '聊天按钮：已注册 pointerdown 监听');

  // 3a 点击（未拖动）→ 打开聊天
  const chatModal = $('chat-modal');
  const wasHidden = chatModal.classList.contains('hidden');
  fab.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'touch' });
  fab.fire('pointerup', { pointerId: 1, type: 'pointerup' });
  fab.onclick();
  ok(wasHidden !== chatModal.classList.contains('hidden'), '聊天按钮：未拖动时点击正常打开聊天');
  if (!chatModal.classList.contains('hidden')) chatModal.classList.add('hidden'); // 复位

  // 3b 拖动 → 位置变化，随后的一次 click 被拦截
  fab.fire('pointerdown', { pointerId: 2, clientX: 100, clientY: 100, pointerType: 'touch' });
  fab.fire('pointermove', { pointerId: 2, clientX: 160, clientY: 140 });
  fab.fire('pointerup', { pointerId: 2, type: 'pointerup' });
  ok(fab.style.left === '60px' && fab.style.top === '40px',
    '聊天按钮：拖动后写入新位置（left/top 内联）', fab.style.left + ',' + fab.style.top);
  ok(fab.style.right === 'auto' && fab.style.bottom === 'auto', '聊天按钮：拖动后解除右下锚定');
  const hiddenBefore = chatModal.classList.contains('hidden');
  fab.onclick(); // 拖动结束后的 click 应被吞掉
  ok(chatModal.classList.contains('hidden') === hiddenBefore, '聊天按钮：拖动后的 click 不打开聊天');
  fab.onclick(); // 第二次点击才是真点击
  ok(chatModal.classList.contains('hidden') !== hiddenBefore, '聊天按钮：拖动后下一次点击仍可正常打开');
  if (!chatModal.classList.contains('hidden')) chatModal.classList.add('hidden');

  // 3c 小位移（<6px 抖动）不算拖动
  fab.fire('pointerdown', { pointerId: 3, clientX: 100, clientY: 100, pointerType: 'touch' });
  fab.fire('pointermove', { pointerId: 3, clientX: 103, clientY: 102 });
  fab.fire('pointerup', { pointerId: 3, type: 'pointerup' });
  ok(fab.style.left === '60px' && fab.style.top === '40px', '聊天按钮：6px 内抖动不改变位置');
  const hiddenBefore2 = chatModal.classList.contains('hidden');
  fab.onclick();
  ok(chatModal.classList.contains('hidden') !== hiddenBefore2, '聊天按钮：抖动后的点击仍打开聊天');
  if (!chatModal.classList.contains('hidden')) chatModal.classList.add('hidden');

  // 3d pointercancel（滚动接管）：位置保留、不吞下一次点击
  fab.fire('pointerdown', { pointerId: 4, clientX: 100, clientY: 100, pointerType: 'touch' });
  fab.fire('pointermove', { pointerId: 4, clientX: 180, clientY: 120 });
  fab.fire('pointercancel', { pointerId: 4, type: 'pointercancel' });
  ok(fab.style.left === '80px', '聊天按钮：pointercancel 保留已拖动位置', fab.style.left);
  const hiddenBefore3 = chatModal.classList.contains('hidden');
  fab.onclick();
  ok(chatModal.classList.contains('hidden') !== hiddenBefore3, '聊天按钮：cancel 后不吞点击');
  if (!chatModal.classList.contains('hidden')) chatModal.classList.add('hidden');

  // 3e 位置钳制：不拖出视口
  fab.fire('pointerdown', { pointerId: 5, clientX: 500, clientY: 500, pointerType: 'touch' });
  fab.fire('pointermove', { pointerId: 5, clientX: -2000, clientY: -2000 });
  fab.fire('pointerup', { pointerId: 5, type: 'pointerup' });
  ok(parseFloat(fab.style.left) === 4 && parseFloat(fab.style.top) === 4,
    '聊天按钮：拖出屏幕被钳制在视口内（4px 边距）', fab.style.left + ',' + fab.style.top);

  /* ================= 4) 鱿鱼游戏：牌桌中间剩余标记数 ================= */
  {
    const sq = $('squid-left');
    // 座位：0 主机 / 1、2 AI，其余空位。
    // 注意：脚本加载时会预布 6 个默认 AI 座位，applySnapshot 会跳过 null 条目 ——
    // 空座位必须用 {type:null} 显式清空，不能传 null
    const EMPTY = function () { return { name: '', type: null, chips: 0, bet: 0, inHand: false, hole: [] }; };
    T.client.setMode('client', 3, '观察者');
    T.client.applySnapshot({
      phase: 'playing', handNo: 1, actingIdx: 0,
      seats: [
        { name: '甲', type: 'host', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-1', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-2', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        EMPTY(), EMPTY(), EMPTY(), EMPTY(), EMPTY(), EMPTY()
      ],
      log: [], hist: [],
      squid: { active: true, price: 5, pendingStart: false, markers: [false, false, false, false, false, false] }
    });
    ok(sq.classList.contains('show'), '鱿鱼：游戏中显示剩余标记数');
    ok(sq.querySelector('b').textContent === '×2', '鱿鱼：3 人在座 → ×2（人数 - 1，最后一人注定无标记）', sq.querySelector('b').textContent);
    // 模拟快照：AI-1 拿到标记 → ×1
    T.client.applySnapshot({
      phase: 'playing', handNo: 1, actingIdx: 0,
      seats: [
        { name: '甲', type: 'host', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-1', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-2', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        EMPTY(), EMPTY(), EMPTY(), EMPTY(), EMPTY(), EMPTY()
      ],
      log: [], hist: [],
      squid: { active: true, price: 5, pendingStart: false, markers: [false, true, false, false, false, false] }
    });
    ok(sq.querySelector('b').textContent === '×1', '鱿鱼：1 人拿到标记 → ×1（还差 1 个标记定出输家）', sq.querySelector('b').textContent);
    // 游戏结束（active=false）→ 隐藏
    T.client.applySnapshot({
      phase: 'playing', handNo: 1, actingIdx: 0,
      seats: [
        { name: '甲', type: 'host', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-1', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-2', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        EMPTY(), EMPTY(), EMPTY(), EMPTY(), EMPTY(), EMPTY()
      ],
      log: [], hist: [],
      squid: { active: false, price: 5, pendingStart: false, markers: [false, false, false, false, false, false] }
    });
    ok(!sq.classList.contains('show'), '鱿鱼：非游戏中隐藏剩余标记数');
  }

  /* ================= 5) 快照保鲜心跳（sync_req） ================= */
  {
    posts.length = 0;
    // 客机视角：轮到我以外的人在行动，6 秒没收到任何快照 → 向主机索要
    T.client.setMode('client', 3, '观察者');
    T.client.setRoom('10086', 'CTEST');
    T.client.applySnapshot({
      phase: 'playing', handNo: 1, actingIdx: 0,
      seats: [
        { name: '甲', type: 'host', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-1', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-2', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: '观察者', type: 'client', chips: 100, bet: 0, inHand: true, hole: [] },
        null, null, null, null, null
      ],
      log: [], hist: []
    });
    T.client.poll.bump(0);          // 轮询健康（防止触发改走 kickPoll 分支）
    T.client.snapAge(7000);         // 7 秒没收到快照
    T.client.syncReqAge(99000);     // 从未发过心跳
    T.client.watchdog();
    const hb = posts.filter(p => p.body.msg && p.body.msg.type === 'action' &&
      p.body.msg.action && p.body.msg.action.type === 'sync_req');
    ok(hb.length === 1, '心跳：快照停滞 6s+ 时向主机发送 sync_req', 'count=' + hb.length);
    T.client.snapAge(7000);         // 依旧停滞
    T.client.watchdog();
    const hb2 = posts.filter(p => p.body.msg && p.body.msg.type === 'action' &&
      p.body.msg.action && p.body.msg.action.type === 'sync_req');
    ok(hb2.length === 1, '心跳：5 秒节流内不重复发送', 'count=' + hb2.length);
    // 轮到自己时不发心跳
    T.client.snapAge(7000);
    T.client.syncReqAge(99000);
    T.client.applySnapshot({
      phase: 'playing', handNo: 1, actingIdx: 3, // 轮到观察者
      seats: [
        { name: '甲', type: 'host', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-1', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: 'AI-2', type: 'ai', chips: 100, bet: 0, inHand: true, hole: [] },
        { name: '观察者', type: 'client', chips: 100, bet: 0, inHand: true, hole: [] },
        null, null, null, null, null
      ],
      log: [], hist: []
    });
    T.client.clearPending();
    T.client.snapAge(7000);
    T.client.syncReqAge(99000);
    posts.length = 0;
    T.client.watchdog();
    const hb3 = posts.filter(p => p.body.msg && p.body.msg.type === 'action' &&
      p.body.msg.action && p.body.msg.action.type === 'sync_req');
    ok(hb3.length === 0, '心跳：轮到自己行动时不发送 sync_req', 'count=' + hb3.length);
  }

  /* ================= 6) 主机响应 sync_req → 补发快照（1.5s 节流） ================= */
  {
    posts.length = 0;
    T.mp.setIdentity('host', '10086', 'HTEST', 0, '主机');
    T.mp.setPhase('playing');
    T.mp.hostOnMsg({ type: 'action', seat: 3, action: { type: 'sync_req' } });
    const snapPosts = posts.filter(p => p.body.msg && p.body.msg.type === 'state');
    ok(snapPosts.length === 1, '主机：收到 sync_req 立即补发最新快照', 'count=' + snapPosts.length);
    posts.length = 0;
    T.mp.hostOnMsg({ type: 'action', seat: 3, action: { type: 'sync_req' } });
    ok(posts.filter(p => p.body.msg && p.body.msg.type === 'state').length === 0,
      '主机：1.5 秒节流内不重复广播');
  }

  /* ================= 7) 主机轮询停滞看门狗 ================= */
  {
    pollCalls = 0;
    T.mp.setIdentity('host', '10086', 'HTEST', 0, '主机');
    T.mp.setPhase('playing');
    T.client.poll.bump(46000);      // 46 秒没有成功轮询
    T.client.watchdog();
    ok(pollCalls >= 1, '看门狗：主机长轮询停滞 45s+ 自动重连', 'pollCalls=' + pollCalls);
    T.client.poll.bump(0);
  }

  /* ================= 结果 ================= */
  console.log('=== 体验修复测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  if (failures.length) {
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
