/* 行动顺序标准规则校验
   标准规则（无限注德州扑克·单挑 heads-up）：
     · 按钮位同时是小盲（button posts the small blind），另一人下大盲
     · 翻前：按钮/小盲先行动，大盲最后行动（保留过牌/加注权）
     · 翻后（翻牌/转牌/河牌）：大盲先行动，按钮位最后行动
   6max：翻前枪口（大盲下一位）先行动；翻后小盲先行动
   用法：node test-order.js */
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
  createElement(tag) { return new FakeEl(tag); },
  addEventListener() {}
};
global.window = global;
try { global.localStorage = { getItem: () => null, setItem: () => {} }; } catch (e) {}

const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { return setImmediate(fn); }; // 加速牌局（AI 思考延时）
require('./core.js');
global.PokerCore = module.require('./core.js');
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

const T = global.window.__PokerTest;
const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ok ' + msg); } else { fail++; console.error('  FAIL ' + msg); } };

/* 从日志解析每手牌的翻前 / 翻后首个行动者（以 ln-player 行定位真实行动者）
   同时给出翻前行动序列 preSeq（位置名），用于校验大盲的过牌/加注权 */
function firstActors(lines) {
  const hands = [];
  let cur = null, street = '';
  (lines || []).forEach(function (l) {
    const t = (l && l.text) || '';
    if (/^===== 第 \d+ 局 =====$/.test(t)) { cur = { pre: '', post: '', preSeq: [] }; hands.push(cur); street = ''; return; }
    if (!cur) return;
    if (t.indexOf('--- 翻牌前 ---') >= 0) { street = 'pre'; return; }
    if (t.indexOf('--- 翻牌 ---') >= 0 || t.indexOf('--- 转牌 ---') >= 0 || t.indexOf('--- 河牌 ---') >= 0) { street = 'post'; return; }
    if (l.cls === 'ln-player' && street) {
      if (street === 'pre') { cur.preSeq.push(positionOf(t)); if (!cur.pre) cur.pre = t; }
      if (street === 'post' && !cur.post) cur.post = t;
    }
  });
  return hands;
}
/* 从 "<名字>·<位置>[·…]：" 中提取位置名（单挑为「按钮·小盲」/「大盲」） */
function positionOf(line) {
  const s = String(line || '');
  if (s.indexOf('按钮') >= 0 && s.indexOf('小盲') >= 0) return '按钮·小盲';
  if (s.indexOf('大盲') >= 0) return '大盲';
  if (s.indexOf('小盲') >= 0) return '小盲';
  if (s.indexOf('枪口') >= 0) return '枪口';
  if (s.indexOf('按钮') >= 0) return '按钮';
  return '?';
}
/* 自动推进：能跟注就跟注，否则弃牌；过牌优先 */
function autoAct() {
  if (!byId['btn-fold'].disabled && byId['btn-check'].textContent.indexOf('跟注') >= 0) byId['btn-check'].onclick();
  else if (!byId['btn-fold'].disabled) byId['btn-fold'].onclick();
  else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) byId['btn-check'].onclick();
}

(async function main() {
  /* ---------- 1. 源码级：三条位置规则写法 ---------- */
  console.log('--- 源码规则 ---');
  ok(/n === 2\) \{ sbSeat = buttonIdx; bbSeat = nextActive\(buttonIdx \+ 1\); \}/.test(html),
    '单挑：按钮位即小盲（按钮位下小盲，另一人下大盲）');
  ok(/const utgSeat = n === 2 \? sbSeat : nextActive\(bbSeat \+ 1\)/.test(html),
    '单挑翻前首动 = 小盲/按钮位（大盲最后行动）');
  ok(/const firstPost = n === 2 \? bbSeat : nextActive\(buttonIdx \+ 1\)/.test(html),
    '单挑翻后首动 = 大盲（按钮位最后行动）');
  ok(/const utgSeat = n === 2 \? sbSeat : nextActive\(bbSeat \+ 1\)/.test(html) &&
    /const firstPost = n === 2 \? bbSeat : nextActive\(buttonIdx \+ 1\)/.test(html),
    '6max 分支未变（翻前大盲下一位 = 枪口，翻后按钮下一位 = 小盲）');

  /* ---------- 2. 单挑实战（本地 AI vs AI，2 人） ---------- */
  console.log('--- 单挑实战（2 人，AI vs AI） ---');
  T.duel.setDuel(true);
  T.duel.seedHeadsUp(null, null);
  const t0 = Date.now();
  /* 单挑 AI vs AI 里只有少数手会走到翻后（多数翻前就分胜负），下面两条"翻后首动"
     断言需要 ≥3 手翻后样本。原先固定打到 40 手 / 12 秒，实测约 20% 概率样本不足
     → 假红（与任何功能改动无关）。改为"打到攒够 3 手翻后样本为止"，20 秒上限兜底。 */
  const postflopCount = function () {
    return firstActors(T.logLines()).filter(function (h) { return h.pre && h.post; }).length;
  };
  while (Date.now() - t0 < 20000 && postflopCount() < 3) await wallSleep(20);
  const lines = T.logLines();
  const bs = T.blindSeats();
  const bi = T.buttonIdx();
  const handsRun = T.duel.handNoNow();
  T.exitToMenu();

  ok(handsRun >= 5, '单挑牌局可连续推进（' + handsRun + ' 手）');
  ok(bs.sb === bi, '盲注归属：按钮位即小盲（sb=' + bs.sb + '，button=' + bi + '）');
  ok(bs.bb >= 0 && bs.bb !== bs.sb, '盲注归属：大盲为另一座位（bb=' + bs.bb + '）');

  const hs = firstActors(lines).filter(h => h.pre);
  const preOk = hs.filter(h => h.preSeq[0] === '按钮·小盲').length;
  ok(hs.length >= 5, '解析到 ' + hs.length + ' 手的翻前行动');
  ok(hs.length > 0 && preOk === hs.length, '单挑翻前首动均为小盲/按钮位（' + preOk + '/' + hs.length + '）');
  const hp = hs.filter(h => h.post);
  const postOk = hp.filter(h => positionOf(h.post) === '大盲').length;
  ok(hp.length >= 3, '解析到 ' + hp.length + ' 手的翻后行动（有人翻前弃牌的手不进翻后）');
  ok(hp.length > 0 && postOk === hp.length, '单挑翻后首动均为大盲（' + postOk + '/' + hp.length + '）');
  /* 大盲的过牌/加注权：小盲先行时，若小盲未弃牌，则大盲必在小盲之后获得行动机会 */
  const bbOpt = hs.filter(h => h.preSeq.length >= 2 && h.preSeq[0] === '按钮·小盲' && h.preSeq[1] === '大盲').length;
  ok(bbOpt >= 2, '小盲先行动后大盲仍有行动机会（过牌/加注权，' + bbOpt + ' 手验证）');

  /* 离线校验脚本 check-order.js 也应认可真实单挑日志（直接复用其逻辑，避免 spawn） */
  {
    const r = require('./check-order.js').checkOrder(lines.map(l => l.text).join('\n'));
    ok(r.bad.length === 0, 'check-order.js 复核真实单挑日志：手数 ' + r.hands +
      '，翻前 ' + r.checkedPre + '，翻后 ' + r.checkedPost + '，错误 ' + r.bad.length);
  }

  /* ---------- 3. 6max 单机实战（真人自动跟注/过牌） ---------- */
  console.log('--- 6max 实战（单机 6 人） ---');
  byId['btn-start'].onclick();
  await wallSleep(30);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const heads = T.logLines().filter(l => /^===== 第 \d+ 局 =====$/.test(l.text)).length;
    if (heads >= 3) break;
    autoAct();
    await sleepTick();
  }
  const lines6 = T.logLines();
  const hs6 = firstActors(lines6).filter(h => h.pre);
  const preOk6 = hs6.filter(h => /枪口/.test(h.pre)).length;
  T.exitToMenu();
  ok(hs6.length >= 2, '6max 解析到 ' + hs6.length + ' 手的翻前行动');
  ok(hs6.length > 0 && preOk6 === hs6.length, '6max 翻前首动均为枪口（' + preOk6 + '/' + hs6.length + '）');
  {
    /* 丢弃可能尚未跑完的最后一手（退出时该手日志不完整），只用完整手牌校验 */
    const all6 = lines6.map(l => l.text);
    const cut6 = all6.lastIndexOf(all6.filter(t => /^===== 第 \d+ 局 =====$/.test(t)).pop());
    const r6 = require('./check-order.js').checkOrder(all6.slice(0, cut6 >= 0 ? cut6 : all6.length).join('\n'));
    ok(r6.bad.length === 0 && r6.hands >= 1, 'check-order.js 复核 6max 日志：手数 ' + r6.hands +
      '，翻前 ' + r6.checkedPre + '，翻后 ' + r6.checkedPost + '，错误 ' + r6.bad.length +
      ' ' + JSON.stringify(r6.bad.slice(0, 3)));
  }

  console.log('\n=== 行动顺序测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  global.setTimeout = realSetTimeout;
  process.exit(fail ? 1 : 0);
})();
