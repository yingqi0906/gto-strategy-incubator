/* AI 决策探针：包装 aiDecide 记录每次调用参数，重点检查河牌面对下注时
   AI 对手牌的胜率评估是否与独立计算一致（排查"识别错手牌"） */
'use strict';
const fs = require('fs');
const path = require('path');

class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div'; this.children = []; this._class = new Set();
    this.style = {}; this.parentNode = null; this.textContent = ''; this.innerHTML = '';
    this.disabled = false; this.value = ''; this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null; this._qs = {}; this._listeners = {};
  }
  get classList() {
    const self = this;
    return {
      add: c => self._class.add(c), remove: c => self._class.delete(c),
      toggle: (c, f) => { if (f === undefined) { self._class.has(c) ? self._class.delete(c) : self._class.add(c); } else if (f) self._class.add(c); else self._class.delete(c); },
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
const byId = {}; const logLines = [];
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

const C = require('./core.js');
global.PokerCore = C;
/* 包装：记录调用与结果 */
const records = [];
const origDecide = C.aiDecide;
C.aiDecide = function (o) {
  const out = origDecide(o);
  if ((o.community || []).length === 5 && o.toCall > 0) {
    // 独立重算：无范围限制的胜率
    const eFree = require('./core.js');
    records.push({
      hole: o.hole.map(function (c) { return c.r + '_' + c.s; }),
      board: o.community.map(function (c) { return c.r + '_' + c.s; }),
      toCall: o.toCall, pot: o.pot, currentBet: o.currentBet, nOpp: o.nOpp,
      oppPctls: o.oppPctls,
      foldPct: (out.opts || []).filter(function (x) { return x.act.type === 'fold'; })
        .map(function (x) { return x.prob; })[0]
    });
  }
  return out;
};

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
eval(m[1]);

const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
(async function main() {
  byId['btn-start'].onclick();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!byId['btn-fold'].disabled) byId['btn-fold'].onclick();
    else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) byId['btn-check'].onclick();
    await sleepTick();
  }
  console.log('河牌面对下注的 AI 决策调用数:', records.length);
  // 找 fold 频率高的案例（两对/三条却被高弃牌率）
  const strongFold = records.filter(function (r) {
    const boardR = r.board.map(function (x) { return +x.split('_')[0]; }).sort(function (a, b) { return b - a; });
    const hr = r.hole.map(function (x) { return +x.split('_')[0]; });
    // 手牌与公牌有配对（两对以上）却 foldPct > 0.5
    const all = hr.concat(boardR);
    const cnt = {};
    all.forEach(function (x) { cnt[x] = (cnt[x] || 0) + 1; });
    const pairs = Object.keys(cnt).filter(function (k) { return cnt[k] >= 2 && +k >= hr[0] && hr.indexOf(+k) >= 0; });
    return pairs.length > 0 && r.foldPct > 0.5;
  });
  console.log('「手牌与公牌成对却 fold>50%」的案例:', strongFold.length);
  strongFold.slice(0, 8).forEach(function (r) {
    console.log('  hole=' + r.hole.join(' ') + ' board=' + r.board.join(' ') +
      ' toCall=' + r.toCall + ' pot=' + r.pot + ' nOpp=' + r.nOpp +
      ' oppPctls=[' + (r.oppPctls || []).map(function (x) { return x === undefined ? '1' : (+x).toFixed(2); }).join(',') + ']' +
      ' fold=' + Math.round(r.foldPct * 100) + '%');
  });
  process.exit(0);
})().catch(function (e) { console.error('异常:', e); process.exit(1); });
