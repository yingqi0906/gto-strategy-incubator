/* 1) 鱿鱼标记动画：获得标记时 🦑 从桌心飞向该玩家头像（飞行期间徽章暂缓显示，落位后出现）；
      客机按快照新增的标记同样播放动画（首个快照只做基线，不为旧标记补播）
   2) 局间秀牌：一局结束到下一局开始之间的等待期，点按手牌可直接亮牌 / 收起（全员立即可见） */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.onclick = null;
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
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  focus() {}
}

(async function main() {
  console.log('--- 无头 UI：鱿鱼标记动画 + 局间秀牌 ---');
  const byId = {};
  const docListeners = {};
  global.document = {
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); }
  };
  global.window = global;
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  global.PokerCore = require('./core.js');
  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  eval(m[1]);
  const T = global.window.__PokerTest;
  const P = T.players;
  const MP = (function () { // 通过 hooks 间接读取 MP（mySeat 用 setMode 控制）
    return {
      mySeat: 0,
      set(seat, mode, name) {
        T.client.setMode(mode || 'host', seat, name);
        this.mySeat = seat;
      }
    };
  })();

  /* ---------- 源码级接线 ---------- */
  ok(/\.fly-squid\s*\{[^}]*position:\s*absolute/.test(html), 'CSS：🦑 飞行元素（绝对定位、居中变换）');
  ok(/function animSquidToSeat\(seatIdx\)/.test(html), '实现 animSquidToSeat（桌心 → 玩家）');
  ok(/querySelector\('\.avatar'\)/.test(html), '动画终点优先取玩家"头像"元素');
  ok(/squidFlyAward\(seat\);\s*\/\/ 🦑 从桌心飞向该玩家头像/.test(html), '发标记时启动 🦑 飞行动画');
  ok(/squidAnimSeat !== p\.idx \? '<span class="sq-badge">/.test(html), '飞行期间暂缓显示徽章（落位后出现）');
  ok(/if \(squid\.markers\[i\] && !prevMarkers\[i\]\) squidFlyAward\(i\);/.test(html), '客机按快照新增标记播放动画');
  ok(/if \(hadSquidSnap && squid\.active && prevMarkers\.length === squid\.markers\.length\)/.test(html), '首个快照只作基线（不为既有标记补播动画）');
  ok(/handSettling = false; \/\/ 新一局开始/.test(html), 'playHand 开局复位局间等待状态');
  ok(/function finishFoldWin\(\)[\s\S]{0,200}?handSettling = true;/.test(html), '弃牌获胜路径进入局间等待状态');
  ok(/async function showdown\(\)[\s\S]{0,200}?handSettling = true;/.test(html), '摊牌路径进入局间等待状态');
  ok(/async function showHandEnd\(lines\)[\s\S]{0,200}?handSettling = true;/.test(html), '等待期（showHandEnd）置位局间等待状态');
  ok(/const settleNow = handSettling && !me\.revealed;/.test(html), '本机：局间等待点按手牌直接亮牌');
  ok(/if \(handSettling && !sp\.revealed/.test(html), '主机：客机局间秀牌 → 立即翻开给全桌');
  ok(/if \(handSettling && !me\.revealed\) \{\s*const sr = me\.showRevealed/.test(html), '点按判定改用 showRevealed（避免与本手遗留 showFlags 冲突）');

  /* ---------- 场景：3 人桌（主机 + 客机 + AI） ---------- */
  T.client.setMode('host', 0, '主机');
  P.forEach(p => { p.seatType = null; p.name = ''; p.chips = 0; p.brought = 0; p.joining = false; p.hole = []; });
  P[0].seatType = 'host'; P[0].name = '主机'; P[0].chips = 100; P[0].brought = 100; P[0].hole = [{ r: 14, s: 0, id: 'A♠' }, { r: 13, s: 2, id: 'K♦' }];
  P[1].seatType = 'client'; P[1].name = '客机一'; P[1].chips = 100; P[1].brought = 100; P[1].hole = [{ r: 2, s: 3, id: '2♣' }, { r: 7, s: 2, id: '7♦' }];
  P[2].seatType = 'ai'; P[2].name = 'AI测试'; P[2].chips = 100; P[2].brought = 100; P[2].hole = [{ r: 9, s: 1, id: '9♥' }, { r: 10, s: 0, id: '10♠' }];

  const nameHtml = i => P[i].seatEl.querySelector('.name').innerHTML;
  const hasBadge = i => nameHtml(i).indexOf('sq-badge') >= 0;

  /* ---------- 鱿鱼标记动画 ---------- */
  T.squid.reset();
  T.squid.setActive(true, 5);
  ok(T.squid.animSeat() === -1, '初始：无标记飞行动画');
  T.squid.award(0);
  ok(T.squid.animSeat() === 0, '发标记瞬间进入"飞行中"（座位 0）');
  ok(!hasBadge(0), '飞行期间该玩家名称旁不显示徽章');
  ok(T.duel.buildSnapshot().squid.markers[0] === true, '标记状态仍立即写入快照（不因动画延迟同步）');
  await sleep(5);
  ok(T.squid.animSeat() === -1 && hasBadge(0), '动画落位后 🦑 徽章出现在该玩家名称旁');
  ok(!hasBadge(1) && !hasBadge(2), '其他玩家不受影响');

  const logLen = T.logLines().length;
  T.squid.award(0);
  ok(T.squid.animSeat() === -1 && T.logLines().length === logLen, '已标记玩家再次收池：不重复发标记、不重复播放动画');

  T.squid.award(2);
  ok(T.squid.animSeat() === 2 && !hasBadge(2), '另一名玩家获得标记时同样播放动画');
  await sleep(5);
  ok(hasBadge(2), '第二名玩家的徽章在动画落位后显示');

  T.squid.reset();
  ok(T.squid.animSeat() === -1, '退出牌局 / 重置：在途动画状态清理');

  /* ---------- 局间秀牌 ---------- */
  T.setHandSettling(false);
  ok(T.handSettling() === false, '默认不在局间等待状态');
  P[0].showFlags = [false, false]; P[0].showRevealed = [false, false];
  T.toggleShowCard(0, true);
  ok(P[0].showFlags[0] === true && P[0].showRevealed[0] === false, '手牌进行中：点按仅标记为待秀牌（本手结束才翻开）');
  T.toggleShowCard(0, false);
  ok(P[0].showFlags[0] === false, '手牌进行中：再点一下取消待秀牌');

  T.setHandSettling(true);
  P[0].showFlags = [false, false]; P[0].showRevealed = [false, false];
  const logLen2 = T.logLines().length;
  T.toggleShowCard(0, true);
  ok(P[0].showRevealed[0] === true, '局间等待：点按手牌立即亮牌');
  ok(T.logLines().length > logLen2 && T.logLines().some(l => l.text.indexOf('秀牌') >= 0), '局间亮牌写入牌局日志');
  MP.set(1); // 换到对手座位视角（用 mySeat 判定可见性）
  ok(T.duel.holeVisible(P[0], 0) === true && T.duel.holeVisible(P[0], 1) === false, '对手视角：亮出的那张可见、另一张仍为牌背');
  MP.set(0);
  T.toggleShowCard(0, false);
  ok(P[0].showRevealed[0] === false, '再点一下收起（取消亮牌）');
  MP.set(1);
  ok(T.duel.holeVisible(P[0], 0) === false, '收起后对手不再可见');
  MP.set(0);

  /* 点按事件（真实 pointerup 路径）：局间等待应用 showRevealed 为准 */
  P[0].showFlags = [true, false]; // 模拟上手遗留的秀牌标记
  P[0].showRevealed = [false, false];
  const cardEl = { getAttribute: k => (k === 'data-hcard' ? '0' : null), parentNode: null };
  const fireTap = () => (docListeners.pointerup || []).forEach(fn => fn({ target: cardEl }));
  ok((docListeners.pointerup || []).length > 0, '已监听手牌点按事件（pointerup）');
  fireTap();
  ok(P[0].showRevealed[0] === true, '局间等待：点按手牌 → 亮牌（不受本手遗留 showFlags 影响）');
  fireTap();
  ok(P[0].showRevealed[0] === false, '局间等待：再次点按 → 收起亮牌');

  T.setHandSettling(false);
  P[0].showFlags = [false, false]; P[0].showRevealed = [false, false];
  fireTap();
  ok(P[0].showFlags[0] === true && P[0].showRevealed[0] === false, '非局间等待：点按仍走"本手结束翻开"逻辑');

  /* 主机应用客机局间秀牌 */
  T.setHandSettling(true);
  P[1].showFlags = [false, false]; P[1].showRevealed = [false, false];
  T.client.hostAction({ type: 'action', seat: 1, action: { type: 'show', flags: [true, false] }, seq: 1 });
  ok(P[1].showFlags[0] === true && P[1].showRevealed[0] === true, '主机收到客机局间秀牌 → 立即亮牌（并广播全桌）');
  ok(T.logLines().some(l => l.text.indexOf('客机一') >= 0 && l.text.indexOf('秀牌') >= 0), '客机局间秀牌由主机记录日志');
  T.setHandSettling(false);
  P[1].showFlags = [false, false]; P[1].showRevealed = [false, false];
  T.client.hostAction({ type: 'action', seat: 1, action: { type: 'show', flags: [true, false] }, seq: 2 });
  ok(P[1].showFlags[0] === true && P[1].showRevealed[0] === false, '非局间等待：客机秀牌仍延迟到本手结束翻开');

  /* ---------- 局间秀牌的视觉状态（渲染层，2026-10-26） ----------
     需求：局间亮牌后自己看这张牌应恢复常规牌面（不灰不透明），并保留眼睛 + 高亮框；
     另一张没亮的必须继续半透明（此前 anyShown 会把整组灰态摘掉，两张一起变亮）。 */
  T.client.setMode('host', 0, '主机');
  P.forEach(p => {
    p.inHand = false; p.revealed = false;
    p.showFlags = [false, false]; p.showRevealed = [false, false];
  });
  P[0].hole = [{ r: 5, s: 3, id: '5♣' }, { r: 9, s: 2, id: '9♦' }]; // 非优质起手牌（避免闪光特效应干扰）
  T.duel.setHandNo(7);
  T.setHandSettling(true);
  const hcOf = () => P[0].seatEl.querySelector('.hole-cards');
  const eyesOf = el => el.children.filter(x => x.classList && x.classList.contains('show-eye')).length;

  T.debug.renderSeat(0);
  ok(hcOf().classList.contains('grayed'), '弃牌未亮：手牌整组灰化（半透明）');
  ok(hcOf().children.length === 2 && eyesOf(hcOf().children[0]) === 0, '未亮牌时没有眼睛图标');

  P[0].showFlags[0] = true; P[0].showRevealed[0] = true;
  T.debug.renderSeat(0);
  const cv = hcOf().children;
  ok(cv.length === 2, '两张手牌均正常渲染');
  ok(cv[0].classList.contains('shown') && !cv[1].classList.contains('shown'),
    '只有亮出的那一张恢复常规牌面（另一张不跟着一起变亮）');
  ok(hcOf().classList.contains('grayed'), '父级灰态保留（逐张用 .shown 覆盖，而非整组摘掉）');
  ok(cv[0].classList.contains('showing'), '亮出的那张带高亮框（与待秀牌一致的视觉）');
  ok(eyesOf(cv[0]) === 1, '亮出的那张显示眼睛图标（提示可再点一下收起）');
  ok(!cv[1].classList.contains('showing') && eyesOf(cv[1]) === 0, '未亮出的另一张无高亮框 / 无眼睛');

  /* 本手进行中的待秀标记：同样是眼睛 + 高亮框，且牌面不再灰化 */
  P[0].inHand = true; P[0].showFlags = [true, false]; P[0].showRevealed = [false, false];
  T.debug.renderSeat(0);
  const cv2 = hcOf().children;
  ok(cv2[0].classList.contains('showing') && eyesOf(cv2[0]) === 1, '本手进行中的待秀牌：眼睛 + 高亮框');
  ok(cv2[0].classList.contains('shown') && !cv2[1].classList.contains('shown'),
    '待秀的那张不灰化，另一张不受影响');

  /* 摊牌全亮（revealed）后眼睛应消失，避免误以为还能操作 */
  P[0].inHand = true; P[0].revealed = true; P[0].showFlags = [true, true]; P[0].showRevealed = [true, true];
  T.debug.renderSeat(0);
  ok(hcOf().children.every(x => !x.classList.contains('showing') && eyesOf(x) === 0),
    '全员摊牌后不再显示眼睛 / 高亮框');
  ok(!hcOf().classList.contains('grayed'), '摊牌全亮：手牌不灰化');

  T.setHandSettling(false);
  T.duel.setHandNo(0);
  P.forEach(p => { p.revealed = false; p.showFlags = [false, false]; p.showRevealed = [false, false]; });

  console.log('\n=== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
