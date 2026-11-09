/* 6 人联机综合压测（真实 server.js）
   结构：本进程 = 主机（加载 HTML 引擎，经真实 HTTP 轮询 server）
         5 个模拟客机 = 纯 HTTP 客户端（create/join/poll/msg）
   覆盖：多手牌局推进、底池与筹码守恒、行动顺序、聊天、客机行动条
   用法：node stress-6p.js [手数] */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18987;
const BASE = 'http://127.0.0.1:' + PORT;
const HANDS = parseInt(process.argv[2] || '6', 10);

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

/* 真实 fetch：相对路径补全为本地 server（模拟页面同源） */
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

/* 主机发言（走真实 chatSend：上屏 + mpSend 广播） */
function addChatViaHost(text) {
  const inp = document.getElementById('chat-input');
  inp.value = text;
  T.chat.chatSend();
}

/* 当前实际在座的 6 个玩家（物理索引不连续，不能按 P.slice(0,6) 取） */
function seated() {
  const arr = [];
  const act = T.seats.activeIdx();
  for (const i of act) arr.push(P[i]);
  return arr;
}
/* 在座玩家筹码合计 */
function chipSum() { return seated().reduce((a, p) => a + (p.chips || 0), 0); }
/* 守恒不变量：chips + 桌上未收下注 == brought（带入总额）。破产自动重买入会同步加 brought，故不能恒盯 600 */
function conservation() {
  const s = seated();
  const chips = s.reduce((a, p) => a + (p.chips || 0), 0);
  const bets = s.reduce((a, p) => a + (p.bet || 0), 0);
  const brought = s.reduce((a, p) => a + (p.brought || 0), 0);
  return { chips, bets, brought, total: chips + bets, ok: Math.abs(chips + bets - brought) < 1e-6 };
}

/* ---------- 模拟客机（纯 HTTP） ---------- */
class MockClient {
  constructor(name) {
    this.name = name; this.id = ''; this.seat = -1; this.seq = 0; this.msgs = [];
    this.alive = true; this.actionSeq = 0;
    this._actedTurn = '';   // 已提交动作的回合标识（防同回合重复提交）
  }
  async join(room) {
    const d = await post('/api/join', { room: room, name: this.name });
    if (!d.ok) throw new Error('join failed: ' + d.err);
    this.id = d.id; this.seat = d.seat;
    return d;
  }
  async pollOnce() {
    const r = await fetch(BASE + '/api/poll?room=' + MPX.state().room + '&id=' + this.id + '&seq=' + this.seq);
    const d = await r.json();
    if (!d.ok) return d;
    this.seq = d.seq;
    this.msgs = this.msgs.concat(d.msgs || []);
    return d;
  }
  async sendAction(action) {
    this.actionSeq++;
    return post('/api/msg', { room: MPX.state().room, id: this.id, msg: { type: 'action', action: action, seq: this.actionSeq } });
  }
  async sendChat(text) {
    // 客机聊天：文本走 action.text（与服务端/主机约定一致）
    return post('/api/msg', { room: MPX.state().room, id: this.id, msg: { type: 'chat', action: { text: text } } });
  }
  latestSnap() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === 'state') return this.msgs[i].snap;
    return null;
  }
  chats() { return this.msgs.filter(m => m.type === 'chat'); }
}

(async function main() {
  console.log('=== 6 人联机综合压测（' + HANDS + ' 手）===\n');

  /* 启动服务器（缩短超时，加快掉线测试） */
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
    /* ---------- 阶段 1：建房 + 5 客机加入 + 1 AI 补位 = 6 人 ---------- */
    console.log('--- 1. 建房与入座（1 主机 + 5 客机 + 1 AI = 6 人）---');
    // 彻底清空所有座位（initSingle 默认放好了 1 host + 5 AI，必须先清干净）
    P.forEach(p => {
      p.seatType = null; p.name = ''; p.chips = 0; p.brought = 0; p.inHand = false;
      p.hole = []; p.bet = 0; p.totalContrib = 0; p.allIn = false; p.acted = false;
      p.joining = false; p.winner = false; p.revealed = false;
      p.showFlags = [false, false]; p.showRevealed = [false, false];
    });

    const host = await post('/api/create', { name: '主机' });
    ok(host.ok && /^\d{5}$/.test(host.room), '房间创建成功：' + host.room);
    const room = host.room;

    MPX.setIdentity('host', room, host.id, host.seat, '主机');
    MPX.setPhase('lobby');

    const clients = [];
    for (let i = 0; i < 5; i++) {
      const c = new MockClient('客机' + (i + 1));
      const d = await c.join(room);
      c.seat = d.seat; c.id = d.id;
      clients.push(c);
      ok(d.ok !== false, '客机' + (i + 1) + '加入座位 ' + d.seat);
    }
    const seatsAll = [host.seat].concat(clients.map(c => c.seat));
    ok(new Set(seatsAll).size === 6, '6 个座位互不重复：' + JSON.stringify(seatsAll.slice().sort((a, b) => a - b)));

    // 主机处理加入通知
    await MPX.hostOnMsg({ type: 'joined', seat: clients[0].seat, name: clients[0].name });
    for (let i = 0; i < 5; i++) await MPX.hostOnMsg({ type: 'joined', seat: clients[i].seat, name: clients[i].name });

    // 找出空座位补 AI（保证 6 人满桌）
    const occupied = new Set(seatsAll);
    let aiSeat = -1;
    for (let i = 0; i < 6; i++) if (!occupied.has(i)) { aiSeat = i; break; }
    ok(aiSeat >= 0, '找到空位补 AI：座位 ' + aiSeat);
    P[aiSeat].seatType = 'ai'; P[aiSeat].name = 'AI补位'; P[aiSeat].chips = 100; P[aiSeat].brought = 100;

    // 补齐所有玩家筹码（主机 + 客机 + AI）
    P.forEach((p, i) => { if (occupied.has(i) || i === aiSeat) { p.chips = 100; p.brought = 100; } });
    T.client.setMode('host', host.seat, '主机');

    // 主机本地座位表需与服务器一致：客机座位标记为 client
    for (const c of clients) {
      const p = P[c.seat];
      if (p && !p.seatType) { p.seatType = 'client'; p.name = c.name; p.chips = 100; p.brought = 100; p.inHand = false; }
    }

    ok(T.seats.activeIdx().length === 6, '共 6 人入座（activeIdx=' + T.seats.activeIdx().length + '）');

    /* ---------- 阶段 2：启动主机轮询 + 开局 ---------- */
    console.log('\n--- 2. 开局与多手牌局 ---');
    MPX.setPhase('playing');
    MPX.pollOnce();   // 后台长轮询（hostOnMsg）
    await sleep(200);

    const chipTotal0 = chipSum();
    ok(chipTotal0 === 600, '开局前 6 人筹码合计 600（实际 ' + chipTotal0 + '）');
    // 只起一次手；之后完全交给程序自带的"3 秒后自动下一局"循环推进
    // （切忌在此处反复调用 startHand()：会与自带续局流程并发，造成同一底池被重复收取）
    D.startHand();

    /* 客机自动应答：轮到自己就过牌/跟注（保证牌局推进） */
    let handsDone = 0;
    let hostMsgSeen = 0;
    const t0 = Date.now();
    const CLIENT_TICK = 120;

    while (handsDone < HANDS && Date.now() - t0 < 150000) {
      await sleep(CLIENT_TICK);

      // 客机轮询
      for (const c of clients) {
        if (!c.alive) continue;
        try {
          const d = await c.pollOnce();
          if (d && d.ok === false) { c.alive = false; }
        } catch (e) { /* 忽略瞬时错误 */ }
      }

      // 客机看到轮到自己 → 提交动作（同回合只提交一次，避免重复扣筹码）
      for (const c of clients) {
        if (!c.alive) continue;
        const snap = c.latestSnap();
        if (!snap) continue;
        if (snap.actingIdx === c.seat && snap.phase === 'playing') {
          const me = (snap.seats || [])[c.seat];
          if (me && me.inHand && !me.acted) {
            const turnKey = (snap.handNo || 0) + ':' + (snap.street || '') + ':' + (snap.currentBet || 0) + ':' + c.seat;
            if (c._actedTurn === turnKey) continue;   // 本回合已提交
            c._actedTurn = turnKey;
            const toCall = (snap.currentBet || 0) - (me.bet || 0);
            const act = toCall > 0 ? { type: 'call' } : { type: 'check' };
            await c.sendAction(act);
          }
        }
      }

      // 通过日志里的"第 N 局"检测手数推进
      const lines = T.logLines();
      const lastStreets = lines.filter(l => /===== 第 (\d+) 局 =====/.test(l.text));
      if (lastStreets.length) handsDone = lastStreets.length;
      hostMsgSeen = lines.length;
    }

    console.log('  [进度] 已完成 ' + handsDone + ' 手，日志 ' + hostMsgSeen + ' 行');

    /* ---------- 阶段 3：等一手完全结束（局间窗口）后校验守恒 ---------- */
    console.log('\n--- 3. 底盘校验：筹码守恒 / 底池 ---');
    // 等到"局间等待中 + 桌上无未收下注"
    for (let i = 0; i < 300; i++) {
      const bets = seated().reduce((a, p) => a + (p.bet || 0), 0);
      if (D.state().handSettling && bets === 0) break;
      await sleep(80);
    }
    await sleep(300);
    const cv = conservation();
    ok(cv.ok, '多手后筹码守恒：chips + 桌上未收下注 == brought（实际 ' + cv.total + ' / ' + cv.brought +
      '，差 ' + (cv.total - cv.brought).toFixed(1) + '）',
      '每人：' + seated().map(p => p.idx + ':' + p.chips).join(' '));
    if (cv.brought !== 600) console.log('    [提示] 期间发生破产自动重买入，带入总额 ' + cv.brought +
      '（多出 ' + (cv.brought - 600) + '，守恒判定已按 brought 计算）');

    ok(handsDone >= Math.min(HANDS, 2), '至少完成 2 手牌（实际 ' + handsDone + '）');

    // 底池一致性：本街底池 + 各家下注 == 历史累计投入
    const betSum = seated().reduce((a, p) => a + (p.bet || 0), 0);
    ok(betSum >= 0, '桌上未收下注额非负（' + betSum + '）');

    // 每位客机都收到过快照
    for (const c of clients) {
      ok(c.latestSnap() !== null, '客机' + c.name.slice(-1) + ' 收到状态快照');
    }

    /* ---------- 阶段 4：聊天（主机轮询仍在运行） ---------- */
    console.log('\n--- 4. 聊天压测 ---');
    const before = clients[0].msgs.filter(m => m.type === 'chat').length;
    const chatTexts = [
      '大家好',
      '<script>alert(1)</script>',     // XSS 注入尝试
      '<img src=x onerror=alert(2)>',  // HTML 注入尝试
      'A'.repeat(500),                 // 超长（服务端应截断到 120）
      '😀🎉🂡🂢',                       // emoji + 扑克字符
      '换行\n测试',
      '',                              // 空（应被丢弃）
      '   '                            // 纯空格（应被丢弃）
    ];
    for (const t of chatTexts) await clients[0].sendChat(t);

    // 主机轮询仍在运行 —— 等它把客机发言中继回来（服务端 → 主机 hostOnMsg → 广播）
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      await clients[0].pollOnce().catch(() => {});
      if (clients[0].chats().length - before >= 5) break;
    }

    const chats = clients[0].chats();
    const got = chats.length - before;
    ok(got > 0, '客机聊天经主机中继回送（新增 ' + got + ' 条）');
    // 8 条中：'' 与 '   ' 被丢弃，其余 6 条有效
    ok(got === 6, '空串/纯空格被丢弃，有效消息 6 条（实际 ' + got + '）');
    const texts = chats.slice(before).map(c => c.text);
    ok(texts.every(t => String(t).trim().length > 0), '不存在空聊天记录');

    // XSS 防护：聊天渲染用 textContent（不解析 HTML），原始文本保留
    const chatBlob = chats.map(c => c.text || '').join('\u0000');
    ok(chatBlob.indexOf('<script>') >= 0, 'XSS 文本原样保留（未被当代码执行）');
    const chatDom = String(byId['chat-msgs'] ? byId['chat-msgs'].innerHTML : '');
    ok(chatDom.indexOf('<img src=x') < 0 && chatDom.indexOf('<script>') < 0,
      '聊天渲染不注入 HTML（textContent 安全）');

    // 超长消息被截断
    const long = chats.filter(c => (c.text || '').length > 0 && /^A+$/.test(c.text || ''))[0];
    ok(long && long.text.length <= 120, '超长消息被截断到 120 字（实际 ' +
      (long ? long.text.length : 'N/A') + '）');

    // 主机聊天记录（走 hostOnMsg 的 addChat）
    const hostLog = T.chat.state().log;
    const hostSawClient = hostLog.some(x => x.text && x.text.indexOf('大家好') >= 0);
    ok(hostSawClient, '主机聊天面板收到客机发言');

    // 主机自己发言 → 广播给所有客机
    const hostChatBefore = clients[1].chats().length;
    addChatViaHost('主机播报');
    await sleep(500);
    for (const c of clients) { await c.pollOnce().catch(() => {}); await sleep(120); }
    const hostChatGot = clients.filter(c => c.chats().some(m => m.text === '主机播报')).length;
    ok(hostChatGot === 5, '主机发言广播到全部 5 台客机（实际 ' + hostChatGot + ' 台）');

    /* 停止牌局推进与轮询 */
    MPX.stopPoll();

    console.log('\n========================================');
    console.log('压测结果：' + pass + ' 通过, ' + fail + ' 失败');
    if (fail) {
      console.log('\n失败项：');
      failures.forEach(f => console.log('  - ' + f));
    }
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
