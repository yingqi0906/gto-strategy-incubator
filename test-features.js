/* 新功能无头测试：行为数据弹窗(VPIP/PFR/3bet) / 秀牌翻牌 / 手间3秒提示 / 退出牌局服务器流程 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
  createElement(tag) { return new FakeEl(tag); }
};
global.window = global;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { return setImmediate(fn); };
require('./core.js');
global.PokerCore = module.require('./core.js');
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
eval(m[1]);

const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));
const T = global.window.__PokerTest;

let pass = 0, fail = 0;
const assert = (c, msg) => { if (c) { pass++; console.log('  ok ' + msg); } else { fail++; console.error('  FAIL ' + msg); } };

(async function main() {
  /* ---------- 单机：行为数据 / 秀牌 / 手间提示 ---------- */
  byId['btn-start'].onclick(); // 单机开局（昵称兜底"你"）
  await wallSleep(50);

  console.log('--- 行为数据统计 ---');
  // 推进一手：能跟注就跟注（主动入池），否则过牌
  async function driveHand(ms) {
    const deadline = Date.now() + (ms || 8000);
    while (Date.now() < deadline) {
      const heads = logLines.filter(l => /^===== 第 \d+ 局 =====$/.test(l)).length;
      if (heads >= 2) return true;
      if (!byId['btn-fold'].disabled && byId['btn-check'].textContent.indexOf('跟注') >= 0) {
        byId['btn-check'].onclick(); // 跟注 → VPIP
      } else if (!byId['btn-fold'].disabled) {
        byId['btn-fold'].onclick();
      } else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) {
        byId['btn-check'].onclick();
      }
      await sleepTick();
    }
    return false;
  }
  // 第1手等待结束并进入第2手（手间提示出现即第1手已结束）
  const d2 = Date.now() + 20000;
  let sawMsg = false;
  while (Date.now() < d2) {
    if ((byId['table-msg'].innerHTML || '').indexOf('下一局 3 秒后开始') >= 0) { sawMsg = true; break; }
    if (!byId['btn-fold'].disabled && byId['btn-check'].textContent.indexOf('跟注') >= 0) byId['btn-check'].onclick();
    else if (!byId['btn-fold'].disabled) byId['btn-fold'].onclick();
    else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) byId['btn-check'].onclick();
    await sleepTick();
  }
  assert(sawMsg, '手牌结束后出现"下一局 3 秒后开始"提示');

  // 第2手：主动跟注一次，验证 VPIP 计数
  await driveHand();
  const meBeh = T.behavior['你（玩家）'];
  assert(!!meBeh && meBeh.dealt >= 2, 'dealt 分母按手牌累计（dealt=' + (meBeh && meBeh.dealt) + '）');

  // 行为数据弹窗：显示/隐藏
  T.showStatPopup(0);
  const pop = byId['stat-popup'];
  assert(pop.classList.contains('show'), '点击名称区弹出行为数据小界面');
  assert((pop.innerHTML || '').indexOf('VPIP') >= 0 && (pop.innerHTML || '').indexOf('PFR') >= 0 &&
    (pop.innerHTML || '').indexOf('3bet') >= 0, '弹窗包含 VPIP/PFR/3bet 三项');
  T.hideStatPopup();
  assert(!pop.classList.contains('show'), '点击其他位置关闭弹窗');
  T.showStatPopup(1); // AI 座位也可查看
  assert(pop.classList.contains('show'), '可查看其他玩家（AI）的数据');
  T.hideStatPopup();

  console.log('--- 秀牌 ---');
  // 单元级：revealShows 逐张翻开（只翻被标记的牌）
  {
    const p0 = T.players[0];
    const keepType = p0.seatType, keepHole = p0.hole, keepFlags = p0.showFlags, keepRev = p0.showRevealed;
    p0.seatType = 'host'; p0.revealed = false;
    p0.hole = [{ r: 14, s: 0 }, { r: 13, s: 1 }];
    p0.showFlags = [true, false]; p0.showRevealed = [false, false];
    T.revealShows();
    assert(p0.showRevealed[0] === true && p0.showRevealed[1] === false, '单张秀牌只翻开标记的那张（showRevealed=[true,false]）');
    p0.showFlags = [true, true]; p0.showRevealed = [false, false];
    T.revealShows();
    assert(p0.showRevealed[0] === true && p0.showRevealed[1] === true, '双张标记全翻开');
    p0.seatType = keepType; p0.hole = keepHole; p0.showFlags = keepFlags; p0.showRevealed = keepRev;
  }
  // 端到端：新一手发牌后标秀牌，一路弃牌到本手结束，验证"秀牌"日志
  // （以日志增量为信号：单元测试已产生过"秀牌："行，不能只判断存在性）
  let marked = false;
  const showLogBase = logLines.filter(l => l.indexOf('秀牌：') >= 0).length;
  const d3 = Date.now() + 15000;
  while (Date.now() < d3) {
    if (!marked && T.players[0].hole.length === 2) {
      T.setShowFlags(0, [true, true]);
      marked = true;
    }
    if (marked && logLines.filter(l => l.indexOf('秀牌：') >= 0).length > showLogBase) break;
    if (!byId['btn-fold'].disabled) byId['btn-fold'].onclick();
    else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) byId['btn-check'].onclick();
    await sleepTick();
  }
  assert(logLines.filter(l => l.indexOf('秀牌：') >= 0).length > showLogBase, '秀牌的手牌在本手结束翻开（日志出现"秀牌："）');
  // 两张都标记时：日志中秀牌行包含两张牌（逐张记录的 revealShows 对 [true,true] 全翻）
  const showLine = logLines.filter(l => l.indexOf('秀牌：') >= 0).pop() || '';
  assert((showLine.match(/♠|♥|♦|♣/g) || []).length === 2, '双张标记时日志翻开两张牌');

  // 下一手开始后秀牌标记重置
  const d4 = Date.now() + 15000;
  while (Date.now() < d4 && !(T.players[0].showFlags[0] === false && T.players[0].hole.length === 2)) {
    await sleepTick();
  }
  assert(T.players[0].showFlags[0] === false && T.players[0].showFlags[1] === false, '新手牌开始秀牌标记重置');

  /* ---------- 退出牌局：服务器流程 ---------- */
  console.log('--- 退出牌局（服务器流程） ---');
  global.setTimeout = realSetTimeout; // 恢复真实定时器（stub 会破坏 undici/fetch）
  const PORT = 18971;
  const BASE = 'http://localhost:' + PORT;
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), MP_SWEEP: '300', MP_CLIENT_TIMEOUT: '60000', MP_HOST_TIMEOUT: '60000'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { await fetch(BASE + '/'); up = true; } catch (e) { await wallSleep(100); } }
  assert(up, '测试服务器启动');
  const post = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const pollOnce = async (room, id, seq) => (await fetch(BASE + '/api/poll?room=' + room + '&id=' + id + '&seq=' + (seq || 0))).json();

  const host = await post('/api/create', { name: '主机' });
  const c1 = await post('/api/join', { room: host.room, name: '玩家甲' });
  assert(host.ok && c1.ok, '主机创建 + 客机加入');
  let hb = await pollOnce(host.room, host.id, 0);

  // 客机主动退出：主机收到 exited 标记的 left
  await post('/api/msg', { room: host.room, id: c1.id, msg: { type: 'leave' } });
  hb = await pollOnce(host.room, host.id, hb.seq);
  const leftMsg = hb.msgs.filter(x => x.type === 'left').pop();
  assert(!!leftMsg && leftMsg.exited === true && leftMsg.seat === c1.seat, '主机收到退出通知（exited=true，带座位）');

  // 座位已释放：新玩家可加入同一房间
  const c2 = await post('/api/join', { room: host.room, name: '新玩家' });
  assert(c2.ok, '退出后座位释放，新玩家可加入');

  // 主机 close：房间解散，客机收到 closed
  const drained = await pollOnce(host.room, c2.id, 0);
  const hang = pollOnce(host.room, c2.id, drained.seq);
  await wallSleep(150);
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'close' } });
  const cl = await hang;
  assert(cl.msgs.some(x => x.type === 'closed'), '主机退出后客机收到 closed（房间解散）');

  srv.kill();

  console.log('共 ' + (pass + fail) + ' 项断言，通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
