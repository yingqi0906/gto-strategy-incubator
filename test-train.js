/* test-train.js — 翻前训练模式无头测试
   阶段1：点击"翻前训练"开局，人类策略=能加注就加到3bb否则过牌/跟注，等结算弹窗
   阶段2：点击"重复本手牌"，校验手牌与AI行动与首手完全一致
   阶段3：点击"下一手"，校验进入第2手并再次结算
   另校验：不进入翻牌、不显示历史战绩按钮、行动列表评价字段完整 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 极简 DOM stub（同 harness） ---------- */
class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div';
    this.children = [];
    this._class = new Set();
    this.style = {};
    this.parentNode = null;
    this._text = '';
    this.innerHTML = '';
    this.disabled = false;
    this.value = '';
    this.min = ''; this.max = ''; this.step = '';
    this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null;
    this._qs = {};
    this._listeners = {};
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); }
  get classList() {
    const self = this;
    return {
      add: c => self._class.add(c),
      remove: c => self._class.delete(c),
      toggle: (c, f) => { if (f === undefined) { self._class.has(c) ? self._class.delete(c) : self._class.add(c); } else if (f) self._class.add(c); else self._class.delete(c); },
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
  createElement(tag) { return new FakeEl(tag); },
  createTextNode(t) { const e = new FakeEl('#text'); e.textContent = String(t); return e; }
};
global.window = global;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { return setImmediate(fn); }; // 加速AI延时
const localStorageData = {};
global.localStorage = {
  getItem: k => (k in localStorageData ? localStorageData[k] : null),
  setItem: (k, v) => { localStorageData[k] = String(v); },
  removeItem: k => { delete localStorageData[k]; }
};

/* ---------- 加载核心与控制器 ---------- */
require('./core.js');
global.PokerCore = module.require('./core.js');
global.GWPreflop = require('./gw-ranges.js'); // 训练模式 AI 按频率行动要用范围表（浏览器里由 <script> 提供）
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到内嵌脚本'); process.exit(1); }
eval(m[1]);

const $ = id => byId[id] || (byId[id] = new FakeEl());
/* 弹窗初始状态预置（stub 不解析 HTML class） */
$('train-modal').classList.add('hidden');
$('stats-modal').classList.add('hidden');
$('stats-confirm').classList.add('hidden');
const sleepTick = () => new Promise(r => realSetTimeout(r, 0));

/* ---------- 测试驱动 ---------- */
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

function humanPolicy() {
  // 训练模式 UI 状态采集（仅在行动条激活时记录）

  // 测试策略（训练模式新 UI）：能加注（标准额度）就加注，否则加不了就 allin，
  // 再否则过牌/跟注，不行就弃牌
  const raise = $('btn-raise');
  if ($('action-bar').classList.contains('disabled')) return true;
  // 2026-10-14 WPT 版式：尺寸选择=预设堆+自由下注模块；训练模式应整体隐藏
  // （btn-free 已并入中列双态按钮，训练态自由下注只看箭头是否隐藏）
  if ($('free-arrow').style.display === 'none') uiSeen.panelHidden = true;
  if ($('btn-allin').style.display !== 'none') uiSeen.allinVisible = true;
  if (raise.style.display !== 'none' && raise.textContent) {
    uiSeen.raiseLabels.push(raise.textContent);
    raise.onclick(); return true;
  }
  const allin = $('btn-allin');
  if (allin.style.display !== 'none' && !allin.disabled) { allin.onclick(); return true; }
  const chk = $('btn-check');
  if (!chk.disabled) { chk.onclick(); return true; }
  const fold = $('btn-fold');
  if (!fold.disabled) { fold.onclick(); return true; }
  return false;
}

function waitSettle() {
  // 等待结算弹窗出现（带超时）
  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await sleepTick();
      while (logLines.length) {
        const line = logLines.shift();
        buf.push(line);
      }
      if (!$('train-modal').classList.contains('hidden')) return true;
      humanPolicy();
    }
    return false;
  })();
}

function aiSegments(lines) {
  // 提取 AI 座位的行动文本段（含选项频率行），用于前后一致性比对
  const segs = [];
  let cur = null;
  for (const l of lines) {
    const h = l.match(/^(.+?)·(.+?)·(.+?)：$/);
    if (h) {
      if (cur) segs.push(cur);
      cur = (h[1] === '你（玩家）') ? null : { name: h[1], body: [] };
      continue;
    }
    if (cur) cur.body.push(l);
  }
  if (cur) segs.push(cur);
  return segs;
}

function aiHoles(lines) {
  const out = [];
  for (const l of lines) {
    const h = l.match(/^(.+?)·(.+?) 手牌：(.+)$/);
    if (h && h[1] !== '你（玩家）') out.push(h[1] + ' ' + h[3]);
  }
  return out.join(' | ');
}

let buf = [];
// 训练模式 UI 状态采集（humanPolicy 中填空）
const uiSeen = { panelHidden: false, allinVisible: false, raiseLabels: [] };
(async function main() {
  $('btn-train').onclick();
  check('训练模式：历史战绩按钮隐藏', $('stats-toggle').style.display === 'none');

  // 阶段1：第一手
  buf = [];
  if (!await waitSettle()) { check('阶段1：结算弹窗出现', false, '超时'); return done(); }
  check('阶段1：结算弹窗出现', true);
  check('阶段1：未进入翻牌', buf.every(l => l.indexOf('翻牌 ---') < 0));
  const handNo1 = (buf.join('\n').match(/===== 第 (\d+) 局 =====/) || [])[1];
  const decLines1 = $('train-actions').children.map(c => c.textContent);
  check('阶段1：行动列表非空', decLines1.length >= 1, JSON.stringify(decLines1));
  check('阶段1：评价字段完整', decLines1.every(l => l.indexOf('行动') >= 0), JSON.stringify(decLines1));
  check('阶段1：每个决策含gto决策说明（选项行或无策略）',
    decLines1.every(l => l.indexOf('└') >= 0 && (l.indexOf('%') >= 0 || l.indexOf('无策略') >= 0)),
    JSON.stringify(decLines1));
  check('阶段1：第1手', handNo1 === '1', '实际 ' + handNo1);
  check('训练UI：尺寸选择面板隐藏', uiSeen.panelHidden);
  check('训练UI：allin按钮出现过', uiSeen.allinVisible);
  check('训练UI：加注按钮显示行为名（开池/3bet/4bet/5bet）',
    uiSeen.raiseLabels.length >= 1 && uiSeen.raiseLabels.every(l => ['开池', '3bet', '4bet', '5bet', '加注'].indexOf(l) >= 0),
    JSON.stringify(uiSeen.raiseLabels));
  const holes1 = aiHoles(buf);
  const segs1 = aiSegments(buf).map(s => s.name + '|' + s.body.join('∥'));
  const record1 = decLines1.slice();
  if (process.env.TRAIN_DUMP) console.log('--- 结算行动列表示例 ---\n' + decLines1.join('\n') + '\n--- 手牌：' + holes1);

  // 阶段2：重复本手牌
  $('btn-train-replay').onclick();
  buf = [];
  if (!await waitSettle()) { check('阶段2：重放结算出现', false, '超时'); return done(); }
  const handNo2 = (buf.join('\n').match(/===== 第 (\d+) 局 =====/) || [])[1];
  check('阶段2：重放保持同一手号', handNo2 === handNo1, '实际 ' + handNo2);
  check('阶段2：手牌一致', aiHoles(buf) === holes1, aiHoles(buf) + ' vs ' + holes1);
  const segs2 = aiSegments(buf).map(s => s.name + '|' + s.body.join('∥'));
  check('阶段2：AI行动完全一致', JSON.stringify(segs1) === JSON.stringify(segs2),
    JSON.stringify(segs1.slice(0, 2)) + ' vs ' + JSON.stringify(segs2.slice(0, 2)));

  // 阶段3：下一手
  $('btn-train-next').onclick();
  buf = [];
  if (!await waitSettle()) { check('阶段3：第2手结算出现', false, '超时'); return done(); }
  const handNo3 = (buf.join('\n').match(/===== 第 (\d+) 局 =====/) || [])[1];
  check('阶段3：进入第2手', handNo3 === '2', '实际 ' + handNo3);
  check('阶段3：仍未进入翻牌', buf.every(l => l.indexOf('翻牌 ---') < 0));

  done();
})().catch(e => { console.error('异常:', e); process.exit(1); });

function done() {
  console.log('=== 翻前训练测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
}
