/* 全下亮牌（无人可再行动时先亮牌再发公共牌）行为测试
   覆盖：
   1) noMoreAction() 判定：全员 allin、唯一持有筹码者已跟平、仍需跟注、仍可加注（有筹码多人）
   2) revealAllInShowdown()：翻开全部未弃牌玩家手牌、写入日志、重复调用不重复记录
   3) playHand 主循环中在发公共牌之前调用的源码约束（先亮牌再发牌）
   4) 摊牌路径仍正常（revealAll 不再重复标记） */
'use strict';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };

/* ---------- 无头 DOM 桩 ---------- */
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
  appendChild(ch) { ch.parentNode = this; this.children.push(ch); return ch; }
  removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  querySelectorAll() { return []; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener() {}
  focus() {}
  getBoundingClientRect() { return { width: 100, height: 100, top: 0, left: 0 }; }
}

const byId = {};
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(tag) { return new FakeEl(tag); },
  addEventListener() {},
  body: new FakeEl('body'),
  documentElement: new FakeEl('html')
};
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
global.PokerCore = require('./core.js');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;

/* ---------- 源码级：调用顺序（先亮牌，后发牌） ---------- */
console.log('--- 源码约束 ---');
const loopStart = html.indexOf("const streets = ['flop', 'turn', 'river'];");
const loopEnd = html.indexOf('await showdown();', loopStart);
const loop = html.slice(loopStart, loopEnd);
ok(loop.indexOf('noMoreAction()') >= 0, '翻后主循环包含"无人可再行动"检查');
ok(loop.indexOf('revealAllInShowdown()') >= 0, '翻后主循环在发公共牌前调用亮牌');
ok(loop.indexOf('revealAllInShowdown()') < loop.indexOf('board.push(deck.pop())'),
  '亮牌发生在 board.push（发公共牌）之前');
ok(/function noMoreAction\(\)[\s\S]*?canBet\.length === 0[\s\S]*?\}/.test(html), 'noMoreAction：全员 allin 判定');
ok(/canBet\.length === 1 && canBet\[0\]\.bet >= currentBet/.test(html), 'noMoreAction：唯一有筹码者已跟平判定');

/* ---------- 行为级 ---------- */
console.log('--- 行为：noMoreAction ---');
function setup(chipsArr, inHandArr, bets, curBet) {
  T.players.forEach(function (p, i) { p.seatType = null; p.name = ''; p.chips = 0; p.inHand = false; p.bet = 0; p.revealed = false; });
  chipsArr.forEach(function (c, i) {
    if (c === null) return;
    T.players[i].seatType = i === 0 ? 'host' : 'ai';
    T.players[i].name = 'P' + i;
    T.players[i].chips = c;
    T.players[i].inHand = inHandArr[i];
    T.players[i].bet = bets[i] || 0;
  });
  T.setBettingState(curBet);
}

/* 2 人全部 allin（chips=0）→ 无人可行动 */
setup([0, 0, null, null, null, null], [true, true, false, false, false, false], [100, 100], 100);
ok(T.noMoreAction() === true, '2 人全部 allin → 无人可再行动');

/* 3 人：2 人 allin + 1 人已跟平（bet == currentBet） */
setup([0, 0, 50, null, null, null], [true, true, true, false, false, false], [100, 100, 100], 100);
ok(T.noMoreAction() === true, '3 人：2 人 allin + 1 人已跟平 → 无人可再行动');

/* 3 人：2 人 allin + 1 人仍需跟注（bet < currentBet） */
setup([0, 0, 50, null, null, null], [true, true, true, false, false, false], [100, 100, 40], 100);
ok(T.noMoreAction() === false, '3 人：唯一有筹码者仍需跟注 → 尚有行动');

/* 3 人全部有筹码 → 仍有行动 */
setup([200, 200, 200, null, null, null], [true, true, true, false, false, false], [20, 20, 20], 20);
ok(T.noMoreAction() === false, '3 人均有筹码 → 尚有行动');

/* 2 人均有筹码（未 allin） */
setup([50, 50, null, null, null, null], [true, true, false, false, false, false], [20, 20], 20);
ok(T.noMoreAction() === false, '2 人均有筹码 → 尚有行动');

/* 只剩 1 人未弃牌 */
setup([50, 0, null, null, null, null], [true, false, false, false, false, false], [0, 0], 0);
ok(T.noMoreAction() === true, '仅 1 人未弃牌 → 无人可再行动');

console.log('--- 行为：revealAllInShowdown ---');
setup([0, 0, null, null, null, null], [true, true, false, false, false, false], [100, 100], 100);
T.players[0].hole = [{ r: 14, s: 0 }, { r: 14, s: 1 }];
T.players[1].hole = [{ r: 13, s: 2 }, { r: 12, s: 3 }];
T.players[0].showFlags = [false, false];
T.players[1].showFlags = [false, false];
const before = T.logLines().length;
const revealed = T.revealAllInShowdown();
ok(revealed === true, '亮牌执行成功（返回 true）');
ok(T.players[0].revealed === true && T.players[1].revealed === true, '双方手牌均被翻开');
const logged = T.logLines().slice(before);
ok(logged.some(l => l.text.indexOf('亮牌') >= 0), '日志记录"全部押注完成，亮牌"');
ok(logged.length === 2, '每位未弃牌玩家各记一条手牌日志');
const again = T.revealAllInShowdown();
ok(again === false, '重复调用不再重复记录（幂等）');
ok(T.logLines().length === before + 2, '日志条数未增长');

/* 弃牌玩家不参与亮牌 */
setup([0, 0, 0, null, null, null], [true, true, false, false, false, false], [100, 100, 0], 100);
T.players[0].hole = [{ r: 14, s: 0 }, { r: 14, s: 1 }];
T.players[1].hole = [{ r: 13, s: 2 }, { r: 12, s: 3 }];
T.players[2].hole = [{ r: 2, s: 0 }, { r: 7, s: 1 }];
T.players.forEach(p => { p.showFlags = [false, false]; p.showRevealed = [false, false]; });
T.revealAllInShowdown();
ok(T.players[2].revealed === false, '已弃牌玩家不被翻开');

/* 主动秀牌（showFlags）在亮牌前生效 */
setup([0, 0, null, null, null, null], [true, true, false, false, false, false], [100, 100], 100);
T.players[0].hole = [{ r: 14, s: 0 }, { r: 14, s: 1 }];
T.players[1].hole = [{ r: 13, s: 2 }, { r: 12, s: 3 }];
T.players[0].showFlags = [true, false];
T.players[0].showRevealed = [false, false];
T.players[1].showFlags = [false, false];
T.players[1].showRevealed = [false, false];
T.revealAllInShowdown();
ok(T.players[0].showRevealed[0] === true, '玩家标记的秀牌在亮牌流程中先翻出（showRevealed[0]）');

console.log('\n=== 全下亮牌测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
