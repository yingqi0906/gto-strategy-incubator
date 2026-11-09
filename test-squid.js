/* 鱿鱼游戏功能测试
   1) 无头 UI：菜单入口、发起弹窗（滑杆 1~20bb 默认 5）、投票通过/拒绝/超时、
      AI 自动同意、标记发放（重复不获得）、结束支付与自动买入、中途加入人数同步、
      快照同步（投票条/标记/提示）、座位名称旁标记图形
   2) 服务器中继 E2E：客机 squid_propose / squid_vote 中继主机、快照 squid 字段下发 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };

/* ================= 第一部分：无头 UI 测试 ================= */
function uiTests() {
  console.log('--- 无头 UI：鱿鱼游戏 ---');
  const fs = require('fs');

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

  const byId = {};
  function seed(id, cls) {
    const e = new FakeEl();
    (cls || []).forEach(c => e.classList.add(c));
    byId[id] = e;
    return e;
  }
  const squidModal = seed('squid-modal', ['modal', 'hidden']);
  const squidToggle = seed('squid-toggle', []);
  const squidSlider = seed('squid-slider', []);
  const squidPrice = seed('squid-price', []);
  const squidVoteBar = seed('squid-vote', []);
  const svPrice = seed('sv-price', []);
  const svInfo = seed('sv-info', []);
  const svBtns = seed('sv-btns', []);
  const svYes = seed('btn-sv-yes', []);
  const svNo = seed('btn-sv-no', []);
  const squidToastEl = seed('squid-toast', []);
  const squidLeftEl = seed('squid-left', []);
  const squidLeftN = squidLeftEl.querySelector('b'); // 牌桌中间 🦑 ×N 的数字
  seed('squid-slider', []);
  byId['squid-slider'] = squidSlider;

  global.document = {
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener() {}
  };
  global.window = global;
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); // mpSend 不抛错
  global.PokerCore = require('./core.js');
  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  eval(m[1]);
  const T = global.window.__PokerTest;

  /* ---------- 源码级 ---------- */
  ok(/<div id="menu-list"[^>]*>[\s\S]*?id="squid-toggle"/.test(html), '菜单中包含"🦑 鱿鱼游戏"入口按钮');
  ok(/#squid-vote\s*\{[^}]*position:\s*fixed[^}]*top:[^}]*right:\s*10px/.test(html), '投票条固定于顶部（不遮挡牌局操作）');
  ok(/id="squid-slider"\s+min="1"\s+max="20"\s+step="1"\s+value="5"/.test(html), '价格滑杆 1~20bb、步进 1bb、默认 5bb');
  ok(html.includes('id="btn-squid-go"') && html.includes('>发起投票</button>'), '发起弹窗底部有"发起投票"按钮');
  ok(html.includes('id="btn-sv-yes"') && html.includes('id="btn-sv-no"'), '投票界面有 同意/拒绝 按钮');
  ok(/ squid: \{[\s\S]*?active: squid\.active[\s\S]*?markers: squid\.markers/.test(html), '快照携带鱿鱼游戏状态（active/markers/vote）');
  ok(html.includes('if (bestSeats.length === 1) squidAwardPot(bestSeats[0]);'), '摊牌：仅全体未弃牌玩家中手牌唯一最大者发标记');
  ok(!html.includes('if (winners.length === 1) squidAwardPot(winners[0])'), '已移除"每个子池单一赢家即发标记"的旧逻辑（边池赢家不获得）');
  ok(html.includes('squidAwardPot(winner.idx)'), '弃牌获胜（等同手牌最大）同样发标记');
  ok(/const left = Math\.max\(0, unmarked - 1\);/.test(html), '牌桌中间数量 = 未标记人数 - 1（即场上玩家数 - 1）');

  /* ---------- 源码级：投票面板 v2（SVG 头部 / 规则拆条 / 价格区块 / 按钮主次 / 进度条） ---------- */
  const modalSeg = html.slice(html.indexOf('id="squid-modal"'), html.indexOf('id="rit-modal"'));
  ok(/class="sq-head"[\s\S]*?viewBox="0 0 680 680"[\s\S]*?class="sq-t">鱿鱼游戏</.test(modalSeg), '弹窗 v2：SVG 鱿鱼头部 + 金色标题（emoji 已替换）');
  ok(!modalSeg.includes('🦑'), '弹窗 v2：不再出现 🦑 emoji（跨端渲染一致）');
  ok((modalSeg.match(/class="rule"/g) || []).length === 3 && /class="no">1</.test(modalSeg), '弹窗 v2：规则拆成 3 条编号行');
  ok(modalSeg.includes('全员同意') && modalSeg.includes('边池赢家与平分底池不可获得') && modalSeg.includes('1 名玩家'), '弹窗 v2：三条规则要点齐全');
  ok(modalSeg.includes('class="sq-price"') && modalSeg.includes('鱿鱼价格 · 即罚金') && modalSeg.includes('范围 1 – 20 bb'), '弹窗 v2：价格区块化（标注"即罚金"与范围）');
  ok(modalSeg.includes('class="val"') && modalSeg.includes('id="squid-price"') && modalSeg.includes('<small>bb</small>'), '弹窗 v2：大号等宽价格数字 + bb 单位小字');
  ok(modalSeg.includes('<span>10bb</span>'), '弹窗 v2：滑条补中点刻度 10bb');
  ok(/\.sq-actions \.btn \{ flex: 1; \}[\s\S]*?\.sq-actions \.btn\.primary \{ flex: 1\.6; \}/.test(html), '弹窗 v2：发起投票加宽为主动作（主次 2:1）');
  ok(html.includes('sv-prog-fill') && /sv-prog-fill[\s\S]*?style\.width = /.test(html), '投票条 v2：含同意进度条且随票数刷新');
  ok(html.includes('class="sv-price" id="sv-price"') && html.includes('class="sv-title">鱿鱼游戏投票</span>'), '投票条 v2：标题 + 价格胶囊分列（头部行重排）');

  /* ---------- 行为级 ---------- */
  const st = () => T.squid.state();
  ok(st().active === false && st().pendingStart === false && st().vote === null, '初始：未开启、无待开始、无投票');

  /* 发起弹窗 */
  squidToggle.onclick();
  ok(!squidModal.classList.contains('hidden'), '点击菜单"鱿鱼游戏"打开发起弹窗');
  squidSlider.value = 12;
  squidSlider.oninput.call(squidSlider);
  ok(String(squidPrice.textContent) === '12', '拖动滑杆实时显示价格（一格 1bb）');
  T.squid.reset();
  ok(st().active === false && st().vote === null && st().price === 5, '退出牌局时状态归零（含弹窗关闭逻辑在 exitToMenu）');

  /* 主机开局：清空 initSingle 预填座位，仅 主机 + 客机 + AI */
  T.client.setMode('host', 0, '主机');
  const P = T.players;
  P.forEach(p => { p.seatType = null; p.name = ''; p.chips = 0; p.brought = 0; p.joining = false; });
  P[0].seatType = 'host'; P[0].name = '主机'; P[0].chips = 100; P[0].brought = 100;
  P[1].seatType = 'client'; P[1].name = '客机一'; P[1].chips = 100; P[1].brought = 100;
  P[2].seatType = 'ai'; P[2].name = 'AI测试'; P[2].chips = 100; P[2].brought = 100;

  /* 发起投票：AI 自动同意 */
  T.squid.startVote(0, 7);
  ok(st().vote && st().vote.price === 7 && st().vote.proposerSeat === 0, '主机发起投票：价格 7bb、发起人为主机');
  ok(st().vote.need === 2 && st().vote.yesSeats.length === 1 && st().vote.yesSeats[0] === 2, '需 2 人同意，AI 座位自动同意');
  ok(squidVoteBar.classList.contains('show') && svPrice.textContent === '7bb', '顶部投票条显示，价格正确');
  ok(svBtns.style.display === 'none', '发起人本人不显示 同意/拒绝 按钮');
  ok(svInfo.textContent.indexOf('1/2') >= 0 && svInfo.textContent.indexOf('剩余') >= 0, '投票条显示同意进度与倒计时');
  ok(String(byId['sv-prog-fill'].style.width) === '50%', '投票条进度条与同意数同步（1/2 → 50%）');

  /* 全员同意 → 下一手开启提示 */
  T.squid.castVote(1, true);
  ok(st().vote === null && st().pendingStart === true && st().price === 7, '全部同意后投票关闭，标记"下一手开始"');
  ok(st().msg.indexOf('下一手牌将开始鱿鱼游戏') >= 0 && st().msg.indexOf('7bb') >= 0, '全员提示：下一手牌将开始鱿鱼游戏，价格为 xbb');
  ok(squidToastEl.classList.contains('show') && squidToastEl.textContent.indexOf('下一手牌将开始鱿鱼游戏') >= 0, '提示以弹窗形式全员展示');
  ok(!squidVoteBar.classList.contains('show'), '投票结束后投票条收起');

  /* 拒绝投票（先重置上一轮的 pendingStart，验证可再次发起） */
  T.squid.reset();
  T.squid.startVote(0, 5);
  T.squid.castVote(1, false);
  ok(st().vote === null && st().pendingStart === false, '任一玩家拒绝 → 投票立即失败');
  ok(st().msg.indexOf('未通过') >= 0, '拒绝提示');

  /* 超时视为拒绝（30 秒计时到期走同一裁决路径） */
  T.squid.startVote(0, 5);
  T.squid.resolve(false);
  ok(st().vote === null && st().pendingStart === false && st().msg.indexOf('未通过') >= 0, '30 秒超时未投 → 视为拒绝');

  /* 标记发放与结束支付 */
  T.squid.setActive(true, 5);
  ok(st().active === true, '鱿鱼游戏开启');
  T.squid.uiSync();
  ok(squidLeftN.textContent === '×2', '牌桌中间显示 ×2：在座 3 人 - 1（最后一人注定没有标记）');
  T.squid.award(0);
  ok(st().markers[0] === true, '首次收池获得 🦑 标记');
  ok(squidLeftN.textContent === '×1', '发放一个标记后剩余 ×1（还需 1 个标记才定出输家）');
  const logLenAfterDup = T.logLines().length;
  T.squid.award(0);
  ok(st().markers[0] === true && T.logLines().length === logLenAfterDup, '已标记玩家再次收池不再获得');
  T.squid.award(2);
  ok(st().markers[2] === true, '第二名玩家收池获得标记');
  ok(squidLeftN.textContent === '×0', '仅剩 1 人未标记 → 剩余数归零');
  /* 此时未标记仅剩座位 1 → 结束：座位 1 向座位 0、2 各支付 5bb */
  const c0 = P[0].chips, c1 = P[1].chips, c2 = P[2].chips;
  T.squid.checkEnd();
  ok(st().active === false, '仅剩 1 名未标记玩家 → 鱿鱼游戏结束');
  ok(P[0].chips === c0 + 5 && P[2].chips === c2 + 5, '标记玩家各收到 5bb 鱿鱼价格');
  ok(P[1].chips === c1 - 10, '未标记玩家支付 5bb × 2 人 = 10bb');
  ok(st().markers.every(x => !x), '结束后标记清零');
  ok(st().msg.indexOf('鱿鱼游戏结束') >= 0, '结束全员提示');

  /* 支付前自动买入 */
  T.squid.setActive(true, 20);
  T.squid.award(0); T.squid.award(1);
  P[2].chips = 5;
  T.squid.checkEnd();
  ok(P[2].brought === 100 + 35 && P[2].chips === 0, '筹码不足：支付前自动买入 35bb（总价 40bb）');
  ok(P[0].chips === c0 + 5 + 20 && P[1].chips === c1 - 10 + 20, '自动买入后按 20bb × 2 人完成支付');

  /* 中途加入：人数同步参与 */
  T.squid.setActive(true, 5);
  T.squid.reset(); // 清 markers（不影响 chips）
  T.squid.setActive(true, 5);
  P[3].seatType = 'client'; P[3].name = '新人'; P[3].chips = 100; P[3].brought = 100; P[3].joining = true;
  T.squid.award(0); T.squid.award(1);
  T.squid.checkEnd(); // 未标记 = 座位2 + 新人座位3 → 不结束
  ok(st().active === true, '中途加入者同为未标记 → 游戏继续');
  const b0 = P[0].chips;
  T.squid.award(3);
  T.squid.checkEnd(); // 未标记仅剩座位2 → 向 0、1、3 三人支付
  ok(st().active === false, '新人获得标记后，最后未标记者需支付');
  ok(P[0].chips === b0 + 5 && P[3].chips === 105, '支付人数按支付时在座人数同步（新人也收 5bb）');

  /* 客机视角：快照同步 + 投票条 + 标记图形 */
  P.forEach(p => { p.seatEl = new FakeEl(); p.betEl = new FakeEl(); });
  T.client.setMode('client', 1, '客机一');
  T.squid.reset();
  T.squid.startVote; // noop 引用
  const endsAt = Date.now() + 30000;
  T.client.applySnapshot({
    phase: 'playing', handNo: 3, board: [], collectedPot: 0, roundStartPot: 0,
    currentBet: 0, lastRaiseSize: 1, buttonIdx: 0, actingIdx: -1, log: [], hist: [], exited: [],
    seats: P.map(p => ({ name: p.name, type: p.seatType, chips: p.chips, bet: 0, contrib: 0, brought: p.brought,
      inHand: false, allIn: false, winner: false, revealed: false, posName: '', offline: false, joining: false })),
    squid: {
      active: true, price: 8, pendingStart: false,
      markers: [true, false, false, false, false, false],
      vote: { price: 8, proposerSeat: 0, proposerName: '主机', need: 2, yesSeats: [2], endsAt: endsAt },
      msg: '鱿鱼游戏开始', msgId: 5, msgAt: Date.now()
    }
  });
  ok(st().active === true && st().price === 8 && st().markers[0] === true, '客机经快照同步鱿鱼状态与标记');
  ok(squidLeftN.textContent === '×2', '客机同样按"在座人数 - 1"重算（4 人在座、1 人已标记 → ×2）');
  ok(st().vote && st().vote.price === 8 && st().vote.need === 2, '客机同步到进行中的投票');
  ok(squidVoteBar.classList.contains('show') && svBtns.style.display === 'flex', '客机显示顶部投票条与 同意/拒绝 按钮');
  ok(squidToastEl.classList.contains('show') && squidToastEl.textContent.indexOf('鱿鱼游戏开始') >= 0, '客机弹出最新全员提示');
  ok(P[0].seatEl.querySelector('.name').innerHTML.indexOf('🦑') >= 0, '鱿鱼标记图形显示于玩家名称旁');
  /* 投出同意票（经 mpSend 中继，无异常即可） */
  svYes.onclick();
  ok(true, '客机点击同意正常提交（经服务器中继）');
  /* 过期消息不补弹（重连/中途加入场景） */
  T.squid.reset();
  squidToastEl.classList.remove('show');
  T.client.applySnapshot({
    phase: 'playing', handNo: 4, board: [], collectedPot: 0, roundStartPot: 0,
    currentBet: 0, lastRaiseSize: 1, buttonIdx: 0, actingIdx: -1, log: [], hist: [], exited: [],
    seats: P.map(p => ({ name: p.name, type: p.seatType, chips: p.chips, bet: 0, contrib: 0, brought: p.brought,
      inHand: false, allIn: false, winner: false, revealed: false, posName: '', offline: false, joining: false })),
    squid: { active: false, price: 5, pendingStart: false, markers: [false,false,false,false,false,false],
      vote: null, msg: '旧消息', msgId: 9, msgAt: Date.now() - 60000 }
  });
  ok(!squidToastEl.classList.contains('show'), '重连收到过期提示（>5 秒）不补弹');

  return { pass, fail };
}

/* ================= 第二部分：服务器中继 E2E ================= */
async function serverTests() {
  console.log('--- 服务器中继：鱿鱼游戏消息 ---');
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
  const pollOnce = async (room, id, seq) => (await fetch(BASE + '/api/poll?room=' + room + '&id=' + id + '&seq=' + (seq || 0))).json();

  const host = await post('/api/create', { name: '主机' });
  const c1 = await post('/api/join', { room: host.room, name: '客机一' });
  ok(host.ok && c1.ok, '主机与客机入座');

  /* 客机发起投票 → 中继主机（带座位） */
  await post('/api/msg', { room: host.room, id: c1.id, msg: { type: 'action', action: { type: 'squid_propose', price: 8 } } });
  const hb = await pollOnce(host.room, host.id, 0);
  const prop = hb.msgs.filter(x => x.type === 'action' && x.action && x.action.type === 'squid_propose');
  ok(prop.length === 1 && prop[0].seat === c1.seat && prop[0].action.price === 8,
    '客机发起投票中继主机（带座位与价格）');

  /* 客机投票 → 中继主机 */
  await post('/api/msg', { room: host.room, id: c1.id, msg: { type: 'action', action: { type: 'squid_vote', choice: 'yes' } } });
  const hb2 = await pollOnce(host.room, host.id, hb.seq);
  const vote = hb2.msgs.filter(x => x.type === 'action' && x.action && x.action.type === 'squid_vote');
  ok(vote.length === 1 && vote[0].seat === c1.seat && vote[0].action.choice === 'yes',
    '客机投票中继主机（带座位与选择）');

  /* 主机广播快照（含 squid 字段）→ 客机收到（personalize 透传） */
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'state', snap: {
    phase: 'playing', handNo: 1, seats: [],
    squid: { active: true, price: 8, pendingStart: false, markers: [true, false], vote: null, msg: '开始', msgId: 1, msgAt: Date.now() }
  } } });
  const cb = await pollOnce(host.room, c1.id, 0);
  const stateMsgs = cb.msgs.filter(x => x.type === 'state');
  ok(stateMsgs.length === 1 && stateMsgs[0].snap && stateMsgs[0].snap.squid &&
     stateMsgs[0].snap.squid.active === true && stateMsgs[0].snap.squid.price === 8 &&
     stateMsgs[0].snap.squid.markers[0] === true,
    '快照携带 squid 字段下发客机（标记/价格透传）');

  srv.kill();
  await sleep(150);
}

(async function main() {
  const realFetch = global.fetch; // 保存原生 fetch（UI 阶段的 stub 会覆盖它）
  const ui = uiTests();
  console.log('--- 无头 UI 小计: ' + ui.pass + ' 通过, ' + ui.fail + ' 失败 ---');
  global.fetch = realFetch; // E2E 阶段恢复真实 fetch
  await serverTests();
  console.log('\n=== 鱿鱼游戏测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
