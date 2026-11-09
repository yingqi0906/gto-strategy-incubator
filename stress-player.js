/* 玩家视角联机场景测试（真实 server.js + 真实主机引擎 + HTTP 模拟客机）
 *
 * 目的：像真人一样"进房 → 入座 → 打牌 → 退出/被踢/掉线 → 重进"，找出玩家实际会踩到的问题。
 * 与既有套件的分工（不重复）：
 *   - test-mp / stress-6p：基础联机、聊天、守恒
 *   - test-client-resilience：手机切屏、动作重发、超时除名重连
 *   - test-join-dedup / test-latejoin：重复加入、迟到入座
 *   本套件专注：大厅主动退出、主机踢人（含踢后座位释放与"踢了又回来"）、
 *                游戏中主动退出（=弃牌，钱留底池）、退出后同名继承战绩、非我回合越权动作、
 *                联机秀牌脱敏、联机买入、动态人数下牌局不卡死、主机解散房间。
 *
 * 守恒口径说明：`chips + 桌上未收下注 == brought` 仅在"无人带钱离场"时成立。
 *   有人中途退出时，其筹码被清零、留在底池的钱归在座玩家 —— 因此在座合计会
 *   正好多出"退出者留在底池的贡献"，这是正确行为（本套件按此口径断言）。
 *
 * 用法：node stress-player.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18990;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? ' | ' + extra : '')); console.error('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

/* ---------- 无头 DOM ---------- */
class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div'; this.children = []; this._class = new Set();
    this.style = {}; this.parentNode = null; this.textContent = '';
    this._innerHTML = ''; this.disabled = false; this.value = '';
    this.min = 0; this.max = 0; this.step = 1; this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null; this._qs = {}; this._listeners = {};
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
  contains() { return false; }
}
const byId = {};
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(tag) { return new FakeEl(tag); },
  addEventListener() {}, body: new FakeEl('body'), documentElement: new FakeEl('html'),
  hidden: false
};
global.window = global;
global.location = { host: 'localhost:' + PORT, origin: BASE, href: BASE + '/', search: '', protocol: 'http:', pathname: '/' };
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.sessionStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.alert = function () {};
global.PokerCore = require('./core.js');

const realFetch = fetch;
global.fetch = function (u, o) {
  if (typeof u === 'string' && u[0] === '/') u = BASE + u;
  return realFetch(u, o);
};

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

const T = global.window.__PokerTest;
const P = T.players;
const MPX = T.mp;
const D = T.debug;

let ROOM = '', HOST = null, hostSeq = 0;
const ALL_CLIENTS = [];      // 全部模拟客机（含后加入者），供 pump 自动应答

function seated() {
  const arr = [];
  for (const i of T.seats.activeIdx()) arr.push(P[i]);
  return arr;
}
function betSum() { return seated().reduce((a, p) => a + (p.bet || 0), 0); }
function chipsSum() { return seated().reduce((a, p) => a + (p.chips || 0), 0); }
function broughtSum() { return seated().reduce((a, p) => a + (p.brought || 0), 0); }

/* 真实路径：直接 HTTP 拉取主机消息箱，并逐条交给主机消息处理函数
   （等价页面上 pollLoop(hostOnMsg)，但不启动常驻循环，便于确定性断言） */
async function drainHost(ms) {
  const ac = new AbortController();
  const t = setTimeout(function () { try { ac.abort(); } catch (e) {} }, ms || 2000);
  let d = null;
  try {
    d = await (await fetch(BASE + '/api/poll?room=' + ROOM + '&id=' + HOST.id + '&seq=' + hostSeq, { signal: ac.signal })).json();
  } catch (e) { d = null; }
  clearTimeout(t);
  if (d && d.ok) {
    hostSeq = d.seq;
    (d.msgs || []).forEach(function (m) { MPX.hostOnMsg(m); });
    return d.msgs || [];
  }
  return [];
}

/* 主机把本地大厅座位表同步给服务器（真实流程 broadcastLobby 的作用）：
   否则服务器不知道 AI 占座，会把 AI 座位再分配出去（座位错位） */
function syncLobbyToServer() {
  MPX.send({ type: 'lobby', duel: !!MPX.state().mySeat,
    seats: P.map(function (p) { return { type: p.seatType, name: p.name, power: p.power || null }; }) });
}

/* 把客机积压消息清空（真实浏览器一直在长轮询，不会积压；
   测试里客户端"暂停轮询"过，重新开始前必须清干净，否则会误判） */
async function flushClient(c) {
  for (let i = 0; i < 12; i++) {
    const d = await c.pollOnce(220);
    if (!d || d.aborted || !d.msgs || !d.msgs.length) return;
  }
}

/* ---------- 模拟客机（纯 HTTP，模拟真实浏览器行为） ---------- */
class MockClient {
  constructor(name, token) {
    this.name = name;
    this.token = token || ('tok-' + name + '-' + Math.random().toString(36).slice(2, 8));
    this.id = ''; this.seat = -1; this.seq = 0; this.msgs = [];
    this.alive = true; this.actionSeq = 0; this.closed = null; this._actedTurn = '';
  }
  async join(room) {
    const d = await post('/api/join', { room: room, name: this.name, token: this.token });
    if (d.ok) { this.id = d.id; this.seat = d.seat; }
    return d;
  }
  rejoin(room) {
    return post('/api/join', { room: room, name: this.name, token: this.token });
  }
  async pollOnce(timeoutMs) {
    if (!this.id) return { ok: false };
    const ac = (typeof AbortController === 'function' && timeoutMs) ? new AbortController() : null;
    const timer = ac ? setTimeout(function () { try { ac.abort(); } catch (e) {} }, timeoutMs) : null;
    let d;
    try {
      const r = await fetch(BASE + '/api/poll?room=' + ROOM + '&id=' + this.id + '&seq=' + this.seq,
        ac ? { signal: ac.signal } : undefined);
      d = await r.json();
    } catch (e) { if (timer) clearTimeout(timer); return { ok: false, aborted: true }; }
    if (timer) clearTimeout(timer);
    if (!d.ok) { this.alive = false; this.closed = d; return d; }
    this.seq = d.seq;
    this.msgs = this.msgs.concat(d.msgs || []);
    const cl = this.msgs.filter(m => m.type === 'closed');
    if (cl.length) { this.alive = false; this.closed = cl[cl.length - 1]; }
    return d;
  }
  async sendAction(action) {
    this.actionSeq++;
    return post('/api/msg', { room: ROOM, id: this.id, msg: { type: 'action', action: action, seq: this.actionSeq } });
  }
  sendLeave() { return post('/api/msg', { room: ROOM, id: this.id, msg: { type: 'leave' } }); }
  latestSnap() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === 'state') return this.msgs[i].snap;
    return null;
  }
}

/* 一步"牌局推进"：主机玩家自动应答 + 所有客机自动应答（等价真人各自点按钮） */
async function autoActOnce() {
  const st = D.state();
  if (!st.handSettling && st.actingIdx === HOST.seat) {
    const hp = P[HOST.seat];
    const toCall = (st.currentBet || 0) - (hp.bet || 0);
    D.resolveHuman({ type: toCall > 0 ? 'call' : 'check' });
  }
  for (const c of ALL_CLIENTS) {
    if (!c || !c.id || !c.alive) continue;
    const snap = c.latestSnap();
    if (!snap || snap.phase !== 'playing' || snap.actingIdx !== c.seat) continue;
    const me = (snap.seats || [])[c.seat];
    if (!me || !me.inHand || me.acted) continue;
    const turnKey = (snap.handNo || 0) + ':' + (snap.street || '') + ':' + (snap.currentBet || 0) + ':' + c.seat;
    if (c._actedTurn === turnKey) continue;
    c._actedTurn = turnKey;
    const toCall = (snap.currentBet || 0) - (me.bet || 0);
    await c.sendAction(toCall > 0 ? { type: 'call' } : { type: 'check' }).catch(() => {});
  }
}

/* 让牌局继续跑一段时间，直到 cond() 成立或超时 */
async function pump(msTotal, cond) {
  const t = Date.now();
  while (Date.now() - t < msTotal) {
    await sleep(110);
    for (const c of ALL_CLIENTS) { if (c && c.id && c.alive) await c.pollOnce(300); }
    await drainHost(140);
    await autoActOnce();
    if (cond && cond()) return true;
  }
  return false;
}

(async function main() {
  console.log('=== 玩家视角联机场景测试 ===\n');

  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MP_SEATS: '9' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', d => srvLog += d);
  srv.stderr.on('data', d => srvLog += d);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(BASE + '/'); up = true; } catch (e) { await sleep(100); }
  }
  if (!up) { console.error('服务器启动失败\n' + srvLog); process.exit(1); }
  console.log('[准备] 服务器已就绪 ' + BASE + '\n');

  try {
    /* 清空全部座位 */
    P.forEach(p => {
      p.seatType = null; p.name = ''; p.chips = 0; p.brought = 0; p.inHand = false;
      p.hole = []; p.bet = 0; p.totalContrib = 0; p.allIn = false; p.acted = false;
      p.joining = false; p.winner = false; p.revealed = false; p.pendingBuyin = 0;
      p.showFlags = [false, false]; p.showRevealed = [false, false];
    });

    /* ================= A. 大厅：加入 / 主动退出 / 踢人 ================= */
    console.log('--- A. 大厅阶段 ---');
    HOST = await post('/api/create', { name: '房主' });
    ok(HOST.ok && /^\d{5}$/.test(HOST.room), '创建房间 ' + HOST.room);
    ROOM = HOST.room;
    MPX.setIdentity('host', ROOM, HOST.id, HOST.seat, '房主');
    MPX.setPhase('lobby');
    /* 真实流程 createRoomAsHost 会把主机自己的座位标为 host（否则人数少算一人） */
    P[HOST.seat].seatType = 'host'; P[HOST.seat].name = '房主';
    P[HOST.seat].chips = 100; P[HOST.seat].brought = 100;
    ok(T.seats.activeIdx().length === 1, '主机落座（activeIdx=1）');

    const cA = new MockClient('小明'), cB = new MockClient('小红'), cC = new MockClient('小刚');
    ALL_CLIENTS.push(cA, cB, cC);
    for (const c of [cA, cB, cC]) { const d = await c.join(ROOM); ok(d.ok, '客机「' + c.name + '」加入，座位 ' + d.seat); }
    await drainHost();   // 主机经服务器收到 3 条 joined
    const seatsFlat = [HOST.seat, cA.seat, cB.seat, cC.seat];
    ok(new Set(seatsFlat).size === 4, '4 个座位互不重复：' + JSON.stringify(seatsFlat.slice().sort((a, b) => a - b)));
    ok(P[cA.seat].seatType === 'client' && P[cA.seat].name === '小明', '主机侧落座「小明」');
    ok(P[cA.seat].chips === 100 && P[cA.seat].brought === 100, '新客机带入初始筹码 100');

    /* P1：大厅阶段主动退出 */
    await cC.sendLeave();
    await sleep(250);
    await drainHost();
    ok(P[cC.seat].seatType === null, 'P1 大厅主动退出 → 座位释放');
    ok(T.seats.activeIdx().length === 3, 'P1 退出一人后在座 3 人（实际 ' + T.seats.activeIdx().length + '）');
    const cCp = await (await fetch(BASE + '/api/poll?room=' + ROOM + '&id=' + cC.id + '&seq=' + cC.seq)).json();
    ok(cCp.ok === false && cCp.closed === true, 'P1 退出者消息箱已注销（不再占用服务器资源）');

    /* P2a：踢人时该客机正在长轮询 → 应收到 closed(kicked) */
    await flushClient(cB);                       // 清空积压（真实浏览器一直在轮询，不会积压）
    const pollP = cB.pollOnce(4000);             // 在途长轮询
    await sleep(350);
    MPX.send({ type: 'kick', seat: cB.seat });
    await pollP;
    ok(cB.closed && cB.closed.reason === 'kicked', 'P2a 在途轮询的客机收到 closed(kicked)（明确原因）',
      'closed=' + JSON.stringify(cB.closed));

    /* P2b：踢人后主机本地座位必须释放（否则大厅一直显示被踢玩家、新玩家无法落座） */
    const beforeKind = P[cB.seat].seatType;
    await drainHost();
    ok(beforeKind === 'client' && P[cB.seat].seatType === null,
      'P2b 踢人后主机本地座位同步释放（实际 seatType=' + String(P[cB.seat].seatType) + '）');

    /* P2c：腾出的座位可被新玩家正常使用 */
    const cD = new MockClient('新玩家');
    ALL_CLIENTS.push(cD);
    const dD = await cD.join(ROOM);
    ok(dD.ok, 'P2c 踢人后新玩家可加入（座位 ' + dD.seat + '）');
    await drainHost();
    ok(P[dD.seat].seatType === 'client' && P[dD.seat].name === '新玩家',
      'P2c 新玩家成功落座主机侧（实际 seatType=' + String(P[dD.seat].seatType) + '）');

    /* P2d：踢人瞬间客机不在轮询（消息丢失）→ 不得自动"踢了又回来" */
    const cE = new MockClient('捣乱者');
    const dE = await cE.join(ROOM);
    await drainHost();
    MPX.send({ type: 'kick', seat: dE.seat });   // 此时 cE 未在轮询，closed 消息会丢
    await sleep(300);
    await drainHost();
    const mb = await cE.pollOnce(1200);
    ok(mb && mb.ok === false, 'P2d 未在轮询的被踢客机拿到失效回执（closed）');
    const reTry = await cE.rejoin(ROOM);
    ok(reTry.ok === false && reTry.kicked === true,
      'P2d 被踢客机凭同一令牌重新加入 → 被服务器拒绝（不会"踢了又回来"）',
      '实际 ' + JSON.stringify(reTry));

    /* ================= B. 开局与对局中退出 ================= */
    console.log('\n--- B. 对局中主动退出（= 弃牌） ---');
    /* 补 AI 到 6 人桌（真实流程会把 AI 座位同步给服务器，避免座位错位） */
    const need = 6 - T.seats.activeIdx().length;
    let added = 0;
    for (let i = 0; i < 9 && added < need; i++) {
      if (!P[i].seatType) { P[i].seatType = 'ai'; P[i].name = 'AI' + (i + 1); P[i].chips = 100; P[i].brought = 100; added++; }
    }
    syncLobbyToServer();
    await sleep(200);
    ok(T.seats.activeIdx().length === 6, '对局开始时 6 人入座（主机 + 2 客机 + ' + added + ' AI）');
    MPX.setPhase('playing');
    T.client.setMode('host', HOST.seat, '房主');
    MPX.setPhase('playing');

    /* 新玩家加入时不得落在 AI 座位上（座位表同步有效的旁证） */
    const cF = new MockClient('第六人');
    ALL_CLIENTS.push(cF);
    const dF = await cF.join(ROOM);
    await drainHost();
    ok(dF.ok && P[dF.seat].seatType !== 'ai', 'P3 服务器不会把 AI 座位分配出去（新玩家座位 ' + dF.seat + '）');

    const clients = [cA, cD, cF].filter(c => c.seat >= 0 && P[c.seat] && P[c.seat].seatType === 'client');
    const clientSeats = new Set(clients.map(c => c.seat));

    D.startHand();
    const handAtStart = D.state().handNo;
    let leftMidHand = false, leaver = null, leaverSeat = -1;
    let leaverChips = 0, leaverBrought = 0, leaverContrib = 0;
    let maxHand = handAtStart;
    const t0 = Date.now();

    while (Date.now() - t0 < 90000) {
      await sleep(110);
      for (const c of ALL_CLIENTS) { if (c.alive) await c.pollOnce(300); }
      await drainHost(140);
      const st = D.state();
      if (st.handNo > maxHand) maxHand = st.handNo;

      /* 中途退出：本手牌刚发下来时，该玩家直接"退出牌局"（关页面/点退出） */
      if (!leftMidHand && !st.handSettling && st.handNo === handAtStart) {
        let target = null;
        if (st.actingIdx >= 0 && clientSeats.has(st.actingIdx) && P[st.actingIdx].inHand) {
          target = clients.find(x => x.seat === st.actingIdx && x.alive);
        }
        if (!target) target = clients.find(x => x.alive && P[x.seat] && P[x.seat].inHand);
        if (target) {
          leaver = target; leaverSeat = target.seat;
          leaverChips = P[leaverSeat].chips;
          leaverBrought = P[leaverSeat].brought;
          leaverContrib = P[leaverSeat].totalContrib || 0;
          await target.sendLeave();
          leftMidHand = true;
          target.alive = false;
          continue;
        }
      }
      await autoActOnce();
      if (leftMidHand && maxHand >= handAtStart + 1) break;   // 牌局已推进到下一手
    }

    ok(leftMidHand, 'B 成功在牌局进行中触发"玩家退出"');
    ok(P[leaverSeat] && P[leaverSeat].seatType === null,
      'B 退出者座位已释放（seatType=' + String(P[leaverSeat] && P[leaverSeat].seatType) + '）');
    ok(P[leaverSeat] && P[leaverSeat].inHand === false && (P[leaverSeat].hole || []).length === 0,
      'B 退出者本手手牌已清除（视为弃牌）');
    ok(maxHand >= handAtStart + 1, 'B 退出后牌局继续推进到下一手（' + handAtStart + ' → ' + maxHand + '，未卡死）');
    ok(T.seats.activeIdx().length === 6, 'B 退出后座位数 6（7 人减去退出者，实际 ' + T.seats.activeIdx().length + '）');

    /* 等局间窗口再校验守恒。
       注意两个坑：① 必须继续推进牌局（含自动应答），否则卡在主机回合干等 30 秒超时；
       ② showHandEnd/finishFoldWin 先置 handSettling=true，之后才跑派彩动画（+sleep 700ms），
          太早采样会读到"底池尚未派回"的中间态 → 需等"局间 + 筹码静置"再读。 */
    let settled = false, lastM = null, stableSince = 0;
    const dl = Date.now() + 45000;
    while (Date.now() < dl) {
      await sleep(110);
      for (const c of ALL_CLIENTS) { if (c && c.id && c.alive) await c.pollOnce(300); }
      await drainHost(140);
      await autoActOnce();
      const st = D.state();
      const m = chipsSum() + betSum();
      if (st.handSettling && betSum() === 0 && lastM !== null && Math.abs(m - lastM) < 1e-9) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince > 800) { settled = true; break; }   // 局间且筹码静置 → 派彩已完成
      } else {
        stableSince = 0;
      }
      lastM = m;
    }
    const drift = (chipsSum() + betSum()) - broughtSum();   // 在座合计相对带入的偏差
    if (!settled && process.env.SP_DEBUG) {
      const s = D.state();
      console.error('    [dbg] 未进入局间窗口 hand=' + s.handNo + ' street=' + s.street +
        ' acting=' + s.actingIdx + '(' + (P[s.actingIdx] && P[s.actingIdx].name) + ')' +
        ' curBet=' + s.currentBet + ' settling=' + s.handSettling + ' pot=' + D.collectedPot() +
        ' waiting=' + JSON.stringify(s.remoteWaiting) + ' bets=' + betSum() +
        ' seats=' + s.seats.map(function (p, i) {
          return i + ':' + p.type + (p.inHand ? '+' : '') + (p.allIn ? '!' : '') + '/c' + p.chips + '/b' + p.bet;
        }).join(' '));
    }
    ok(settled && Math.abs(drift - leaverContrib) < 1e-6,
      'B 筹码守恒：在座合计 = 带入合计 + 退出者留在底池的 ' + leaverContrib +
      '（实际偏差 ' + drift.toFixed(1) + '，在座带入 ' + broughtSum() + '）',
      'settled=' + settled);

    /* P4：联机秀牌（标记 → 本手结束只亮被标记的那张；对手视角脱敏） */
    const showSeat = clients.map(c => c.seat).find(s => P[s] && P[s].seatType === 'client');
    if (showSeat >= 0) {
      const sp = P[showSeat];
      const hole = (sp.hole && sp.hole.length === 2) ? sp.hole.slice() : ['As', 'Kd'];
      sp.hole = hole.slice(); sp.inHand = true; sp.revealed = false;
      sp.showRevealed = [false, false]; sp.showFlags = [false, false];
      await MPX.hostOnMsg({ type: 'action', seat: showSeat, action: { type: 'show', flags: [true, false] } });
      ok(sp.showFlags[0] === true && sp.showFlags[1] === false, 'P4 客机秀牌标记已记录（仅第一张）');
      T.revealShows();
      ok(sp.showRevealed[0] === true && sp.showRevealed[1] !== true,
        'P4 本手结束：仅被标记的那张亮出（另一张仍隐藏）',
        'revealed=' + JSON.stringify(sp.showRevealed));
      MPX.broadcast();
      await sleep(200);
      const viewer = clients.find(c => c.seat !== showSeat && c.alive);
      await viewer.pollOnce(600);
      const vs = viewer.latestSnap();
      const vsSeat = vs && vs.seats && vs.seats[showSeat];
      ok(vsSeat && vsSeat.hole && vsSeat.hole[0] && !vsSeat.hole[1],
        'P4 对手视角：仅能看到被秀出的那张牌（另一张被服务器脱敏）',
        'hole=' + JSON.stringify(vsSeat && vsSeat.hole));
      P[showSeat].showFlags = [false, false];
      T.revealShows();
    } else {
      ok(true, 'P4 无可用秀牌座位（跳过，非缺陷）');
    }

    /* ================= C. 退出后同名重进（继承战绩） ================= */
    console.log('\n--- C. 退出后同名重进（继承战绩） ---');
    const reClient = new MockClient(leaver.name, leaver.token);
    ALL_CLIENTS.push(reClient);
    const rd = await reClient.join(ROOM);
    await drainHost();
    ok(rd.ok && P[rd.seat] && P[rd.seat].seatType !== 'ai', '重进成功（座位 ' + rd.seat + '）');
    const expectChips = leaverChips > 0 ? leaverChips : 100;
    ok(P[rd.seat] && P[rd.seat].chips === expectChips,
      '重进继承离场时筹码 ' + expectChips + '（实际 ' + (P[rd.seat] && P[rd.seat].chips) + '）');
    ok(P[rd.seat] && P[rd.seat].brought === leaverBrought,
      '重进继承带入总额 ' + leaverBrought + '（实际 ' + (P[rd.seat] && P[rd.seat].brought) + '）');
    ok(P[rd.seat] && P[rd.seat].joining === true && P[rd.seat].inHand === false,
      '重进者先观战（joining=true）直到下一手');

    /* ================= D. 越权动作 / 动态人数 / 买入 ================= */
    console.log('\n--- D. 越权动作 / 动态人数 / 买入 ---');
    const joined = await pump(45000, function () { return P[rd.seat] && P[rd.seat].inHand; });
    ok(joined, 'D 重进者在下一手正式入座（inHand）');

    await sleep(200);
    const st2 = D.state();
    let victimSeat = -1;
    for (const i of T.seats.activeIdx()) {
      if (i !== st2.actingIdx && P[i].inHand && P[i].seatType === 'client') { victimSeat = i; break; }
    }
    if (victimSeat >= 0) {
      const chipsBefore = P[victimSeat].chips, betBefore = P[victimSeat].bet;
      const actingBefore = D.state().actingIdx;
      await MPX.hostOnMsg({ type: 'action', seat: victimSeat, action: { type: 'raise', to: 9999 }, seq: 1 });
      ok(P[victimSeat].chips === chipsBefore && P[victimSeat].bet === betBefore,
        'D 非行动座位提交加注 → 被丢弃，筹码/下注不变');
      ok(D.state().actingIdx === actingBefore, 'D 越权动作不影响当前行动者');
    } else {
      ok(true, 'D 本轮无越权测试座位（跳过，非缺陷）');
    }

    const act = T.seats.activeIdx();
    ok(act.every(i => P[i].seatType), 'D activeIdx 内无空座（座位管理一致）');
    const bl = T.blindSeats();
    ok(P[bl.sb] && P[bl.sb].seatType, 'D 小盲位落在在座玩家（seat ' + bl.sb + '）');
    ok(P[bl.bb] && P[bl.bb].seatType, 'D 大盲位落在在座玩家（seat ' + bl.bb + '）');
    ok(bl.sb !== bl.bb, 'D 小盲与大盲不为同一人');

    /* 联机买入：客机申请 → 下一手生效（筹码与带入同时增加） */
    const buySeat = reClient.seat;
    if (P[buySeat] && P[buySeat].seatType === 'client') {
      const bc = P[buySeat].chips, bb2 = P[buySeat].brought;
      await MPX.hostOnMsg({ type: 'action', seat: buySeat, action: { type: 'buyin', amount: 50 }, seq: 99 });
      ok(P[buySeat].pendingBuyin === 50, 'D 客机买入申请已登记，下一手生效');
      /* 买入在下一手开局时结算（投入筹码，brought 同步增加）。
         此后筹码会随该手输赢变化，故只断言"带入精确 +50"（买入已生效的铁证）。 */
      const applied = await pump(60000, function () {
        return P[buySeat] && P[buySeat].pendingBuyin === 0 && P[buySeat].brought === bb2 + 50;
      });
      ok(applied,
        'D 买入下一手生效：带入 +50（' + bb2 + '→' + P[buySeat].brought + '），筹码同步注入（当前 ' + P[buySeat].chips + '，随该手输赢浮动）');
      ok(Math.abs((chipsSum() + betSum()) - broughtSum()) < 1e-6,
        'D 买入后筹码依然守恒（偏差 ' + (chipsSum() + betSum() - broughtSum()).toFixed(1) + '）');
    }

    /* ================= E. 主机解散房间 ================= */
    console.log('\n--- E. 主机解散房间 ---');
    MPX.send({ type: 'close' });
    await sleep(400);
    let closedCount = 0;
    for (const c of [cA, reClient]) {
      await c.pollOnce(600);
      if (c.closed) closedCount++;
    }
    ok(closedCount === 2, 'E 主机解散 → 所有在房客机收到 closed（' + closedCount + '/2）');
    const afterClose = await post('/api/join', { room: ROOM, name: '后来者' });
    ok(afterClose.ok === false, 'E 房间解散后加入被拒绝（' + (afterClose.err || '') + '）');

    console.log('\n========================================');
    console.log('场景测试结果：' + pass + ' 通过, ' + fail + ' 失败');
    if (fail) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('========================================');
    srv.kill();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\n[异常] ' + e.message);
    console.error(e.stack);
    srv.kill();
    process.exit(1);
  }
})();
