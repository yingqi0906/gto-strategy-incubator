/* 无头测试：stub DOM，加载 index.html 内嵌的游戏控制器，
   玩家每手尽快弃牌，统计每手牌走到哪条街，检测卡死。 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 极简 DOM stub ---------- */
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
    this.min = '';
    this.max = '';
    this.step = '';
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
  removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); ch.parentNode = null; return ch; }
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
/* 加速游戏内的延时（AI 思考、发牌动画） */
global.setTimeout = function (fn) { return setImmediate(fn); };

/* ---------- 加载核心与控制器 ---------- */
require('./core.js');
global.PokerCore = module.require('./core.js'); // core.js 在 require 下导出到 module.exports，浏览器下挂到 window
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到内嵌脚本'); process.exit(1); }
eval(m[1]);

const $ = id => byId[id];
const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));

(async function main() {
  const HANDS = parseInt(process.argv[2] || '60', 10);
  const stats = { hands: 0, streets: { preflop: 0, flop: 0, turn: 0, river: 0, showdown: 0, foldwin: 0 }, aiActions: {}, hangs: 0 };
  let handLogs = [];
  let handStart = 0;
  const handResults = [];

  function analyzeHand(lines) {
    const r = { flop: false, turn: false, river: false, showdown: false, foldwin: false, actions: [] };
    for (const l of lines) {
      if (l.indexOf('--- 翻牌 ---') >= 0) r.flop = true;
      if (l.indexOf('--- 转牌 ---') >= 0) r.turn = true;
      if (l.indexOf('--- 河牌 ---') >= 0) r.river = true;
      if (l.indexOf('全部弃牌') >= 0) r.foldwin = true;
      r.showdown = r.river && !r.foldwin;
      const mm = l.match(/^(.+?)：(.+)$/);
      if (mm) r.actions.push(mm[2]);
    }
    return r;
  }

  byId['btn-start'].onclick(); // 开始第一局（之后自动续局）
  let lastProgress = Date.now();
  let lastSeen = -1;
  let buf = [];

  let savedShowdown = null;
  const allLines = [];

  function record(res) {
    handResults.push(res);
    stats.hands++;
    if (res.river && res.showdown && !savedShowdown) savedShowdown = buf.slice();
    if (res.river && res.showdown) stats.streets.river++;
    else if (res.turn) stats.streets.turn++;
    else if (res.flop) stats.streets.flop++;
    else stats.streets.preflop++;
    if (res.showdown) stats.streets.showdown++;
    if (res.foldwin) stats.streets.foldwin++;
    for (const a of res.actions) stats.aiActions[a] = (stats.aiActions[a] || 0) + 1;
  }

  while (stats.hands < HANDS) {
    await sleepTick();

    // 消费日志流：以 "===== 第 N 局 =====" 为界切分每手牌
    while (logLines.length) {
      const line = logLines.shift();
      if (/^===== 第 \d+ 局 =====$/.test(line)) {
        if (buf.length) record(analyzeHand(buf));
        buf = [];
        lastProgress = Date.now();
      }
      buf.push(line);
      if (process.env.DUMP_ALL) allLines.push(line);
    }

    // 玩家回合：能弃就弃，不能弃就过牌
    if (!byId['btn-fold'].disabled) { byId['btn-fold'].onclick(); lastProgress = Date.now(); }
    else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) { byId['btn-check'].onclick(); lastProgress = Date.now(); }

    // 卡死检测：25 秒无进展
    if (Date.now() - lastProgress > 25000 && stats.hands === lastSeen) {
      stats.hangs++;
      console.error('疑似卡死！最近日志：');
      console.error(buf.slice(-15).join('\n'));
      break;
    }
    if (stats.hands !== lastSeen) { lastSeen = stats.hands; lastProgress = Date.now(); }
  }

  console.log('=== 模拟结果（玩家每手尽快弃牌） ===');
  console.log('总手数:', stats.hands);
  console.log('走到翻牌:', stats.streets.flop, ' 转牌:', stats.streets.turn, ' 河牌:', stats.streets.river, ' (其中摊牌:', stats.streets.showdown + ')');
  console.log('翻牌前就结束:', stats.streets.preflop, ' 其中全员弃牌:', stats.streets.foldwin);
  console.log('卡死:', stats.hangs);
  const act = stats.aiActions;
  const total = Object.values(act).reduce((a, b) => a + b, 0) || 1;
  const dist = {};
  Object.keys(act).forEach(k => { dist[k] = act[k] + ' (' + (100 * act[k] / total).toFixed(1) + '%)'; });
  console.log('全部玩家动作分布:', JSON.stringify(dist));
  if (process.env.DUMP_ALL) {
    require('fs').writeFileSync(process.env.DUMP_ALL, allLines.join('\n'), 'utf8');
    console.log('全量日志已写入', process.env.DUMP_ALL);
  }
  if (process.env.DUMP_LOG) {
    const tail = buf.slice(-parseInt(process.env.DUMP_LOG, 10) || 40);
    console.log('=== 最近日志片段 ===\n' + tail.join('\n'));
  }
  if (savedShowdown) {
    console.log('=== 摊牌示例局 ===\n' + savedShowdown.join('\n'));
  }
  process.exit(0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
