/* 菜单整合 + 单机/训练退出牌局 无头测试
   1) 左上角菜单结构：买入 / 本局战绩 / 对局信息 / 历史战绩 / 退出牌局（最下方）
   2) 单机、翻前训练模式下退出牌局 → 二次确认 → 返回主菜单大厅 */
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
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.onclick = null;
    this.oninput = null;
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
global.PokerCore = require('./core.js');
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
eval(m[1]);

const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));
const T = global.window.__PokerTest;
const el = id => global.document.getElementById(id);

let pass = 0, fail = 0;
const assert = (c, msg) => { if (c) { pass++; console.log('  ok ' + msg); } else { fail++; console.error('  FAIL ' + msg); } };
const handCount = () => logLines.filter(l => /^===== 第 \d+ 局 =====$/.test(l)).length;

/* ---------- 源码级：菜单结构 ---------- */
function sliceBlock(src, startId, endMark) {
  const i = src.indexOf('id="' + startId + '"');
  if (i < 0) return '';
  const j = src.indexOf(endMark, i);
  return src.slice(i, j < 0 ? src.length : j);
}

(async function main() {
  console.log('--- 源码结构：菜单整合 ---');
  const tlBlock = sliceBlock(html, 'tl-buttons', '<div id="table-area">');
  const menuBlock = sliceBlock(html, 'menu-list', '<div id="table-area">');
  assert(/id="menu-toggle"/.test(tlBlock), '菜单按钮 #menu-toggle 位于左上角容器 #tl-buttons 内');
  assert(/id="stats-toggle"/.test(menuBlock), '历史战绩已整合进菜单');
  // 对局信息已从菜单移出（2026-10-20）：右上角固定按钮 #panel-fab
  assert(!/id="panel-toggle"/.test(menuBlock), '对局信息不再出现在菜单内（已移出）');
  assert(/id="panel-fab"/.test(html) && /#panel-fab\s*\{[^}]*position:\s*fixed/.test(html),
    '对局信息为右上角固定按钮 #panel-fab（牌局中显示）');
  assert(/id="buyin-toggle"/.test(menuBlock) && /id="session-toggle"/.test(menuBlock) &&
    /id="exit-toggle"/.test(menuBlock), '买入 / 本局战绩 / 退出牌局 已整合进菜单');
  // 顺序：买入 → 本局战绩 → 历史战绩 → 退出牌局（对局信息已移出）
  const orderIds = ['buyin-toggle', 'session-toggle', 'stats-toggle', 'exit-toggle'];
  const pos = orderIds.map(id => menuBlock.indexOf('id="' + id + '"'));
  assert(pos.every((v, i) => v > 0 && (i === 0 || v > pos[i - 1])), '菜单条目顺序为 买入→本局战绩→历史战绩→退出牌局');
  // 退出牌局是菜单内最后一个条目
  const btnIds = (menuBlock.match(/<button id="([^"]+)"/g) || [])
    .map(s => (s.match(/id="([^"]+)"/) || [])[1]);
  assert(btnIds.length === 6 && btnIds[btnIds.length - 1] === 'exit-toggle' && btnIds.indexOf('squid-toggle') === 3 && btnIds.indexOf('settings-toggle') === 4,
    '退出牌局位于菜单最下方（末位条目）');
  // 旧的固定按钮样式已移除（对局信息现为 #panel-fab，历史战绩并入菜单）
  assert(!/#panel-toggle\s*\{\s*position:\s*fixed/.test(html), '旧的 #panel-toggle 固定按钮样式已移除');
  assert(!/#stats-toggle\s*\{\s*position:\s*fixed/.test(html), '旧的历史战绩固定按钮样式已移除');
  assert(/#exit-toggle\s*\{/.test(html), '退出牌局在菜单内有独立样式（危险色）');

  console.log('--- 菜单显示与开合 ---');
  el('menu-list').classList.add('hidden'); // 对齐 HTML 初始 class（测试桩不解析 HTML）
  assert(el('tl-buttons').style.display === undefined || el('tl-buttons').style.display !== 'flex',
    '大厅阶段菜单容器不显示');
  byId['btn-start'].onclick(); // 单机开局
  await wallSleep(60);
  assert(el('tl-buttons').style.display === 'flex', '单机牌局开始后左上角菜单显示');
  assert(el('exit-toggle').style.display !== 'none', '单机模式下"退出牌局"条目可用（不再仅限联机）');
  assert(el('menu-list').classList.contains('hidden'), '菜单默认收起');
  T.toggleMenu();
  assert(!el('menu-list').classList.contains('hidden'), '点菜单按钮展开条目列');
  T.toggleMenu();
  assert(el('menu-list').classList.contains('hidden'), '再次点击收起');

  console.log('--- 单机：退出牌局 → 返回主菜单 ---');
  const h1 = handCount();
  el('exit-toggle').onclick();
  assert(!el('exit-modal').classList.contains('hidden'), '点击退出牌局弹出二次确认');
  assert((el('exit-confirm-text').textContent || '').indexOf('主菜单') >= 0, '单机确认文案提示返回主菜单');
  byId['btn-exit-no'].onclick();
  assert(el('exit-modal').classList.contains('hidden'), '取消后关闭确认框');
  await wallSleep(80);
  assert(el('overlay').classList.contains('hidden'), '取消后仍在牌局中（大厅浮层未出现）');

  const genBefore = T.handGen();
  el('exit-toggle').onclick();
  byId['btn-exit-yes'].onclick();
  assert(T.handGen() === genBefore + 1, '确认退出：牌局代际自增（作废进行中的流程）');
  assert(!el('overlay').classList.contains('hidden'), '确认退出后返回主菜单（大厅浮层显示）');
  assert(el('lobby-select').style.display === '', '主菜单的模式选择面板重新显示');
  assert(el('tl-buttons').style.display === 'none', '回到主菜单后左上角菜单隐藏');
  assert(el('train-modal').classList.contains('hidden') && el('session-modal').classList.contains('hidden') &&
    el('buyin-modal').classList.contains('hidden'), '退出时关闭所有牌局内弹窗');
  assert(T.players.every(p => !p.seatType), '退出后座位清空');
  assert(el('side-panel').classList.contains('open') === false, '退出后对局信息面板收起');

  // 牌局流程确实中止：静置后不再有新的一局
  const h2 = handCount();
  await wallSleep(400);
  assert(handCount() === h2, '退出后牌局流程中止（不再自动开新局）');

  console.log('--- 退出后可重新开局 ---');
  byId['btn-start'].onclick();
  await wallSleep(60);
  assert(!el('overlay').classList.contains('hidden') === false, '重新开局后大厅浮层收起');
  assert(el('tl-buttons').style.display === 'flex', '重新开局后菜单重新显示');
  assert(logLines.some(l => l === '===== 第 1 局 ====='), '重新开局从第 1 局开始（局号已重置）');

  console.log('--- 翻前训练：退出牌局 ---');
  el('exit-toggle').onclick();
  byId['btn-exit-yes'].onclick();
  await wallSleep(40);
  byId['btn-train'].onclick();
  await wallSleep(80);
  assert(el('exit-toggle').style.display !== 'none', '翻前训练模式下"退出牌局"条目可用');
  assert(el('stats-toggle').style.display === 'none', '训练模式隐藏历史战绩入口');
  el('exit-toggle').onclick();
  assert((el('exit-confirm-text').textContent || '').indexOf('主菜单') >= 0, '训练模式确认文案提示返回主菜单');
  byId['btn-exit-yes'].onclick();
  assert(!el('overlay').classList.contains('hidden'), '训练模式退出后返回主菜单');
  assert(el('stats-toggle').style.display === '', '回到主菜单后历史战绩入口恢复显示');
  assert(T.players.every(p => !p.seatType), '训练模式退出后座位清空');
  const h3 = handCount();
  await wallSleep(400);
  assert(handCount() === h3, '训练模式退出后不再继续出牌');

  console.log('\n共 ' + (pass + fail) + ' 项断言，通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
