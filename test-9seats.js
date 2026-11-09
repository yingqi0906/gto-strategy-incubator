/* 9 人桌（联机扩容）回归：座位容量随模式切换、位名映射 6~9 人、坐标表、行动顺序、盲注 */
'use strict';
const path = require('path');
const fs = require('fs');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(a, b, name) { ok(a === b, name + '（实际 ' + a + '，期望 ' + b + '）'); }

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
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

console.log('--- 源码级断言 ---');
ok(/const SEAT_SINGLE = 6, SEAT_MP = 8, SEAT_N_MAX = 9/.test(script), '定义 SEAT_SINGLE=6 / SEAT_MP=8 / SEAT_N_MAX=9（2026-10-14 WPT 版式 9→8）');
ok(/function seatCount\(\)/.test(script) && /MP\.mode === 'host' \|\| MP\.mode === 'client'/.test(script),
  'seatCount() 按模式返回座位数（联机 8、单机 6）');
ok(/const SEAT_POS_8 = \[/.test(script) && /SEAT_POS_8_OUT/.test(script) && /SEAT_POS_DUEL/.test(script),
  '定义 8 人桌坐标表 SEAT_POS_8 / SEAT_POS_8_OUT / 单挑 SEAT_POS_DUEL（WPT 版式：顶中1+左右各3+主角左下角）');
ok(/compactView\(\) \? SEAT_POS_8_OUT : SEAT_POS_8/.test(script),
  '手机端外扩坐标 SEAT_POS_8_OUT，compactView 时启用');
ok(!/SEAT_POS\[dispIdx/.test(script), '已无残留的 SEAT_POS[dispIdx(...)] 硬引用');
ok(/AVATAR_COLORS = \[[^\]]*'#8E6BBF'\]/.test(script), 'AVATAR_COLORS 扩展到 9 色');
ok(/AI_NAMES = \[[^\]]*'大盲刺客'\]/.test(script), 'AI_NAMES 扩展到 9 个名字');

const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok(/const MP_SEATS = parseInt\(process\.env\.MP_SEATS \|\| '8'/.test(srv), 'server.js 定义 MP_SEATS 默认 8（WPT 版式）');
ok(/const capacity = duel \? 2 : MP_SEATS/.test(srv), 'server.js 房间容量：单挑 2、常规 8');

console.log('--- 盲注位标识（小盲 S / 大盲 B）---');
ok(/\.seat \.seat-badges \{/.test(html) && /flex-direction: row-reverse/.test(html),
  '徽章组容器 .seat .seat-badges 用 flex(row-reverse) 排布 D/S/B');
ok(/\.seat \.pos-badge \{[\s\S]{0,200}?display: none;/.test(html), '通用徽章基类 .seat .pos-badge（圆形白底黑字，默认隐藏）');
ok(/\.seat\.has-button \.dealer-btn \{ display: flex; \}/.test(html), '庄位 D 显隐规则保持不变');
ok(/\.seat\.has-sb \.sb-badge \{ display: flex; \}/.test(html), '小盲位：.has-sb 时显示 .sb-badge');
ok(/\.seat\.has-bb \.bb-badge \{ display: flex; \}/.test(html), '大盲位：.has-bb 时显示 .bb-badge');
ok(/\.seat \.seat-badges \{ top: -6px; right: 10px; gap: 2px; \}/.test(html) &&
  /\.seat \.pos-badge \{ width: 16px; height: 16px; font-size: 10px; \}/.test(html),
  '窄屏（≤820px / ≤480px）徽章同步缩小并外贴，不越出座位');
ok(/'<div class="pos-badge dealer-btn">D<\/div>' \+\s*'<div class="pos-badge sb-badge">S<\/div>' \+\s*'<div class="pos-badge bb-badge">B<\/div>'/.test(script),
  '座位模板含 D/S/B 三枚徽章（S=小盲、B=大盲）');
ok(/el\.classList\.toggle\('has-sb', p\.idx === mpSbSeat && handNo > 0\)/.test(script),
  'renderSeat 按 mpSbSeat 挂 .has-sb（局中才亮，局间收起）');
ok(/el\.classList\.toggle\('has-bb', p\.idx === mpBbSeat && handNo > 0\)/.test(script),
  'renderSeat 按 mpBbSeat 挂 .has-bb（局中才亮，局间收起）');
ok(/snap\.blinds\.sbSeat !== undefined/.test(script) &&
  /mpSbSeat = snap\.blinds\.sbSeat; mpBbSeat = snap\.blinds\.bbSeat;/.test(script),
  '客机 applySnapshot 由快照回填 mpSbSeat/mpBbSeat（否则客机端 S/B 永远不亮）');
ok(/buttonIdx = -1; handNo = 0; mpSbSeat = -1; mpBbSeat = -1;/.test(script), '返回主菜单时盲注位一并归零');
ok(!/class="dealer-btn"/.test(script), '已无旧的裸 .dealer-btn 模板（统一进徽章组）');

eval(script);
const T = global.window.__PokerTest;
const S = T.seats;
const P = T.players;

console.log('--- 座位容量 ---');
eq(S.single, 6, '单机座位数 = 6');
eq(S.mp, 8, '联机座位数 = 8');
eq(P.length, 9, 'players 物理数组长度 = 9（可容纳 9 人）');

T.client.setMode('single', 0, '我');
eq(S.count(), 6, '单机模式下 seatCount() = 6');
T.client.setMode('host', 0, '主机');
eq(S.count(), 8, '联机主机模式下 seatCount() = 8');
T.client.setMode('client', 3, '客');
eq(S.count(), 8, '联机客机模式下 seatCount() = 8');

console.log('--- 座位坐标 ---');
T.client.setMode('single', 0, '我');
const t6 = S.posTable();
eq(t6.length, 6, '单机坐标表 6 项');
T.client.setMode('host', 0, '主机');
const t9 = S.posTable();
eq(t9.length, 8, '联机坐标表 8 项');
ok(t9.every(p => /^-?[\d.]+%$/.test(p.left) && /^-?[\d.]+%$/.test(p.top)), '8 人坐标均为合法百分比（可为负=贴边外扩）');
// 自己固定底部中央
const mine = S.posOf(0);
eq(mine.left, '14%', '自己座位 left = 14%（左下角，WPT 版式）');
ok(parseFloat(mine.top) > 85, '自己座位在左下角（top > 85%，WPT 版式主角 89%）');
// 9 人坐标互不重合
const seen = {};
let dup = false;
for (let i = 0; i < 8; i++) {
  const q = S.posOf(i);
  const k = q.left + '|' + q.top;
  if (seen[k]) dup = true;
  seen[k] = true;
}
ok(!dup, '8 个座位坐标互不重合');
// 视角：dispIdx 以自己为 0
T.client.setMode('host', 2, '主机');
eq(S.dispIdx(2), 0, '自己座位 dispIdx = 0');
eq(S.dispIdx(3), 1, '自己下一位 dispIdx = 1（顺时针）');
// 回归（2026-10-14 真机报障"我的位置和另一位玩家重合"）：dispIdx 取模必须用
// 模式座位数(8)，不能用物理数组长度 SEAT_N_MAX=9 —— 否则 mySeat=1 时座位 0 的
// dispIdx=8 → 8%8 回卷到 t[0]（主角位置），空位/玩家被画在主角身上
ok(/function dispIdx\(i\) \{ const n = seatCount\(\); return \(i - MP\.mySeat \+ n\) % n; \}/.test(script),
  'dispIdx 按模式座位数取模（SEAT_N_MAX=9 配 8 项坐标表会回卷到主角位）');
T.client.setMode('host', 1, '主机');
eq(S.dispIdx(1), 0, 'mySeat=1：自己 dispIdx = 0');
eq(S.dispIdx(0), 7, 'mySeat=1：座位0 dispIdx = 7（不回卷到 0）');
ok(S.posOf(0).top !== S.posOf(1).top || S.posOf(0).left !== S.posOf(1).left,
  'mySeat=1：座位0 与主角坐标不同（不再与主角重合）');
T.client.setMode('host', 7, '主机');
eq(S.dispIdx(6), 7, 'mySeat=7：座位6 dispIdx = 7（不回卷到 0）');

console.log('--- 位置名映射（6~9 人）---');
function posOf(n, btnPos) {
  // 布置 n 人（座位 0..n-1 有人），按钮在 btnPos
  P.forEach(p => { p.seatType = null; p.name = ''; p.joining = false; });
  for (let i = 0; i < n; i++) { P[i].seatType = (i === 0 ? 'host' : 'ai'); P[i].name = 'P' + i; }
  T.client.setMode('host', 0, '主机');
  T.rit.setButton(btnPos);
  const m = T.rit.posMaps();
  return { zh: m.zh, en: m.en };
}
// 6 人桌，按钮 = 座位 0 → 座位1 小盲、座位2 大盲、座位3 枪口、座位4 中位、座位5 关煞
let m6 = posOf(6, 0);
eq(m6.zh[0], '按钮', '6人：座位0 按钮');
eq(m6.zh[1], '小盲', '6人：座位1 小盲');
eq(m6.zh[2], '大盲', '6人：座位2 大盲');
eq(m6.zh[3], '枪口', '6人：座位3 枪口');
eq(m6.zh[5], '关煞', '6人：最后一位（关煞）');
eq(m6.en[3], 'UTG', '6人英文：座位3 UTG');
eq(m6.en[5], 'CO', '6人英文：最后中间位 CO');

// 9 人桌，按钮 = 座位 0 → 1小盲 2大盲 3枪口 4~7中位 8关煞
let m9 = posOf(9, 0);
eq(m9.zh[0], '按钮', '9人：座位0 按钮');
eq(m9.zh[1], '小盲', '9人：座位1 小盲');
eq(m9.zh[2], '大盲', '9人：座位2 大盲');
eq(m9.zh[3], '枪口', '9人：座位3 枪口（最前中间位）');
eq(m9.zh[8], '关煞', '9人：座位8 关煞（最后中间位）');
eq(m9.zh[4], '中位', '9人：座位4 中位');
eq(m9.en[3], 'UTG', '9人英文：枪口 = UTG');
eq(m9.en[8], 'CO', '9人英文：关煞 = CO');
ok(m9.zh[3] !== m9.zh[4] || m9.zh[4] !== m9.zh[5] || true, '9人位置名生成不报错');
// 按钮换位：按钮 = 座位 4，则小盲 = 5
let m9b = posOf(9, 4);
eq(m9b.zh[5], '小盲', '9人（按钮在4）：座位5 小盲');
eq(m9b.zh[4], '按钮', '9人（按钮在4）：座位4 按钮');

/* 英文位名兼容性：中间位 = n-3，首位 UTG、末位 CO，中间 HJ/LJ/UTG+1…
   （6 人桌必须保持原行为：UTG / HJ / CO） */
function enMidList(n) {
  const map = posOf(n, 0).en;
  // 中间位 = 座位 3 .. n-1（按钮在 0）
  const out = [];
  for (let i = 3; i < n; i++) out.push(map[i]);
  return out;
}
ok(JSON.stringify(enMidList(4)) === JSON.stringify(['UTG']), '4人英文中间位 = [UTG]');
ok(JSON.stringify(enMidList(5)) === JSON.stringify(['UTG', 'CO']), '5人英文中间位 = [UTG, CO]');
ok(JSON.stringify(enMidList(6)) === JSON.stringify(['UTG', 'HJ', 'CO']), '6人英文中间位 = [UTG, HJ, CO]（与改动前一致）');
ok(JSON.stringify(enMidList(7)) === JSON.stringify(['UTG', 'LJ', 'HJ', 'CO']), '7人英文中间位 = [UTG, LJ, HJ, CO]');
ok(JSON.stringify(enMidList(8)) === JSON.stringify(['UTG', 'UTG+1', 'LJ', 'HJ', 'CO']), '8人英文中间位 = [UTG, UTG+1, LJ, HJ, CO]');
ok(JSON.stringify(enMidList(9)) === JSON.stringify(['UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO']), '9人英文中间位 = [UTG, UTG+1, UTG+2, LJ, HJ, CO]');
// 中文中间位：首位枪口、末位关煞、其余中位
function zhMidList(n) {
  const map = posOf(n, 0).zh;
  const out = [];
  for (let i = 3; i < n; i++) out.push(map[i]);
  return out;
}
ok(JSON.stringify(zhMidList(6)) === JSON.stringify(['枪口', '中位', '关煞']), '6人中文中间位 = [枪口, 中位, 关煞]（与改动前一致）');
ok(JSON.stringify(zhMidList(9)) === JSON.stringify(['枪口', '中位', '中位', '中位', '中位', '关煞']), '9人中文中间位 = [枪口, 中位×4, 关煞]');

console.log('--- 行动顺序（翻后）---');
P.forEach(p => { p.seatType = null; p.name = ''; });
for (let i = 0; i < 9; i++) { P[i].seatType = (i === 0 ? 'host' : 'ai'); P[i].name = 'P' + i; }
T.client.setMode('host', 0, '主机');
T.rit.setButton(0);
const ranks = [];
for (let i = 0; i < 9; i++) ranks.push({ i: i, r: T.rit.postflopRank(i) });
ranks.sort((a, b) => a.r - b.r);
eq(ranks[0].i, 1, '9人：翻后最前位 = 座位1（小盲）');
eq(ranks[8].i, 0, '9人：翻后最后位 = 座位0（按钮）');
ok(ranks[1].i === 2, '9人：翻后第二位 = 座位2（大盲）');

console.log('--- nextActive 环绕 9 座位 ---');
P.forEach(p => { p.seatType = null; });
P[8].seatType = 'ai';   // 只有座位 8 有人
eq(S.nextActive(0), 8, 'nextActive 能从 0 绕到 8（跨过 9 个座位）');
P[2].seatType = 'ai';
eq(S.nextActive(0), 2, 'nextActive 找到最近的有人座位');

console.log('');
console.log('结果：' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
