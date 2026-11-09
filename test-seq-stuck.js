/* 回归：客机刷新/重进后动作序号错位 → 弃牌被主机去重丢弃 → "等待 XX 行动" 卡死
   修复：applySnapshot 用快照 actSeq 抬升本地 clientActionSeq */
'use strict';
const path = require('path');
const fs = require('fs');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div'; this.children = []; this._class = new Set();
    this.style = {}; this.parentNode = null; this.textContent = '';
    this._innerHTML = ''; this.disabled = false; this.value = '';
    this.min = 0; this.max = 0; this.step = 1;
    this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null;
    this._qs = {}; this._listeners = {};
  }
  get classList() {
    const s = this;
    return {
      add: c => s._class.add(c), remove: c => s._class.delete(c),
      toggle: (c, f) => {
        if (f === undefined) { s._class.has(c) ? s._class.delete(c) : s._class.add(c); }
        else if (f) s._class.add(c); else s._class.delete(c);
      },
      contains: c => s._class.has(c)
    };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  querySelectorAll() { return []; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener() {} focus() {}
  getBoundingClientRect() { return { width: 100, height: 100, top: 0, left: 0 }; }
}
const byId = {};
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(tag) { return new FakeEl(tag); },
  addEventListener() {}, body: new FakeEl('body'), documentElement: new FakeEl('html')
};
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
global.PokerCore = require('./core.js');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

console.log('--- 源码级断言 ---');
ok(/snap\.actSeq\[MP\.mySeat\] > clientActionSeq/.test(script) &&
   /clientActionSeq = snap\.actSeq\[MP\.mySeat\]/.test(script),
  'applySnapshot 含 actSeq 抬升 clientActionSeq 的修复逻辑');
ok(/setSeq: function/.test(script), '__PokerTest 提供 setSeq 测试钩子');

eval(script);
const T = global.window.__PokerTest;
const C = T.client;

(async function main() {
  console.log('--- 功能级断言 ---');

  // ① 模拟主机已处理过该座位 seq=5 的动作（上一手遗留）
  const gotOld = C.hostAction({ type: 'action', seat: 1, action: { type: 'check' }, seq: 5 });
  ok(!!gotOld && C.hostSeq(1) === 5, '主机 lastRemoteSeq[1] 抬到 5（模拟上一手已处理）');

  // ② 修复前行为验证：刷新后 clientActionSeq 归零，seq=1 的动作会被主机丢弃
  C.setSeq(0); // 模拟刷新
  const dropped = C.hostAction({ type: 'action', seat: 1, action: { type: 'fold' }, seq: 1 });
  ok(dropped === null, '刷新后 seq=1 的动作确实被主机去重丢弃（复现卡死根源）');
  ok(C.hostSeq(1) === 5, '被丢弃的动作不推进主机序号');

  // ③ 修复验证：客机收到快照（actSeq[1]=5）→ 本地序号抬升到 5
  //    构造最小快照：借用 buildSnapshot 需要主机环境，这里手工构造
  T.client.setMode('client', 1, '幸运小李');
  T.players[1].seatType = 'client'; T.players[1].name = '幸运小李'; T.players[1].inHand = true;
  T.players[1].chips = 100; T.players[1].hole = [];
  const snap = {
    phase: 'playing', handNo: 3, street: 'flop', actingIdx: 2, currentBet: 2,
    seats: T.players.map(function (p) {
      return { name: p.name, type: p.seatType, chips: p.chips, bet: 0, inHand: p.inHand,
        allIn: false, winner: false, revealed: false, hole: p.hole };
    }),
    log: [], hist: [], exited: [], actSeq: [0, 5, 0, 0, 0, 0],
    tableMsg: '等待 <b>AI2</b> 行动'
  };
  T.applySnapshot2 = T.client.applySnapshot;
  T.applySnapshot2(snap);
  ok(C.seq() === 5, '快照 actSeq=5 → 客机 clientActionSeq 抬升到 5（修复生效）');

  // ④ 抬升后再提交的动作 seq=6 > 5 → 主机正常接受
  const got = C.hostAction({ type: 'action', seat: 1, action: { type: 'fold' }, seq: 6 });
  ok(!!got && got.type === 'fold', '抬升后提交的动作 seq=6 被主机正常执行（不再误杀）');
  ok(C.hostSeq(1) === 6, '主机序号推进到 6');

  // ⑤ 幂等回归：正常未刷新场景不受影响（本地序号高于主机 → 不回退）
  C.setSeq(10);
  const snap2 = Object.assign({}, snap, { actSeq: [0, 5, 0, 0, 0, 0] });
  T.applySnapshot2(snap2);
  ok(C.seq() === 10, '本地序号(10)高于主机(5)时不回退（正常重试场景不受影响）');

  console.log('');
  console.log('结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); console.error(e.stack); process.exit(1); });
