/* 无头测试：客机"游戏中加入"UI 链路（mock fetch，走真实 join/pollLoop/applySnapshot 路径）
   复现：中途加入 → 观战（按钮灰，正常）→ 下一手入座 → 轮到行动时按钮必须启用 */
'use strict';
const fs = require('fs');
const path = require('path');

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
  appendChild(ch) { ch.parentNode = this; this.children.push(ch); if (this._onChild) this._onChild(ch); return ch; }
  removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener(ev, fn) { const a = this._listeners[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  focus() {}
}

const byId = {};
const logLines = [];
global.document = {
  getElementById(id) {
    if (!byId[id]) {
      byId[id] = new FakeEl();
      if (id === 'log') byId[id]._onChild = ch => logLines.push(ch.textContent);
    }
    return byId[id];
  },
  createElement(tag) { return new FakeEl(tag); }
};
global.window = global;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { return setImmediate(fn); };

require('./core.js');
global.PokerCore = module.require('./core.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- 快照构造 ---------- */
function mkSnap(o) {
  const seats = [];
  for (let i = 0; i < 6; i++) {
    const base = {
      name: '', type: null, chips: 0, bet: 0, contrib: 0, brought: 0,
      inHand: false, allIn: false, winner: false, revealed: false,
      posName: '', offline: false, joining: false, hole: []
    };
    if (i === 0) { base.name = '主机'; base.type = 'host'; base.chips = 98; base.inHand = true; base.bet = 2; base.contrib = 2; base.posName = '按钮'; }
    if (i === 1) { base.name = 'AI1'; base.type = 'ai'; base.chips = 98; base.inHand = true; base.bet = 1; base.contrib = 1; base.posName = '小盲'; }
    if (i === 2) { base.name = 'AI2'; base.type = 'ai'; base.chips = 100; base.inHand = true; base.posName = '大盲'; }
    if (i === 4 && o.seat4) Object.assign(base, o.seat4);
    seats.push(base);
  }
  return {
    phase: 'playing', handNo: o.handNo || 2, street: 'preflop',
    board: [], collectedPot: 3, roundStartPot: 3, currentBet: (o.currentBet !== undefined ? o.currentBet : 2),
    lastRaiseSize: 2, buttonIdx: 0, actingIdx: o.actingIdx,
    blinds: { sbSeat: 1, bbSeat: 2 },
    tableMsg: '等待 <b>AI1</b> 行动',
    seats: seats,
    log: o.log || ['===== 第 2 局 ====='],
    hist: []
  };
}

/* ---------- mock fetch：按预定脚本回放 poll 消息 ---------- */
const pollScript = [];   // 每次调用 /api/poll 依次返回 {seq, msgs}
let pollCalls = 0;
global.fetch = function (url, opts) {
  const u = String(url || '');
  if (u.indexOf('/api/join') >= 0) {
    return Promise.resolve({ json: async () => ({ ok: true, room: '12345', id: 'Cabc', seat: 4, phase: 'playing' }) });
  }
  if (u.indexOf('/api/poll') >= 0) {
    const item = pollScript[pollCalls] || { seq: 999, msgs: [], closed: true };
    pollCalls++;
    return new Promise(function (resolve) {
      realSetTimeout(function () { resolve({ json: async () => Object.assign({ ok: true }, item) }); }, 200);
    });
  }
  if (u.indexOf('/api/msg') >= 0) {
    return Promise.resolve({ json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ json: async () => ({ ok: true }) });
};

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到内嵌脚本'); process.exit(1); }
const DBG = "console.log('[DBG] acting=', actingIdx, 'mySeat=', MP.mySeat, 'phase=', MP.phase, 'canAct=', clientCanAct, 'me=', !!me, 'meType=', me && me.seatType, 'meJoining=', me && me.joining);";
const probe = "if (MP.phase === 'playing' && actingIdx === MP.mySeat && me && !clientCanAct) {";
eval(m[1].replace(probe, DBG + probe));

const $ = id => document.getElementById(id);
document.getElementById('action-bar').classList.add('disabled'); // 页面静态 class="disabled"
const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));
function seatElsAll() {
  return $('table-inner').children.filter(el => /(^| )seat( |$)/.test(el.className || ''));
}
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 3000)) {
    if (fn()) return true;
    await wallSleep(40);
  }
  console.log('  [waitFor超时] ' + (label || ''));
  return false;
}

(async function main() {
  console.log('--- 阶段1：点击加入（游戏中） ---');
  $('room-input').value = '12345';
  $('nick-input').value = '迟到者';
  // 预排 poll 响应：先快照A（joining 观战），再快照B（仍观战），再快照C（轮到本人）
  pollScript.push({ seq: 1, msgs: [{ type: 'state', snap: mkSnap({
    seat4: { name: '迟到者', type: 'client', chips: 100, brought: 100, joining: true },
    actingIdx: 1, currentBet: 2
  }) }] });
  pollScript.push({ seq: 2, msgs: [{ type: 'state', snap: mkSnap({
    seat4: { name: '迟到者', type: 'client', chips: 100, brought: 100, joining: true },
    actingIdx: 2, currentBet: 2
  }) }] });
  pollScript.push({ seq: 3, msgs: [{ type: 'state', snap: mkSnap({
    seat4: { name: '迟到者', type: 'client', chips: 98, brought: 100, joining: false, inHand: true, bet: 2, contrib: 2, posName: '大盲', hole: [{ r: 9, s: 3, id: 39 }, { r: 9, s: 1, id: 37 }] },
    actingIdx: 4, currentBet: 2, handNo: 3
  }) }] });
  pollScript.push({ seq: 4, msgs: [] }); // 提交动作后的空轮
  pollScript.push({ seq: 5, msgs: [{ type: 'state', snap: mkSnap({
    seat4: { name: '迟到者', type: 'client', chips: 98, brought: 100, joining: false, inHand: true, bet: 0, contrib: 2, posName: '大盲' },
    actingIdx: 4, currentBet: 0, handNo: 3
  }) }] });
  pollScript.push({ seq: 6, msgs: [{ type: 'state', snap: mkSnap({
    seat4: { name: '迟到者', type: 'client', chips: 98, brought: 100, joining: false, inHand: true },
    actingIdx: 0, currentBet: 2, handNo: 3
  }) }] });

  $('btn-join').onclick();
  await waitFor(() => $('overlay').classList.contains('hidden'), 3000, '进入牌桌');
  await waitFor(() => seatElsAll().some(el => (el.querySelector('.name') || {}).innerHTML.indexOf('迟到者') >= 0), 3000, '座位渲染');

  ok($('overlay').classList.contains('hidden'), '加入后进入牌桌（overlay 已隐藏）');
  const seatEls = seatElsAll();
  ok(seatEls.length === 8, '座位已渲染 8 个（联机 8 人桌，2026-10-14 WPT 版式 9→8）');
  const mySeat = seatEls.find(el => (el.querySelector('.name') || {}).innerHTML.indexOf('迟到者') >= 0);
  ok(!!mySeat, '座位上显示迟到者名字');
  ok(mySeat && mySeat.querySelector('.think').textContent === '下一手加入', '迟到者座位显示"下一手加入"');
  ok($('action-bar').classList.contains('disabled'), '观战期行动条为灰态（正常）');

  console.log('--- 阶段2：下一手开始，迟到者被要求行动 ---');
  await waitFor(() => mySeat.querySelector('.think').textContent === '轮到你行动', 3000, '轮到你行动');

  ok(mySeat && mySeat.querySelector('.think').textContent === '轮到你行动', '座位提示切换为"轮到你行动"');
  ok(!$('action-bar').classList.contains('disabled'), '★ 轮到本人行动时行动条已启用');
  ok($('btn-check').textContent === '过牌', '无需跟注时按钮显示过牌（大盲位）');

  console.log('--- 阶段3：提交动作后灰态，翻牌圈再次亮起 ---');
  $('btn-check').onclick();
  const t0 = Date.now();
  await wallSleep(30);
  ok($('action-bar').classList.contains('disabled'), '提交后行动条回到灰态');

  await waitFor(() => {
    const st = 't=' + (Date.now() - t0) + ' bar=' + $('action-bar').classList.contains('disabled') + ' chk=[' + $('btn-check').textContent + ']';
    if (!globalThis.__seen) globalThis.__seen = {};
    if (!globalThis.__seen[st]) { globalThis.__seen[st] = 1; console.log('  [状态] ' + st); }
    return !$('action-bar').classList.contains('disabled') && $('btn-check').textContent.indexOf('过牌') === 0;
  }, 3000, '第二次启用');
  ok(!$('action-bar').classList.contains('disabled'), '第二次行动时行动条再次启用');
  ok($('btn-check').textContent === '过牌', '无需跟注时显示过牌');

  await waitFor(() => $('action-bar').classList.contains('disabled'), 3000, '他人行动灰态');
  ok($('action-bar').classList.contains('disabled'), '轮到他人时行动条保持灰态');

  console.log('\n=== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
