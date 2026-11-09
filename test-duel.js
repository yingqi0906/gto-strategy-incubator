/* ⚡ 超能力单挑 测试
   1) 无头 UI / 源码：主菜单入口、座位超能力选择、超能力A透视、超能力B预览
   2) core：estimateWin 的 knownOpps / postflopStrategy 的 knownBoard 与 knownOpps
   3) 服务器 E2E：2 人房容量、duel 标记、按超能力脱敏（A 保留对手手牌 / B 独享 peek）、超能力消息中继 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };

/* ================= 第一部分：无头 UI ================= */
async function uiTests() {
  console.log('--- 无头 UI / 源码：超能力单挑 ---');
  class FakeEl {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this._class = new Set();
      this.style = {};
      this.parentNode = null;
      this.textContent = '';
      this._innerHTML = '';
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
  const byId = {};
  global.document = {
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener() {}
  };
  global.window = global;
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.PokerCore = require('./core.js');
  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const T = global.window.__PokerTest;
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  /* --- 源码结构 --- */
  const menu = html.slice(html.indexOf('id="lobby-select"'), html.indexOf('id="lobby-host"'));
  ok(/id="btn-duel"/.test(menu), '主菜单新增「超能力单挑」按钮');
  ok(/超能力单挑/.test(menu), '按钮文案标明超能力单挑');
  const hostLobby = html.slice(html.indexOf('id="lobby-host"'), html.indexOf('id="lobby-client"'));
  ok(/id="duel-legend"/.test(hostLobby), '座位选择界面含超能力说明（duel-legend）');
  ok(/超能力 A/.test(hostLobby) && /超能力 B/.test(hostLobby), '说明中列出超能力 A / B');
  const cliLobby = html.slice(html.indexOf('id="lobby-client"'), html.indexOf('id="overlay-results"'));
  ok(/id="client-power"/.test(cliLobby), '客机座位界面含超能力选择');
  ok(/#board \.card\.peek/.test(html), '超能力B 预览牌有独立样式（.card.peek）');
  ok(/id="peek-tag"/.test(html), '牌桌显示超能力B 提示标签');
  ok(/\.pw-badge/.test(html), '座位显示超能力徽标');
  ok(/mode === 'duel'/.test(serverSrc) && /capacity = duel \? 2 : MP_SEATS/.test(serverSrc), '服务端支持 2 人超能力单挑房');
  ok(/myPower === 'A'/.test(serverSrc) && /myPower !== 'B'/.test(serverSrc),
    '服务端按超能力脱敏（A 保留对手手牌 / 非 B 清空 peek）');

  /* --- 超能力A：透视对手手牌 --- */
  const D = T.duel;
  const P = T.players;
  P[0].hole = [{ r: 14, s: 0, id: 'A♠' }, { r: 14, s: 1, id: 'A♥' }];
  P[1].hole = [{ r: 13, s: 2, id: 'K♦' }, { r: 12, s: 3, id: 'Q♣' }];
  P[1].revealed = false; P[1].showRevealed = [false, false]; P[1].seatType = 'ai';
  D.setDuel(true);
  ok(D.holeVisible(P[0], 0) === true, '自己的手牌始终可见');
  D.setMyPower(null);
  ok(D.holeVisible(P[1], 0) === false, '无超能力时对方手牌不可见');
  D.setMyPower('A');
  ok(D.holeVisible(P[1], 0) && D.holeVisible(P[1], 1), '超能力A：对方两张手牌均可见（以牌面显示）');
  D.setMyPower('B');
  ok(!D.holeVisible(P[1], 0), '超能力B 看不到对方手牌');
  D.setDuel(false);
  D.setMyPower('A');
  ok(!D.holeVisible(P[1], 0), '非超能力单挑模式下超能力不生效（不影响多人模式）');

  /* --- 超能力B：提前看见转牌/河牌 --- */
  D.setDuel(true);
  const c = (n) => ({ r: n, s: 0, id: 'C' + n });
  // 牌堆弹出顺序为从末尾取：deck[len-1] 先发
  let deck = [c(1), c(2), c(3), c(4), c(5)]; // 5=flop1 4=flop2 3=flop3 2=turn 1=river
  D.setDeck(deck); D.setBoard([]);
  let pk = D.computePeek();
  ok(pk.turn && pk.turn.id === 'C2' && pk.river && pk.river.id === 'C1',
    '翻牌前即可算出转牌与河牌（对应牌堆中第 4、5 张）');
  D.setBoard([c(5), c(4), c(3)]);
  D.setDeck([c(1), c(2)]);
  pk = D.computePeek();
  ok(pk.turn && pk.turn.id === 'C2' && pk.river && pk.river.id === 'C1', '翻牌后仍能预览转牌与河牌');
  D.setBoard([c(5), c(4), c(3), c(2)]);
  D.setDeck([c(1)]);
  pk = D.computePeek();
  ok(pk.turn === null && pk.river && pk.river.id === 'C1', '转牌已发出后不再重复预览转牌');
  D.setBoard([c(5), c(4), c(3), c(2), c(1)]);
  D.setDeck([]);
  pk = D.computePeek();
  ok(!pk.turn && !pk.river, '河牌发出后无预览');
  D.setDuel(false);
  D.setDeck([c(1)]); D.setBoard([]);
  ok(!D.computePeek().turn, '非超能力单挑模式不产生预览');

  /* 集成校验：预览的转牌/河牌必须与引擎真实发出的牌完全一致
     （引擎顺序：2 人各 2 张手牌 → 翻牌 3 张 → 转牌 1 张 → 河牌 1 张，均为 deck.pop()；
       预览在"手牌已发完、公共牌未发"的牌堆状态下计算） */
  const C0 = require('./core.js');
  const realDeck = C0.shuffle(C0.makeDeck());
  const sim = realDeck.slice();
  sim.pop(); sim.pop(); sim.pop(); sim.pop();                 // 两名玩家各两张手牌
  D.setDuel(true); D.setBoard([]); D.setDeck(sim.slice());
  const pkReal = D.computePeek();
  const flopSim = [sim.pop(), sim.pop(), sim.pop()];          // 翻牌
  const afterFlop = sim.slice();                              // 翻牌后的牌堆状态
  const turnSim = sim.pop();                                  // 转牌
  const riverSim = sim.pop();                                 // 河牌
  ok(pkReal.turn && pkReal.turn.id === turnSim.id && pkReal.river && pkReal.river.id === riverSim.id,
    '预览的转牌/河牌与真实发出的牌完全一致（预览 ' + (pkReal.turn && pkReal.turn.id) + '/' + (pkReal.river && pkReal.river.id) +
    ' vs 实发 ' + turnSim.id + '/' + riverSim.id + '）');
  D.setBoard(flopSim); D.setDeck(afterFlop);
  const pk2 = D.computePeek();
  ok(pk2.turn.id === turnSim.id && pk2.river.id === riverSim.id, '翻牌发出后预览仍锁定同一对转牌/河牌');

  /* --- 快照内容 --- */
  D.setDuel(true);
  D.setPower(0, 'A'); D.setPower(1, 'B');
  D.setBoard([]); D.setDeck([c(9), c(8), c(7), c(6), c(5)]);
  const snap = D.buildSnapshot();
  ok(snap.duel === true, '快照带 duel 标记');
  ok(Array.isArray(snap.powers) && snap.powers[0] === 'A' && snap.powers[1] === 'B', '快照带各座位超能力');
  ok(snap.peek && snap.peek.turn && snap.peek.river, '快照带转牌/河牌预览（由服务端按持有者下发）');
  D.setPower(0, null); D.setPower(1, null); D.setDuel(false);
  ok(D.powerOf(0) === null, '超能力可取消');
  /* 座位选择控件：选择自己座位的超能力应当本机立即生效（并再次点击取消） */
  D.setDuel(true); D.setMyPower(null);
  D.setSeatPower(0, 'A');
  ok(D.powerOf(0) === 'A' && D.myPower() === 'A', '座位界面选择超能力A → 本机立即生效');
  ok(D.holeVisible(P[1], 0), '选择超能力A 后对方手牌立即变为可见');
  D.setSeatPower(0, null);
  ok(D.powerOf(0) === null && D.myPower() === null, '再次点击取消超能力');
  ok(!D.holeVisible(P[1], 0), '取消后对方手牌恢复隐藏');

  /* --- 实战校验：本地 2 人（AI vs AI）单挑真跑牌 ---
     跨手牌的"预览 = 实发"由上面的牌堆顺序集成测试确定性验证；
     这里校验实战中预览始终成立：不为任何已发牌、且与牌堆位置严格对应 */
  const realSetTimeout = global.setTimeout;
  global.setTimeout = function (fn) { return setImmediate(fn); }; // 加速牌局（AI 思考延时）
  D.setDuel(true); D.setMyPower('B');
  D.seedHeadsUp('B', 'A');
  /* 单挑盲注徽章：按钮位即小盲 → 同一座位同时亮 D 与 S（flex 容器自动排开），另一座位亮 B */
  {
    const huBl = T.blindSeats(), huBtn = T.buttonIdx();
    const huHas = cls => T.players.slice(0, 2).map((p, i) => (p.seatEl && p.seatEl.classList.contains(cls)) ? i : -1).filter(i => i >= 0);
    ok(huBl.sb === huBtn, '单挑：小盲位 = 按钮位（sb=' + huBl.sb + '，button=' + huBtn + '）');
    ok(huBl.bb >= 0 && huBl.bb !== huBl.sb, '单挑：大盲落在另一座位（bb=' + huBl.bb + '）');
    ok(JSON.stringify(huHas('has-sb')) === JSON.stringify([huBl.sb]), '单挑：S 徽章亮在小盲位');
    ok(JSON.stringify(huHas('has-bb')) === JSON.stringify([huBl.bb]), '单挑：B 徽章亮在大盲位');
    ok(JSON.stringify(huHas('has-button')) === JSON.stringify([huBtn]), '单挑：D 徽章亮在按钮位（与 S 同座不冲突）');
  }
  let sampled = 0, mapOk = 0, unseenOk = 0, sawTurn = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    await new Promise(r => realSetTimeout(r, 2));
    const bw = D.boardNow(), pk = D.peekNow(), top5 = D.deckTop(5), hn = D.handNoNow();
    if (bw.length >= 4) sawTurn = true;
    if (bw.length !== 0 || !pk || !pk.turn || !pk.river || top5.length < 5) continue;
    sampled++;
    /* top5 = deck[len-5..len-1] → [0]=河牌 [1]=转牌（牌堆从末尾弹出） */
    if (top5[1].id === pk.turn.id && top5[0].id === pk.river.id) mapOk++;
    const used = {};
    T.players.forEach(function (p) { (p.hole || []).forEach(function (c) { used[c.id] = true; }); });
    bw.forEach(function (c) { used[c.id] = true; });
    if (!used[pk.turn.id] && !used[pk.river.id]) unseenOk++;
  }
  const handsRun = D.handNoNow();
  global.setTimeout = realSetTimeout;
  T.exitToMenu(); // 中止后台牌局，避免影响后续服务器测试
  ok(handsRun >= 5, '2 人超能力单挑牌局可连续推进（进行到第 ' + handsRun + ' 局）');
  ok(sawTurn, '实战中牌局正常发到转牌（单挑引擎运行正常）');
  ok(sampled > 5, '实战中持续产生转牌/河牌预览（采样 ' + sampled + ' 次）');
  ok(sampled > 0 && mapOk === sampled, '预览牌与牌堆位置严格对应（' + mapOk + '/' + sampled + '）');
  ok(sampled > 0 && unseenOk === sampled, '预览的转牌/河牌均不属于任何已发牌（确为未发出的牌，' + unseenOk + '/' + sampled + '）');
}

/* ================= 第二部分：core 已知信息 ================= */
function coreTests() {
  console.log('--- core：AI 使用超能力信息 ---');
  const C = require('./core.js');
  const card = (r, s, id) => ({ r: r, s: s, id: id });
  const AA = [card(14, 0, 'As'), card(14, 1, 'Ah')];
  const junk = [card(7, 2, '7d'), card(2, 3, '2c')];

  const eKnown = C.estimateWin(AA, [], 1, 400, null, [junk]);
  ok(eKnown > 0.78, '已知对手为 72o 时 AA 胜率 > 78%（实测 ' + eKnown.toFixed(3) + '）');
  const eBehind = C.estimateWin(junk, [], 1, 400, null, [AA]);
  ok(eBehind < 0.22, '72o 对已知 AA 胜率 < 22%（实测 ' + eBehind.toFixed(3) + '）');
  /* 确定性场景：对手已知成顺，AA 在成顺面上胜率归零（对比盲估仍有一战之力） */
  const dryBoard = [card(5, 0, '5c'), card(6, 1, '6d'), card(8, 2, '8h'), card(9, 3, '9s'), card(2, 0, '2d')];
  const straight = [card(7, 0, '7c'), card(7, 1, '7d')];
  const eNuts = C.estimateWin(AA, dryBoard, 1, 300, null, [straight]);
  const eNutsBlind = C.estimateWin(AA, dryBoard, 1, 300, null, null);
  ok(eNuts < 0.05, '已知对手成顺时 AA 胜率归零（实测 ' + eNuts.toFixed(3) + '）');
  ok(eNutsBlind > 0.3, '同一牌面盲估时 AA 仍有可观胜率（实测 ' + eNutsBlind.toFixed(3) + '）');

  /* 翻前：已知对手底牌时的利用性修正（被碾压的牌不再跟注、领先的牌不再弃牌） */
  const pre = (extra) => Object.assign({
    hole: [card(13, 0, 'Ks'), card(2, 1, '2h')], community: [], nOpp: 1,
    toCall: 2.5, pot: 4, chips: 96, bb: 1, bet: 1, currentBet: 2.5,
    posName: 'BTN', pf: { raises: 1, opener: 'UTG', lastSize: 2.5, callers: 0, posName: 'BTN' }
  }, extra || {});
  const count = (fn, n) => {
    const t = { fold: 0, call: 0, raise: 0 };
    for (let i = 0; i < n; i++) { const a = fn(); t[a.type] = (t[a.type] || 0) + 1; }
    return t;
  };
  const base = count(() => C.aiDecide(pre()), 60);
  const known = count(() => C.aiDecide(pre({ knownOpps: [junk] })), 60); // 对手仅 72o → 应入池
  ok(base.fold > 0, 'K2o 面对 UTG 加注：默认会弃牌（' + base.fold + '/60）');
  // K2o vs 已知 72o 只有约 6 成胜率，且蒙特卡洛有抖动 → 允许极少量弃牌（原为 ===0，约 5% 概率误报）
  ok(known.fold <= 2 && (known.call + known.raise) >= 58,
    '超能力A 已知对手 72o：基本不再弃牌（弃 ' + known.fold + '/60）');
  const crushed = count(() => C.aiDecide(pre({ knownOpps: [AA] })), 60); // 对手 AA → 直接放弃
  ok(crushed.fold === 60, '超能力A 已知对手 AA：被碾压时全部弃牌');

  /* 翻后：已知未来公共牌（超能力B） */
  const nutDraw = [card(14, 2, 'Ah'), card(13, 2, 'Kh')];   // 坚果同花听牌 + 两张超牌
  const weakDraw = [card(5, 2, '5h'), card(4, 2, '4h')];    // 小同花听牌
  const gutshot = [card(11, 0, 'Jc'), card(10, 1, 'Td')];   // 卡顺（无同花）
  const air = [card(3, 0, '3c'), card(2, 1, '2d')];         // 空气
  const flop = [card(12, 2, 'Qh'), card(7, 2, '7h'), card(2, 0, '2c')];
  // 注意 pot 按页面口径传入：potTotal() 已含对手这一注（底池 100 + 下注 200 = 300）。
  // 2 倍超池一般出自很强的范围，因此用 oppPctls 建模（5% 强范围），否则等于假设对手拿随机牌。
  const post = (extra) => Object.assign({
    hole: nutDraw, community: flop, nOpp: 1, toCall: 200, pot: 300, chips: 200,
    bb: 1, currentBet: 200, bet: 0, posName: 'BTN', pf: {}
  }, extra || {});
  const strong = { oppPctls: [0.05] };
  const gutInfo = count(() => C.aiDecide(post(Object.assign({ hole: gutshot }, strong))), 120);
  const weakInfo = count(() => C.aiDecide(post(Object.assign({ hole: weakDraw }, strong))), 120);
  const airInfo = count(() => C.aiDecide(post(Object.assign({ hole: air }, strong))), 120);
  const nutInfo = count(() => C.aiDecide(post(strong)), 120);
  const goodBoard = count(() => C.aiDecide(post({ knownBoard: [card(11, 2, 'Jh'), card(3, 0, '3d')] })), 120);
  ok(gutInfo.fold >= 90, '无超能力：卡顺面对 2 倍超池 + 强范围 → 多数弃牌（' + gutInfo.fold + '/120）');
  ok(airInfo.fold >= 90, '无超能力：空气面对 2 倍超池 + 强范围 → 多数弃牌（' + airInfo.fold + '/120）');
  // 小同花听牌 vs 2 倍超池处在赔率边界（约 40% 胜率 vs 40% 需要），应当混合而非一边倒
  ok(weakInfo.fold > 20 && weakInfo.call > 20,
    '小同花听牌面对 2 倍超池 + 强范围：在赔率边界混合（弃 ' + weakInfo.fold + ' / 跟 ' + weakInfo.call + '）');
  ok(nutInfo.fold < 60, '坚果同花听牌 + 两张超牌：不盲目弃牌（弃牌 ' + nutInfo.fold + '/120）');
  ok(goodBoard.fold === 0, '超能力B 已知河牌成同花：绝不弃牌（全部跟注/加注）');
}

/* ================= 第三部分：服务器 E2E ================= */
async function serverTests() {
  console.log('--- 服务器：2 人房与超能力脱敏 ---');
  const PORT = 18794;
  const BASE = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', d => srvLog += d);
  srv.stderr.on('data', d => srvLog += d);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { await fetch(BASE + '/'); up = true; } catch (e) { await sleep(100); }
  }
  ok(up, '服务器启动');
  if (!up) { console.error(srvLog); return; }
  const post = async (p, body) => (await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json();
  const poll = async (room, id, seq) =>
    (await fetch(BASE + '/api/poll?room=' + room + '&id=' + id + '&seq=' + (seq || 0))).json();

  /* 2 人房容量 */
  const duel = await post('/api/create', { name: '主机', mode: 'duel' });
  ok(duel.ok && duel.duel === true && duel.seat >= 0 && duel.seat <= 1, '创建超能力单挑房（2 座，返回 duel 标记）');
  const c1 = await post('/api/join', { room: duel.room, name: '客机一' });
  ok(c1.ok && c1.duel === true && c1.seat >= 0 && c1.seat <= 1 && c1.seat !== duel.seat, '第 2 位玩家入座另一座位');
  const c2 = await post('/api/join', { room: duel.room, name: '第三人' });
  ok(!c2.ok && /2/.test(c2.err || ''), '超能力单挑房满员后拒绝加入：' + c2.err);

  /* 多人房不受影响 */
  const multi = await post('/api/create', { name: '主机2' });
  const m1 = await post('/api/join', { room: multi.room, name: 'a' });
  const m2 = await post('/api/join', { room: multi.room, name: 'b' });
  ok(multi.ok && !multi.duel && m1.ok && m2.ok, '普通多人房仍为 6 座（duel=false）');

  /* 超能力脱敏：按真实座位号构造快照（主机/客机座位由服务器随机分配） */
  const HOST_I = duel.seat, CLI_I = c1.seat;
  ok(HOST_I !== CLI_I, '主机与客机分处两个不同座位');
  const cards = (n) => [{ r: n, s: 0, id: 'x' + n }, { r: n, s: 1, id: 'y' + n }];
  const mkSnap = (hostPw, cliPw) => {
    const seats = [];
    seats[HOST_I] = { name: '主机', type: 'host', chips: 100, hole: cards(14), revealed: false, showRevealed: [false, false] };
    seats[CLI_I] = { name: '客机一', type: 'client', chips: 100, hole: cards(13), revealed: false, showRevealed: [false, false] };
    const powers = [];
    powers[HOST_I] = hostPw; powers[CLI_I] = cliPw;
    return {
      phase: 'playing', handNo: 1, duel: true, powers: powers,
      peek: { turn: { r: 5, s: 0, id: 'T' }, river: { r: 6, s: 0, id: 'R' } },
      seats: seats
    };
  };
  /* 客机无超能力：看不到主机手牌、也无预览 */
  await post('/api/msg', { room: duel.room, id: duel.id, msg: { type: 'state', snap: mkSnap(null, null) } });
  let got = await poll(duel.room, c1.id, 0);
  let s0 = got.msgs.filter(m => m.type === 'state').pop();
  ok(s0 && s0.snap.seats[HOST_I].hole.length === 0, '无超能力：对手手牌被脱敏（看不到）');
  ok(s0 && s0.snap.seats[CLI_I].hole.length === 2, '自己的手牌照常下发');
  ok(s0 && !s0.snap.peek.turn, '无超能力：转牌/河牌预览被清空');

  /* 客机持超能力A：应收到主机手牌 */
  await post('/api/msg', { room: duel.room, id: duel.id, msg: { type: 'state', snap: mkSnap(null, 'A') } });
  got = await poll(duel.room, c1.id, got.seq);
  s0 = got.msgs.filter(m => m.type === 'state').pop();
  ok(s0 && s0.snap.seats[HOST_I].hole.length === 2 && s0.snap.seats[HOST_I].hole[0].id === 'x14',
    '超能力A：客机收到对手（主机）两张手牌 → 可直接以牌面显示');
  ok(s0 && !s0.snap.peek.turn, '超能力A 不获得转牌/河牌预览');

  /* 客机持超能力B：应收到预览、但看不到对手手牌 */
  await post('/api/msg', { room: duel.room, id: duel.id, msg: { type: 'state', snap: mkSnap(null, 'B') } });
  got = await poll(duel.room, c1.id, got.seq);
  s0 = got.msgs.filter(m => m.type === 'state').pop();
  ok(s0 && s0.snap.peek.turn && s0.snap.peek.turn.id === 'T' && s0.snap.peek.river.id === 'R',
    '超能力B：客机收到转牌与河牌预览');
  ok(s0 && s0.snap.seats[HOST_I].hole.length === 0, '超能力B：仍看不到对手手牌');
  ok(s0 && s0.snap.seats[HOST_I].name === '主机', '座位其它信息照常下发（界面与多人模式一致）');

  /* 主机持超能力A：客机（无超能力）看不到主机手牌 */
  await post('/api/msg', { room: duel.room, id: duel.id, msg: { type: 'state', snap: mkSnap('A', null) } });
  got = await poll(duel.room, c1.id, got.seq);
  s0 = got.msgs.filter(m => m.type === 'state').pop();
  ok(s0 && s0.snap.seats[HOST_I].hole.length === 0, '主机持超能力A 时，客机依然看不到主机手牌（单向透视）');

  /* 超能力消息中继：客机选超能力 → 主机收到 */
  await post('/api/msg', { room: duel.room, id: c1.id, msg: { type: 'power', action: { power: 'B' } } });
  const hb = await poll(duel.room, duel.id, 0);
  const pw = hb.msgs.filter(m => m.type === 'power').pop();
  ok(pw && pw.seat === c1.seat && pw.action && pw.action.power === 'B', '客机超能力选择经服务器中继到主机');

  srv.kill();
  await sleep(150);
}

(async function main() {
  await uiTests();
  coreTests();
  await serverTests();
  console.log('\n=== 超能力单挑测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
