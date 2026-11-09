/* test-popup-dismiss.js — "点击弹窗外部关闭"统一机制回归
   覆盖：各弹窗/侧栏点外部关闭 · 点遮罩关闭 · 点面板内部不关 · 点触发按钮不关
        刻意排除的 #train-modal / #rit-modal 保持不关
   用法：node test-popup-dismiss.js                                            */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; failures.push(msg + (extra ? '   [' + extra + ']' : '')); }
}

/* ---------- 极简 DOM stub（实现 contains：沿 parentNode 向上查找） ---------- */
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
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  /* 关键：真实浏览器的 contains 语义（含自身） */
  contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener() {}
  focus() {}
}
const byId = {};
const docListeners = [];
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(t) { return new FakeEl(t); },
  addEventListener(ev, fn, capture) { docListeners.push({ ev: ev, fn: fn, capture: !!capture }); },
  body: new FakeEl('body'), documentElement: new FakeEl('html'), hidden: false
};
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
global.PokerCore = require('./core.js');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const $ = id => document.getElementById(id);

/* ---------- 1) 源码级：机制与覆盖范围 ---------- */
ok(/const OUTSIDE_CLOSE = \[/.test(html), '源码：存在统一"点外部关闭"配置表');
const tableSeg = html.slice(html.indexOf('const OUTSIDE_CLOSE = ['), html.indexOf('function dismissOutside'));
['stats-modal', 'stats-confirm', 'session-modal', 'buyin-modal', 'squid-modal',
 'exit-modal', 'settings-modal', 'nethelp-modal', 'side-panel'].forEach(function (id) {
  ok(tableSeg.indexOf("['" + id + "'") >= 0, '配置表包含 ' + id);
});
ok(tableSeg.indexOf('train-modal') < 0 && tableSeg.indexOf('rit-modal') < 0,
  '刻意排除 #train-modal / #rit-modal（流程必经选择，隐藏会卡住）');
ok(/document\.addEventListener\('click', function \(e\) \{\s*dismissOutside\(e\.target\);[\s\S]*?\}, true\)/.test(html),
  '源码：在捕获阶段挂载（避免同一次点击刚打开就被关掉）');
ok(/chat-modal'\)\.addEventListener\('click'/.test(html), '聊天面板保留自己的遮罩处理（关闭时同步状态）');
ok(typeof T.debug.dismissOutside === 'function', '测试钩子：dismissOutside 可用');

/* ---------- 2) 行为级：各弹窗「点外部即关闭」 ----------
   注意：无头 stub 不解析 HTML，元素初始无类名 → 弹窗"已打开"= 不含 'hidden' */
const outside = new FakeEl('div');   // 面板外的一个普通元素（例如牌桌）

const MODALS = ['stats-modal', 'stats-confirm', 'session-modal', 'buyin-modal',
                'squid-modal', 'exit-modal', 'settings-modal', 'nethelp-modal'];
MODALS.forEach(function (id) {
  const el = $(id);
  el.classList.remove('hidden');                    // 打开
  T.debug.dismissOutside(outside);
  ok(el._class.has('hidden'), '弹窗 ' + id + '：点外部关闭');
});

/* 侧栏用 .open 表示展开 */
const panel = $('side-panel');
panel.classList.add('open');
T.debug.dismissOutside(outside);
ok(!panel._class.has('open'), '对局信息侧栏：点外部关闭（移除 .open）');

/* ---------- 3) 行为级：点遮罩本身关闭；点面板内部不关 ---------- */
const stats = $('stats-modal');
stats.classList.remove('hidden');
T.debug.dismissOutside(stats);                       // e.target === 遮罩元素本身
ok(stats._class.has('hidden'), '点遮罩本身 → 关闭');

stats.classList.remove('hidden');
const inner = new FakeEl('button');
inner.parentNode = stats;                            // 面板内部的按钮
T.debug.dismissOutside(inner);
ok(!stats._class.has('hidden'), '点面板内部 → 保持打开');

const innerDeep = new FakeEl('span');
const mid = new FakeEl('div'); mid.parentNode = stats; innerDeep.parentNode = mid;
T.debug.dismissOutside(innerDeep);
ok(!stats._class.has('hidden'), '点面板内部深层子元素 → 保持打开');

/* ---------- 4) 行为级：点触发按钮交给按钮自己 toggle ---------- */
panel.classList.add('open');
T.debug.dismissOutside($('panel-fab'));
ok(panel._class.has('open'), '对局信息侧栏：点右上角 #panel-fab 不关（交给 toggle，避免关掉又打开）');

stats.classList.remove('hidden');
T.debug.dismissOutside($('stats-toggle'));
ok(!stats._class.has('hidden'), '历史战绩：点菜单里的触发项不关');

const settings = $('settings-modal');
settings.classList.remove('hidden');
T.debug.dismissOutside($('settings-fab'));
ok(!settings._class.has('hidden'), '设置：点右下角悬浮按钮不关');
settings.classList.remove('hidden');
T.debug.dismissOutside($('settings-toggle'));
ok(!settings._class.has('hidden'), '设置：点菜单项不关');

/* ---------- 5) 行为级：刻意排除的两个弹窗 ---------- */
const train = $('train-modal');
train.classList.remove('hidden');
T.debug.dismissOutside(outside);
ok(!train._class.has('hidden'), '#train-modal 点外部不关（留待玩家选择下一手）');
const rit = $('rit-modal');
rit.classList.remove('hidden');
T.debug.dismissOutside(outside);
ok(!rit._class.has('hidden'), '#rit-modal 点外部不关（必须表态）');

/* ---------- 6) 行为级：未打开的面板不受影响 ---------- */
const buyin = $('buyin-modal');
buyin.classList.add('hidden');                       // 明确处于关闭态
T.debug.dismissOutside(outside);
ok(buyin._class.has('hidden'), '未打开的弹窗：调用后仍为关闭态（幂等）');

/* ---------- 7) 行为级：文档级捕获监听确实注册 ---------- */
ok(docListeners.some(l => l.ev === 'click' && l.capture === true),
  '已在 document 上以捕获阶段注册点击监听');

/* ---------- 结果 ---------- */
console.log('=== 弹窗点外部关闭测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  ✗ ' + f)); }
process.exit(fail ? 1 : 0);
