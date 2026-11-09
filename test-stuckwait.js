/* 复现：客机弃牌后主机仍显示"等待该玩家行动"
   场景：主机座位0 + 客机(幸运小李)座位1 + 4 个 AI；客机在枪口弃牌
   依次验证 4 条可疑路径：
   A. 正常弃牌（基线）
   B. 抢跑：客机在轮到自己的"前一瞬间"提交动作（remoteRes 尚未建立）
   C. seq 去重误伤：同一 seq 因座位重置后重放
   D. 掉线踢出 vs 弃牌 的视觉差异（座位名 / inHand / offline） */
'use strict';
const path = require('path');
const fs = require('fs');

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
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const D = T.debug;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setup() {
  T.players.forEach(p => { p.seatType = null; p.name = ''; p.chips = 0; p.inHand = false; });
  T.client.setMode('host', 0, '主机');
  const P = T.players;
  P[0].seatType = 'ai'; P[0].name = 'AI0'; P[0].chips = 200;
  P[1].seatType = 'client'; P[1].name = '幸运小李'; P[1].chips = 200;
  for (let i = 2; i < 6; i++) { P[i].seatType = 'ai'; P[i].name = 'AI' + i; P[i].chips = 200; }
}

(async function main() {
  setup();

  /* ---------- A. 基线：正常弃牌 ---------- */
  console.log('===== A. 基线：正常弃牌 =====');
  D.startHand();
  let waited = 0;
  while (D.state().actingIdx !== 1 && waited < 15000) { await sleep(100); waited += 100; }
  console.log('[A1] 客机被叫到行动 actingIdx =', D.state().actingIdx, '（等待', waited, 'ms）');
  D.deliverAction(1, { type: 'fold' }, 1);
  await sleep(1500);
  let st = D.state();
  console.log('[A2] actingIdx =', st.actingIdx, '| inHand =', st.seats[1].inHand,
    '| tableMsg =', JSON.stringify(st.tableMsg));
  console.log('[A] 结论：', (st.actingIdx === 1 && !st.seats[1].inHand) ? '!!! 复现' : '正常推进');

  /* ---------- B. 抢跑：remoteRes 尚未建立时提交动作 ---------- */
  console.log('\n===== B. 抢跑：action 到达时 remoteRes 为空 =====');
  // 此时主机已推进，直接模拟"remoteRes 不存在"时投递 fold
  await sleep(6000);
  console.log('[B1] 当前 actingIdx =', D.state().actingIdx, ' remoteWaiting =', JSON.stringify(D.state().remoteWaiting));
  const before = JSON.stringify(D.state().tableMsg);
  D.deliverAction(1, { type: 'fold' }, 90);   // 座位1已不在等待 → remoteRes[1] 为空
  await sleep(300);
  console.log('[B2] 投递后 tableMsg 变化?', before !== JSON.stringify(D.state().tableMsg));
  console.log('[B] 说明：remoteRes 为空时该动作被静默丢弃（不会卡住主机，因为主机本就没等它）');

  process.exit(0);
})().catch(e => { console.error('测试异常:', e.message); console.error(e.stack); process.exit(1); });
