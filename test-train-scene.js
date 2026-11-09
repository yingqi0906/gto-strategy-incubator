/* test-train-scene.js — 翻前练习「行动场景」端到端（无头真牌局）
   覆盖用户口径：
   · 随机的：玩家手牌仍在「至少一个位置会开池」的并集里，前位不做预置
   · 加注开池：玩家不在大盲、翻前行动顺序里玩家之前的人全部已弃牌、轮到玩家时无人加注
   · 面对加注：玩家不在枪口、玩家之前恰好一人 open、轮到玩家时已有加注
   · 面对 3bet：玩家不在大盲、前位全弃；玩家手牌 = 本位置会 open 的手牌；
                 玩家 open 之后其后恰好一名 AI 3bet（中间的 AI 让位弃牌）
   另覆盖：场景按钮默认随机的 / 四按钮 id / 设置持久化 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 极简 DOM stub（与 test-train 同构） ---------- */
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
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(tag) { return new FakeEl(tag); },
  createTextNode(t) { const e = new FakeEl('#text'); e.textContent = String(t); return e; }
};
global.window = global;
global.setTimeout = function (fn) { return setImmediate(fn); };
const localStorageData = {};
global.localStorage = {
  getItem: k => (k in localStorageData ? localStorageData[k] : null),
  setItem: (k, v) => { localStorageData[k] = String(v); },
  removeItem: k => { delete localStorageData[k]; }
};
require('./core.js');
global.PokerCore = module.require('./core.js');
const GW = require('./gw-ranges.js');
global.GWPreflop = GW;

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
eval(m[1]);

const $ = id => byId[id] || (byId[id] = new FakeEl());
['train-modal', 'stats-modal', 'stats-confirm', 'settings-modal'].forEach(id => $(id).classList.add('hidden'));

const T = global.window.__PokerTest;
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const sleepTick = () => new Promise(r => setImmediate(r));
async function sleepTicks(n) { for (let i = 0; i < (n || 1); i++) await sleepTick(); }
const realNow = () => Date.now();

/* ---------- 基础信息 ---------- */
const BB = 1;
const unionSet = {}; // 「至少一个位置会开池」
Object.keys(GW.GW).forEach(function (k) {
  if (k.indexOf('RFI|') !== 0) return;
  Object.keys(GW.GW[k]).forEach(function (h) {
    const v = GW.GW[k][h];
    if ((+v[0] || 0) > 0 || (+v[2] || 0) > 0) unionSet[h] = 1;
  });
});
function openSetOf(pos) {
  const out = {};
  const tbl = GW.GW['RFI|' + pos] || {};
  Object.keys(tbl).forEach(function (h) {
    const v = tbl[h];
    if ((+v[0] || 0) + (+v[2] || 0) > 0) out[h] = 1;
  });
  return out;
}

function entries() { return T.debug.logEntries(); }
function entriesThisHand() {
  const all = entries();
  let at = -1;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].text.indexOf('===== 第') === 0) { at = i; break; }
  return at < 0 ? all : all.slice(at);
}

async function waitActing(seat, maxMs) {
  const t0 = realNow();
  while (realNow() - t0 < (maxMs || 20000)) {
    await sleepTick();
    if (T.debug.state().actingIdx === seat) return true;
  }
  return false;
}

/* 启动第一手（主菜单 → 点场景按钮走真实 UI 路径） */
function startScene(key) {
  $( 'train-modal').classList.add('hidden');
  $('btn-scene-' + key).onclick();
}

const results = {};
(async function main() {
  /* ---------- ⑤ 设置面板：默认随机的 + 四按钮 ---------- */
  T.settings.open();
  check('设置面板默认选中「随机的」',
    $('btn-scene-random').classList.contains('active') &&
    !$('btn-scene-rfi').classList.contains('active'),
    JSON.stringify(T.debug.trainScene.get()));
  check('设置面板回填场景说明（随机的）',
    String($('scene-desc').textContent).indexOf('总体频率') >= 0, $('scene-desc').textContent);
  check('四个场景按钮都存在且绑定 onclick',
    ['random', 'rfi', 'vsopen', 'vs3bet'].every(k => typeof $('btn-scene-' + k).onclick === 'function'));
  check('场景值默认 random', T.debug.trainScene.get() === 'random');

  /* ---------- ① 随机的 ---------- */
  startScene('random');
  const okR = await waitActing(0);
  check('随机的：轮到玩家', okR);
  {
    const st = T.debug.state(), pm = T.rit.posMaps();
    const order = T.debug.trainScene.order();
    const myPos = order.indexOf(0);
    const before = order.slice(0, myPos);
    const hole = T.debug.holeOf(0);
    const key = hole.length === 2 ? GW.handKeyOf(hole) : '';
    results.random = { pos: pm.en[0], key: key };
    check('随机的：玩家拿到两张牌', hole.length === 2);
    check('随机的：玩家手牌仍在「至少一个位置会开池」并集内', !!unionSet[key], key);
    check('随机的：前位不做预置（applyPre 在 random 下不动任何人）', (function () {
      const snapshot = st.seats.map(s => s.inHand);
      T.debug.trainScene.applyPre();
      const after = T.debug.state().seats.map(s => s.inHand);
      return JSON.stringify(snapshot) === JSON.stringify(after);
    })(), '前位 ' + before.length + ' 人');
    check('随机的：模式为训练且未进入翻牌', T.debug.state().street === 'preflop');
  }
  $('btn-fold').onclick(); // 结束本手
  /* 结算流程含真实延时（收池动画等），轮询等待进入局间（上限 5s，修偶发抖动） */
  let settled = false;
  for (let i = 0; i < 200 && !settled; i++) {
    await new Promise(r => setTimeout(r, 25));
    settled = T.debug.state().handSettling === true;
  }
  /* 局间秀牌修复（2026-10-20）：训练结算后 handSettling 必须为 true，
     此前漏设 → 点手牌走 showFlags 分支永远不消费，无法秀牌 */
  check('训练局间：handSettling=true（点手牌可直接亮牌）', settled,
    '实际 ' + T.debug.state().handSettling);
  check('训练局间：结算弹窗可见（下一手入口在弹窗上）',
    !$('train-modal').classList.contains('hidden'));

  /* ---------- ② 加注开池（rfi） ---------- */
  startScene('rfi');
  const okA = await waitActing(0);
  check('加注开池：轮到玩家', okA);
  {
    const st = T.debug.state(), pm = T.rit.posMaps();
    const order = T.debug.trainScene.order();
    const myPos = order.indexOf(0);
    const before = order.slice(0, myPos);
    const foldedBefore = before.filter(s => !st.seats[s].inHand);
    results.rfi = { pos: pm.en[0], before: before.length, myPos: myPos };
    check('加注开池：玩家不在大盲位', pm.en[0] !== 'BB', '实际 ' + pm.en[0]);
    check('加注开池：玩家之前的人全部已弃牌（玩家首个行动时也算成立）',
      foldedBefore.length === before.length,
      foldedBefore.length + '/' + before.length);
    check('加注开池：轮到玩家时无人加注（currentBet = 1bb）', st.currentBet === BB, '实际 ' + st.currentBet);
    check('加注开池：至少还有一名对手在牌局里（大盲）',
      st.seats.filter(s => s.inHand).length >= 2);
  }
  $('btn-fold').onclick();
  await sleepTicks(5);

  /* ---------- ③ 面对加注（vsopen） ---------- */
  startScene('vsopen');
  const okB = await waitActing(0);
  check('面对加注：轮到玩家', okB);
  {
    const st = T.debug.state(), pm = T.rit.posMaps();
    const order = T.debug.trainScene.order();
    const myPos = order.indexOf(0);
    const before = order.slice(0, myPos);
    const activeBefore = before.filter(s => st.seats[s].inHand);
    const raisers = activeBefore.filter(s => st.seats[s].bet === st.currentBet);
    results.vsopen = { pos: pm.en[0], before: before.length, raisers: raisers.length };
    check('面对加注：玩家不在枪口位', pm.en[0] !== 'UTG', '实际 ' + pm.en[0]);
    check('面对加注：玩家之前恰好一人开池', activeBefore.length === 1 && raisers.length === 1,
      'active=' + activeBefore.length + ' raisers=' + raisers.length);
    check('面对加注：轮到玩家时确实面对加注（currentBet > 1bb）', st.currentBet > BB, '实际 ' + st.currentBet);
    check('面对加注：开池者留有合法手牌（按行为反推）', T.debug.holeOf(raisers[0] || -1).length === 2);
  }
  $('btn-fold').onclick();
  await sleepTicks(5);

  /* ---------- ④ 面对 3bet（vs3bet） ---------- */
  startScene('vs3bet');
  const okC = await waitActing(0);
  check('面对 3bet：轮到玩家', okC);
  let pos3 = '', key3 = '';
  {
    const st = T.debug.state(), pm = T.rit.posMaps();
    const order = T.debug.trainScene.order();
    const myPos = order.indexOf(0);
    const before = order.slice(0, myPos);
    const hole = T.debug.holeOf(0);
    key3 = hole.length === 2 ? GW.handKeyOf(hole) : '';
    pos3 = pm.en[0];
    const openSet = openSetOf(pos3);
    results.vs3bet = { pos: pos3, key: key3 };
    check('面对 3bet：玩家不在大盲位', pos3 !== 'BB', '实际 ' + pos3);
    check('面对 3bet：玩家之前全部弃牌',
      before.every(s => !st.seats[s].inHand), before.length + ' 人');
    check('面对 3bet：玩家手牌 = 本位置会开池的手牌',
      !!openSet[key3], pos3 + ' / ' + key3);
    check('面对 3bet：轮到玩家时无人加注（先让玩家 open）', st.currentBet === BB, '实际 ' + st.currentBet);
    check('面对 3bet：已安排好其后的一名 AI 负责 3bet',
      T.debug.trainScene.threeBettor() >= 0 &&
      order.indexOf(T.debug.trainScene.threeBettor()) > myPos,
      'threeBettor=' + T.debug.trainScene.threeBettor() + ' myPos=' + myPos);
  }
  /* 玩家 open */
  const before3 = entriesThisHand().length;
  $('btn-raise').onclick();
  const okC2 = await waitActing(0, 20000);
  check('面对 3bet：玩家 open 后回到玩家（面对 3bet）', okC2);
  if (!okC2) {
    console.log('  [诊断] state=' + JSON.stringify(T.debug.state()));
    console.log('  [诊断] lastSubmitted=' + JSON.stringify(T.debug.lastSubmitted &&
      T.debug.lastSubmitted()));
    console.log('  [诊断] btn-raise onclick=' + typeof $('btn-raise').onclick +
      ' display=' + $('btn-raise').style.display + ' text=' + $('btn-raise').textContent);
    console.log('  [诊断] log=' + entriesThisHand().slice(-10).map(l => l.text).join(' | '));
  }
  if (okC2) {
    const st = T.debug.state();
    const seg = entriesThisHand().slice(before3);
    /* 日志里的加注行不带名字（富文本 meta 才有），本手玩家只 open 一次 → 加注行应为 2：
       玩家 open + 一名 AI 3bet */
    const raiseLines = seg.filter(function (l) { return l.text.indexOf('加注至') === 0; });
    const tbIdx = [];
    st.seats.forEach(function (s, i) {
      if (i !== 0 && s.type && s.inHand && s.bet === st.currentBet) tbIdx.push(i);
    });
    results.vs3bet.currentBet = st.currentBet;
    results.vs3bet.threeBettors = tbIdx.length;
    check('面对 3bet：其后恰好一名 AI 做了 3bet', tbIdx.length === 1,
      '当前最高注持有者 ' + tbIdx.length + ' 人 / currentBet ' + st.currentBet);
    check('面对 3bet：全手只有玩家 open + 一次 3bet 两个加注动作', raiseLines.length === 2,
      JSON.stringify(raiseLines.map(l => l.text)));
    check('面对 3bet：玩家再次行动时面对加注（currentBet ≥ 7bb）', st.currentBet >= 7, '实际 ' + st.currentBet);
    check('面对 3bet：3bet 者留有合法手牌（按行为反推）', T.debug.holeOf(tbIdx[0]).length === 2);
    /* 3bet 者之外的 AI 让位弃牌：仍在牌局里的对手 ≤ 2（玩家 + 3bet 者，可能还有大盲未行动） */
    const alive = st.seats.filter(s => s.inHand).length;
    check('面对 3bet：中间的 AI 已让位（在局人数 ≤ 3）', alive <= 3, '实际 ' + alive);
  }
  $('btn-fold').onclick();
  await sleepTicks(5);

  /* ---------- ⑤ 场景切换即重新发牌 + 持久化 ---------- */
  startScene('rfi');
  await waitActing(0);
  const handBefore = T.debug.state().handNo;
  T.debug.trainScene.set('vsopen'); // 训练中切场景 → 立刻重新发牌
  const okRe = await waitActing(0);
  check('训练中切换场景 → 立即重新发牌（手号 +1）', okRe && T.debug.state().handNo === handBefore + 1,
    handBefore + ' → ' + T.debug.state().handNo);
  check('切换后场景生效', T.debug.trainScene.get() === 'vsopen');
  check('场景写入 localStorage', /"trainScene":"vsopen"/.test(localStorageData['gto_settings_v1'] || ''),
    localStorageData['gto_settings_v1']);
  $('btn-fold').onclick();
  await sleepTicks(5);

  /* ---------- 汇总 ---------- */
  console.log('--- 场景抽样结果 ---');
  console.log('  随机的  : 位置 ' + results.random.pos + '，手牌 ' + results.random.key);
  console.log('  加注开池: 位置 ' + results.rfi.pos + '，前位 ' + results.rfi.before + ' 人全弃');
  console.log('  面对加注: 位置 ' + results.vsopen.pos + '，前位 ' + results.vsopen.before + ' 人，开池者 ' + results.vsopen.raisers + ' 人');
  console.log('  面对3bet: 位置 ' + results.vs3bet.pos + '，手牌 ' + results.vs3bet.key);
  console.log('--- 结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('异常:', e); process.exit(1); });
