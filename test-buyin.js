/* 手动买入功能无头测试：按钮显隐 / 申请日志 / 下一手生效且只生效一次 */
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
require('./core.js');
global.PokerCore = module.require('./core.js');
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
eval(m[1]);

const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));

(async function main() {
  let pass = 0, fail = 0;
  const assert = (c, msg) => { if (c) { pass++; } else { fail++; console.error('FAIL: ' + msg); } };

  byId['btn-start'].onclick(); // 单机开局
  await wallSleep(80);

  assert(byId['buyin-toggle'].style.display === '', '单机开始后显示买入按钮');
  assert(byId['session-toggle'].style.display === 'none', '单机不显示本局战绩按钮');
  assert(byId['tl-buttons'].style.display === 'flex', '左上角菜单容器显示');

  // 第1手进行中申请买入 300 → 下一手生效
  byId['buyin-toggle'].onclick();
  assert(!byId['buyin-modal'].classList.contains('hidden'), '点击买入打开弹窗');
  byId['buyin-slider'].value = '300';
  byId['buyin-slider'].oninput();
  assert(byId['buyin-value'].textContent === '300', '滑块联动金额显示');
  byId['btn-buyin-ok'].onclick();
  assert(byId['buyin-modal'].classList.contains('hidden'), '确认后弹窗关闭');
  assert(logLines.some(l => l.indexOf('【买入】') >= 0 && l.indexOf('300') >= 0), '日志记录买入申请');

  // 推进手牌直到生效行出现（第2手开始时）
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !logLines.some(l => l.indexOf('手动买入生效') >= 0)) {
    if (!byId['btn-fold'].disabled) byId['btn-fold'].onclick();
    else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) byId['btn-check'].onclick();
    await sleepTick();
  }
  const effIdx = logLines.findIndex(l => l.indexOf('手动买入生效') >= 0);
  assert(effIdx >= 0, '买入在后续手牌生效（日志出现“手动买入生效”）');
  assert(logLines[effIdx].indexOf('300') >= 0, '生效金额为 300');

  const headers = [];
  logLines.forEach((l, i) => { if (/^===== 第 \d+ 局 =====$/.test(l)) headers.push(i); });
  assert(headers.length >= 2, '至少进行了两手牌');
  const eff = logLines[effIdx];
  // 生效行应位于第2手局头之前（生效发生在下一手开始时）
  assert(effIdx > headers[0] && effIdx < headers[1], '生效时机 = 下一手牌开始时（第2手局头之前）');

  // 再推进一手，确认不会重复生效
  const deadline2 = Date.now() + 10000;
  while (Date.now() < deadline2 && headers.length < 3) {
    if (!byId['btn-fold'].disabled) byId['btn-fold'].onclick();
    else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) byId['btn-check'].onclick();
    await sleepTick();
  }
  const effCount = logLines.filter(l => l.indexOf('手动买入生效') >= 0).length;
  assert(effCount === 1, '买入只生效一次（实际 ' + effCount + ' 次）');

  console.log('共 ' + (pass + fail) + ' 项断言，通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
