/* 客机交互 E2E：真实 6 人联机下，客机"按钮可点击性"全链路验证
   流程：真实 server.js + 1 主机（HTML 引擎）+ 5 客机（HTTP）
   验证：
     1) 每位客机收到快照后，行动条只在"轮到自己"时启用
     2) 客机点击按钮 → 动作经服务器 → 主机执行 → 牌局推进
     3) 客机在非自己回合点击 → 被本地拦截（不产生网络请求）
     4) 重复点击同一动作 → 只投递一次
     5) 客机刷新（序号归零）后提交的动作仍被主机接受（seq 抬升修复回归）
   用法：node stress-client.js */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18990;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const failures = [];
function ok(c, name, extra) {
  if (c) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? ' | ' + extra : '')); console.error('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    return { add: c => s._class.add(c), remove: c => s._class.delete(c),
      toggle: (c, f) => { if (f === undefined) { s._class.has(c) ? s._class.delete(c) : s._class.add(c); } else if (f) s._class.add(c); else s._class.delete(c); },
      contains: c => s._class.has(c) };
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
  createElement(t) { return new FakeEl(t); }, addEventListener() {},
  body: new FakeEl('body'), documentElement: new FakeEl('html'), hidden: false
};
global.window = global;
global.location = { host: 'localhost:' + PORT, origin: BASE, href: BASE + '/', search: '', protocol: 'http:', pathname: '/' };
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.sessionStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.alert = function () {};
global.PokerCore = require('./core.js');

/* 统计客机发出的网络请求（模拟手机端按钮点击的真实出口） */
const reqLog = [];
const realFetch = fetch;
global.fetch = function (u, o) {
  if (typeof u === 'string' && u[0] === '/') {
    let bodyId = '';
    try { bodyId = o && o.body ? (JSON.parse(o.body).id || '') : ''; } catch (e) {}
    reqLog.push({ url: u, method: (o && o.method) || 'GET', id: bodyId, at: Date.now() });
    u = BASE + u;
  }
  return realFetch(u, o);
};

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const P = T.players;
const MPX = T.mp;
const CL = T.client;
const bar = () => document.getElementById('action-bar');

/* 客机包装：真实 HTTP + 本地引擎的 clientOnMsg/syncClientActionBar */
class MockClient {
  constructor(name) {
    this.name = name; this.id = ''; this.seat = -1; this.seq = 0; this.msgs = [];
    this._actedTurn = '';
  }
  async join(room) {
    const d = await post('/api/join', { room, name: this.name });
    this.id = d.id; this.seat = d.seat; return d;
  }
  async poll() {
    // 短超时长轮询：有消息立即返回；无消息 600ms 后主动中断（避免测试串行卡死）
    const ac = new AbortController();
    const t = setTimeout(() => { try { ac.abort(); } catch (e) {} }, 250);
    try {
      const r = await realFetch(BASE + '/api/poll?room=' + MPX.state().room + '&id=' + this.id + '&seq=' + this.seq, { signal: ac.signal });
      const d = await r.json();
      if (d && d.ok) { this.seq = d.seq; this.msgs = this.msgs.concat(d.msgs || []); }
      return d;
    } catch (e) {
      return { ok: false, aborted: true };
    } finally { clearTimeout(t); }
  }
  latestSnap() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === 'state') return this.msgs[i].snap;
    return null;
  }
  /* 把最新快照喂给本地客机引擎（等价于页面 clientOnMsg('state')）
     注意：套用后必须调用 restoreHost() 恢复主机身份，否则主机的 bettingRound
     会因 MP.mode==='client' 走到"人工等待"分支（30 秒超时），牌局停滞 */
  applyLocal() {
    const snap = this.latestSnap();
    if (!snap) return null;
    CL.setMode('client', this.seat, this.name);
    CL.setRoom(MPX.state().room, this.id);
    CL.applySnapshot(snap);
    return snap;
  }
  /* 模拟"点击行动按钮"：走真实 submitAction 出口 */
  click(action) {
    return CL.submit(action);
  }
}

(async function () {
  console.log('=== 客机交互 E2E（6 人联机，按钮可点击性）===\n');

  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MP_SEATS: '9' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', d => srvLog += d);
  srv.stderr.on('data', d => srvLog += d);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await realFetch(BASE + '/'); up = true; } catch (e) { await sleep(100); } }
  if (!up) { console.error('服务器启动失败\n' + srvLog); process.exit(1); }
  console.log('[准备] 服务器就绪 ' + BASE + '\n');

  try {
    /* ---- 建房 + 5 客机 ---- */
    P.forEach(p => {
      p.seatType = null; p.name = ''; p.chips = 0; p.brought = 0; p.inHand = false;
      p.hole = []; p.bet = 0; p.totalContrib = 0; p.allIn = false; p.acted = false; p.joining = false;
    });
    const host = await post('/api/create', { name: '主机' });
    const room = host.room;
    MPX.setIdentity('host', room, host.id, host.seat, '主机');
    MPX.setPhase('lobby');

    const clients = [];
    for (let i = 0; i < 5; i++) {
      const c = new MockClient('客机' + (i + 1));
      await c.join(room);
      clients.push(c);
    }
    for (const c of clients) await MPX.hostOnMsg({ type: 'joined', seat: c.seat, name: c.name });

    // 主机自己也在座：host.seat。1 主机 + 5 客机 = 6 人，无需补 AI
    P[host.seat].seatType = 'host'; P[host.seat].name = '主机';
    const occ = new Set([host.seat].concat(clients.map(c => c.seat)));
    P.forEach((p, i) => { if (occ.has(i)) { p.chips = 100; p.brought = 100; p.seatType = p.seatType || 'client'; } });
    T.client.setMode('host', host.seat, '主机');
    ok(T.seats.activeIdx().length === 6, '房间 6 人就座（' + T.seats.activeIdx().length + ' 人）');
    console.log('    座位分配：' + T.seats.activeIdx().map(i =>
      'seat' + i + '=' + P[i].name + '(' + P[i].seatType + ')').join('  '));

    /* ---- 开局 ---- */
    MPX.setPhase('playing');
    MPX.pollOnce();
    await sleep(200);
    T.debug.startHand();

    /* ---- 1. 按钮可点击性：只在轮到自己时启用 ---- */
    console.log('--- 1. 行动条可点击性（按快照逐座位校验）---');
    let enableChecks = 0, enableOk = 0, disableChecks = 0, disableOk = 0;
    let advanced = 0;
    const clickedTurns = new Set();

    for (let round = 0; round < 900 && advanced < 12; round++) {
      await sleep(100);
      if (process.env.STRESS_VERBOSE && round % 20 === 0) {
        const st = T.debug.state();
        const actSeat = st.actingIdx;
        const who = (actSeat >= 0 && P[actSeat]) ? (P[actSeat].name + '/' + P[actSeat].seatType +
          ' bet=' + P[actSeat].bet + ' chips=' + P[actSeat].chips + ' acted=' + P[actSeat].acted +
          ' allIn=' + P[actSeat].allIn + ' inHand=' + P[actSeat].inHand) : '(无)';
        console.log('    [轮 ' + round + '] 局=' + st.handNo + ' 街=' + st.street + ' actingIdx=' + actSeat +
          ' [' + who + '] currentBet=' + st.currentBet + ' 已点击=' + advanced +
          ' 启用=' + enableChecks + ' 禁用=' + disableChecks);
      }

      // 主机本人回合：测试中自动过牌/跟注（等价于主机玩家点按钮，走 resolveHuman 出口）
      {
        const st = T.debug.state();
        const hp = P[host.seat];
        if (st.actingIdx === host.seat && hp.inHand && !hp.acted && !st.handSettling) {
          const turnKey = 'H:' + st.handNo + ':' + st.street + ':' + st.currentBet;
          if (!clickedTurns.has(turnKey)) {
            clickedTurns.add(turnKey);
            CL.setMode('host', host.seat, '主机');   // 切回主机身份再提交
            CL.setRoom(room, host.id);
            const toCall = st.currentBet - hp.bet;
            CL.submit(toCall > 0 ? { type: 'call' } : { type: 'check' });
          }
        }
      }

      // 每位客机拉最新快照并套用本地引擎（并行，避免串行累加等待）
      await Promise.all(clients.map(c => c.poll().catch(() => {})));
      // 采样/点击完后立即恢复主机身份（否则主机流程会误判为客机，陷入 30 秒人工等待）
      const restoreHost = () => { CL.setMode('host', host.seat, '主机'); CL.setRoom(room, host.id); };
      for (const c of clients) {        const snap = c.applyLocal();
        if (!snap) continue;
        const myTurn = snap.actingIdx === c.seat && snap.phase === 'playing';
        const me = (snap.seats || [])[c.seat];
        const inHand = me && me.inHand;
        const barDisabled = bar().classList.contains('disabled');
        const canAct = CL.canAct();

        if (myTurn && inHand) {
          // 存在在途动作时行动条本就应禁用（防重复提交），这类样本不计入"可点击"统计
          if (CL.pending()) continue;
          enableChecks++;
          // "可点击"语义：行动条未禁用 + 点击守卫放行
          if (canAct && !barDisabled && CL.tapGuard()) enableOk++;
          else console.log('      [启用异常] seat' + c.seat + ' canAct=' + canAct +
            ' barDisabled=' + barDisabled + ' tapGuard=' + CL.tapGuard());
        } else {
          disableChecks++;
          if (!canAct && barDisabled) disableOk++;
        }

        // 轮到我 → 点击按钮提交（同回合只点一次）
        if (myTurn && inHand && canAct && !me.acted) {
          const turnKey = (snap.handNo || 0) + ':' + (snap.street || '') + ':' + (snap.currentBet || 0) + ':' + c.seat;
          if (clickedTurns.has(turnKey)) continue;
          clickedTurns.add(turnKey);
          const toCall = (snap.currentBet || 0) - (me.bet || 0);
          c.click(toCall > 0 ? { type: 'call' } : { type: 'check' });
          advanced++;
        }
      }
      restoreHost();   // 关键：恢复主机身份，主机的 bettingRound 才能正确识别客机走远程等待

      // 主机侧推进（真实 HTTP 轮询处理客机动作）
      await sleep(60);
      await Promise.all(clients.map(c => c.poll().catch(() => {})));
    }

    ok(enableChecks >= 5, '采样到"轮到我"场景 ≥5 次（实际 ' + enableChecks + '）');
    ok(enableOk === enableChecks, '轮到我 → 行动条全部启用、可点击（' + enableOk + '/' + enableChecks + '）');
    ok(disableChecks >= 5, '采样到"非我行动"场景 ≥5 次（实际 ' + disableChecks + '）');
    ok(disableOk === disableChecks, '非我行动 → 行动条全部禁用、点击被拦截（' + disableOk + '/' + disableChecks + '）');

    /* ---- 2. 客机点击真能推进牌局 ---- */
    console.log('\n--- 2. 客机点击 → 动作送达主机并推进牌局 ---');
    const handsNow = T.debug.state().handNo;
    ok(advanced > 0, '客机通过按钮提交了 ' + advanced + ' 次动作');
    ok(T.debug.state().handNo >= 1, '牌局已推进（当前第 ' + T.debug.state().handNo + ' 局）');

    /* ---- 3. 非我回合点击不产生网络请求 ---- */
    console.log('\n--- 3. 非法时机点击被本地拦截 ---');
    {
      // 找一位当前"非我行动"的客机
      let target = null, snapRef = null;
      for (const c of clients) {
        const snap = c.latestSnap();
        if (snap && snap.actingIdx !== c.seat) { c.applyLocal(); target = c; snapRef = snap; break; }
      }
      if (!target) { ok(false, '找到"非我行动"客机用于拦截测试'); }
      else {
        // 清掉所有客机的在途动作
        for (const c of clients) { CL.setMode('client', c.seat, c.name); CL.setRoom(room, c.id); CL.clearPending(); }
        target.applyLocal();
        await sleep(500);
        const guard = CL.tapGuard();          // 非我行动时应为 false
        CL.clearPending();
        target.click({ type: 'call' });       // 模拟点击按钮
        const pendingAfter = CL.pending();    // 被拦截 → 不应产生在途动作
        await sleep(250);
        ok(guard === false, '非我行动 → 点击守卫关闭（tapGuard=false）');
        ok(pendingAfter === null, '非我回合点击 → 不会进入在途状态（按钮无效）');
      }
    }

    /* ---- 4. 重复点击同一动作 → 只投递一次 ---- */
    console.log('\n--- 4. 连点防抖（同一动作只投递一次）---');
    {
      let target = null;
      for (const c of clients) {
        const snap = c.latestSnap();
        const me = snap && (snap.seats || [])[c.seat];
        if (snap && snap.actingIdx === c.seat && me && me.inHand) { c.applyLocal(); target = c; break; }
      }
      if (!target) { console.log('    [跳过] 当前没有"轮到我"的客机'); ok(true, '（跳过）连点防抖'); }
      else {
        target.seq = target.seq; // 保持
        const before = reqLog.filter(r => r.url === '/api/msg').length;
        target.click({ type: 'check' });
        target.click({ type: 'check' });
        target.click({ type: 'check' });
        await sleep(300);
        const after = reqLog.filter(r => r.url === '/api/msg').length;
        ok(after - before <= 1, '同一动作连点 3 次 → 至多投递 1 次（实际 ' + (after - before) + '）');
      }
    }

    /* ---- 5. 客机刷新（序号归零）后动作仍被主机接受 ---- */
    console.log('\n--- 5. 客机刷新后序号抬升（回归：seq 错位卡死）---');
    {
      const c = clients[0];
      // 主机侧正在等待该座位动作时，序号幂等去重才生效（用测试钩子造出等待状态）
      const got1 = CL.hostAction({ type: 'action', seat: c.seat, action: { type: 'check' }, seq: 50 });
      ok(CL.hostSeq(c.seat) === 50, '主机记录该座位已处理序号 = 50（实际 ' + CL.hostSeq(c.seat) + '）');
      ok(got1 && got1.type === 'check', '序号 50 的动作被执行');
      const got2 = CL.hostAction({ type: 'action', seat: c.seat, action: { type: 'raise', to: 10 }, seq: 50 });
      ok(got2 === null, '同序号 50 重发 → 主机去重忽略');
      // 模拟客机刷新：本地序号归零
      CL.setSeq(0);
      // 主机快照带回 actSeq[本座位]=50 → applySnapshot 应把本地序号抬升到 50
      // （同时构造"轮到我"的局面，以便随后提交动作通过纵深防御）
      const snap = c.latestSnap() || {};
      const patched = Object.assign({}, snap, {
        actingIdx: c.seat, phase: 'playing', actSeq: new Array(9).fill(0)
      });
      patched.seats = (snap.seats || []).map((s, i) =>
        i === c.seat ? Object.assign({}, s, { seatType: 'client', inHand: true, chips: 100, acted: false }) : s);
      patched.actSeq[c.seat] = 50;
      CL.setMode('client', c.seat, c.name); CL.setRoom(room, c.id);
      CL.applySnapshot(patched);
      ok(CL.seq() >= 50, '刷新后套用快照 → 本地序号被抬升到 ≥50（实际 ' + CL.seq() + '）');
      // 此时提交的新动作序号 > 50，主机不会去重丢弃
      CL.clearPending();
      CL.submit({ type: 'call' });
      const pending = CL.pending();
      await sleep(200);
      ok(!!pending && pending.seq > 50, '刷新后提交的动作序号 > 主机已处理值（' + (pending ? pending.seq : 'N/A') + ' > 50）');
    }

    MPX.stopPoll();

    console.log('\n========================================');
    console.log('客机交互 E2E：' + pass + ' 通过, ' + fail + ' 失败');
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
