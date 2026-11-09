/* test-panel-info.js — 对局信息面板 v2（方案A细化版）回归
   覆盖：层级结构渲染 / 手牌呈现规则（单机全秀 · 联机未摊牌显牌背） / 判定徽章
   用法：node test-panel-info.js                                            */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; failures.push(msg + (extra ? '   [' + extra + ']' : '')); }
}

/* ---------- 极简 DOM stub（与 harness.js 同源） ---------- */
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
    this.min = ''; this.max = ''; this.step = '';
    this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null;
    this._qs = {}; this._listeners = {};
  }
  get classList() {
    const s = this;
    return {
      add: c => s._class.add(c),
      remove: c => s._class.delete(c),
      toggle: (c, f) => { if (f === undefined) { s._class.has(c) ? s._class.delete(c) : s._class.add(c); } else if (f) s._class.add(c); else s._class.delete(c); },
      contains: c => s._class.has(c)
    };
  }
  appendChild(ch) { ch.parentNode = this; this.children.push(ch); return ch; }
  removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}
const byId = {};
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(t) { return new FakeEl(t); },
  addEventListener() {},
  body: new FakeEl('body'), documentElement: new FakeEl('html'), hidden: false
};
global.window = global;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { return setImmediate(fn); };

require('./core.js');
global.PokerCore = module.require('./core.js');

const file = path.join(__dirname, 'gto策略培养皿.html');
const html = fs.readFileSync(file, 'utf8');
const sm = html.match(/<script>([\s\S]*?)<\/script>/);
if (!sm) { console.error('未找到内嵌脚本'); process.exit(1); }
eval(sm[1]);

const $ = id => byId[id];
const tick = (ms) => new Promise(r => realSetTimeout(r, ms || 0));

(async function main() {
  const T = window.__PokerTest;

  /* ---------- 1) 静态：层级阶梯 CSS 与渲染函数就位 ---------- */
  ok(/--ind-street:\s*0px/.test(html), 'CSS：街道缩进 0px');
  ok(/--ind-act:\s*12px/.test(html), 'CSS：动作行缩进 12px');
  ok(/--ind-gto:\s*40px/.test(html), 'CSS：GTO 建议缩进 40px（最深）');
  ok(/\.mcard\.md\s*\{\s*width:\s*17px;\s*height:\s*24px/.test(html), 'CSS：迷你牌 17×24 规格存在');
  ok(html.indexOf('.lg-verdict.ok') >= 0 && html.indexOf('.lg-verdict.warn') >= 0 && html.indexOf('.lg-verdict.bad') >= 0,
    'CSS：判定徽章三态齐备');
  ok(/\.mcard\.lg\s*\{\s*width:\s*28px;\s*height:\s*39px/.test(html), 'CSS：起手牌行大迷你牌 28×39 规格存在');
  ok(/#log \.lg2\.ln-hole\s*\{/.test(html) && /#log \.lg2\.ln-hole \.hlab/.test(html), 'CSS：手牌行（who+标签+迷你牌）样式就位');
  ok(/#side-panel\s*\{[^}]*width:\s*340px/.test(html), 'CSS：对局信息面板加宽至 340px');

  /* ---------- 2) 跑若干真实牌局 ---------- */
  $('btn-start').onclick();
  const log = $('log');
  const t0 = Date.now();
  let lastStarts = 0, stall = 0;
  while (Date.now() - t0 < 60000) {
    await tick(0);
    const chk = $('btn-check'), fold = $('btn-fold');
    if (chk && !chk.disabled && chk.onclick && /过牌|跟注/.test(chk.textContent || '')) chk.onclick();
    else if (fold && !fold.disabled && fold.onclick) fold.onclick();
    const n = log.children.filter(r => /^===== 第 \d+ 局 =====$/.test(r.textContent || '')).length;
    if (n >= 6 && n === lastStarts) { if (++stall >= 3) break; } else stall = 0;
    lastStarts = n;
  }

  const rows = log.children;
  const clsOf = r => String(r.className || '');
  ok(rows.length > 20, '牌局写入日志行', 'rows=' + rows.length);
  ok(rows.some(r => clsOf(r).indexOf('lg2-street') >= 0), '街道标题按新样式渲染（全宽金边）');
  ok(rows.some(r => clsOf(r).indexOf('lg2-act') >= 0), '动作行按新样式渲染（色点+手牌+胶囊+金额）');
  ok(rows.some(r => clsOf(r).indexOf('lg2-opt') >= 0), 'GTO 建议块按新样式渲染（分布条+选项行）');
  ok(rows.some(r => clsOf(r).indexOf('lg2-potbar') >= 0), '结算底池条渲染');
  ok(rows.some(r => clsOf(r).indexOf('mine') >= 0), '我的行动行带高亮标记');

  /* 手牌行：开局亮牌 / allin 亮牌的"手牌：…"行 → who + 标签 + 迷你牌图片 */
  const holeRows = rows.filter(r => clsOf(r).indexOf('lg2-hole') >= 0);
  ok(holeRows.length > 0, '存在手牌行（lg2-hole）样本', 'n=' + holeRows.length);
  if (holeRows.length) {
    const h = holeRows[0].innerHTML || '';
    ok(h.indexOf('class="who"') >= 0 && h.indexOf('hlab') >= 0, '手牌行含玩家名块与"手牌"标签');
    ok(/class="mcard md"/.test(h), '手牌行手牌用迷你牌图片渲染');
    ok((holeRows[0].textContent || '').indexOf('手牌：') >= 0, '手牌行纯文本摘要保留（测试依赖）');
  }

  /* 动作行必须带：位置小字 / 语义色胶囊 / 金额或 — / 迷你牌 */
  const actRow = rows.filter(r => clsOf(r).indexOf('lg2-act') >= 0)[0];
  ok(!!actRow, '存在动作行样本');
  if (actRow) {
    const h = actRow.innerHTML || '';
    ok(h.indexOf('class="who"') >= 0, '动作行含玩家名块');
    ok(h.indexOf('lg-pill ') >= 0, '动作行含语义色胶囊');
    ok(h.indexOf('class="amt') >= 0, '动作行含金额位（无金额显示 —）');
    ok(/class="mcard (md|md back)"/.test(h), '动作行含迷你手牌');
  }
  /* GTO 块：首行带频率分布条、末行收圆角 */
  const optRows = rows.filter(r => clsOf(r).indexOf('lg2-opt') >= 0);
  ok(optRows.some(r => (r.innerHTML || '').indexOf('lg-freq') >= 0), 'GTO 块含行动频率分布条');
  ok(optRows.some(r => clsOf(r).indexOf('gto-last') >= 0), 'GTO 块末行带收尾标记');

  /* ---------- 3) 手牌呈现规则 ---------- */
  const P = T.players;
  let aiSeat = -1;
  for (let i = 0; i < P.length; i++) {
    if (P[i].seatType === 'ai' && P[i].hole && P[i].hole.length === 2) { aiSeat = i; break; }
  }
  ok(aiSeat >= 0, '找到一名 AI 玩家用于手牌规则校验');

  if (aiSeat >= 0) {
    P[aiSeat].revealed = false;

    // 单机：全秀开（用户明确要求保留）
    T.client.setMode('single', 0, '我');
    const single = T.debug.panelCards(aiSeat);
    ok(!!single && single.length === 2 && single.every(c => c.back === false),
      '单机模式：对手手牌全部真实显示（保留"全秀开"规则）');

    // 联机：未摊牌 → 牌背
    T.client.setMode('host', 0, '房主');
    const mpHide = T.debug.panelCards(aiSeat);
    ok(!!mpHide && mpHide.length === 2 && mpHide.every(c => c.back === true),
      '联机模式：未摊牌对手手牌显示牌背');

    // 联机：摊牌后 → 真实手牌
    P[aiSeat].revealed = true;
    const mpShow = T.debug.panelCards(aiSeat);
    ok(!!mpShow && mpShow.every(c => c.back === false),
      '联机模式：已摊牌对手显示真实手牌');

    // 联机：自己的牌始终可见
    P[aiSeat].revealed = false;
    const mine = T.debug.panelCards(0);
    ok(!!mine && mine.every(c => c.back === false), '联机模式：自己的手牌始终可见');

    // 回到单机
    T.client.setMode('single', 0, '我');
    const back = T.debug.panelCards(aiSeat);
    ok(!!back && back.every(c => c.back === false), '切回单机后恢复全秀开');
  }

  /* 单机牌局日志中不应出现牌背 */
  const backRows = rows.filter(r => (r.innerHTML || '').indexOf('mcard md back') >= 0).length;
  ok(backRows === 0, '单机模式：牌局日志中无牌背', 'backRows=' + backRows);

  /* 顶部起手牌行：手牌/公共牌用 lg 迷你牌图片 */
  const hintHtml = String($('hand-hint').innerHTML || '');
  ok(hintHtml.indexOf('mcard lg') >= 0, '顶部起手牌行：手牌用 28×39 迷你牌图片渲染');
  ok(hintHtml.indexOf('起手牌') >= 0 || hintHtml.indexOf('当前牌型') >= 0, '顶部起手牌行：文本标签保留');

  /* ---------- 4) 判定徽章 ---------- */
  const V = T.debug.actVerdict;
  ok(V({ type: 'fold', opts: [{ act: { type: 'fold' }, prob: 1, chosen: true }] }).state === 'ok',
    '判定：弃牌在策略内 → ✓ 符合');
  ok(V({ type: 'raise', to: 5, opts: [{ act: { type: 'raise', to: 5 }, prob: 0.3, chosen: true }] }).state === 'ok',
    '判定：命中任一建议尺寸 → ✓ 符合（低频 30% 也算）');
  ok(V({ type: 'raise', to: 1.5, opts: [{ act: { type: 'raise', to: 3.5 }, prob: 0.6, chosen: true }] }).state === 'warn',
    '判定：尺寸不在策略内 → ⚠ 尺寸偏离');
  ok(V({ type: 'call', opts: [{ act: { type: 'fold' }, prob: 1, chosen: true }] }).state === 'bad',
    '判定：行动类型不在策略内 → ✗ 偏离');
  ok(V({ type: 'raise', to: 9, opts: [{ act: { type: 'raise', to: 3.5 }, prob: 0.6, chosen: false, _dev: true }] }).state === 'warn',
    '判定：被就近改写的尺寸 → ⚠ 尺寸偏离');
  ok(V({ type: 'check', opts: [] }) === null, '判定：无策略数据时不显示徽章');

  /* ---------- 5) 多人模式：只显示玩家动作（无 GTO 建议 / 无判定胶囊） ---------- */
  {
    const pa = T.players[0];
    const actWithOpts = { type: 'call', to: 2, opts: [{ act: { type: 'call' }, prob: 0.6, chosen: true }] };

    T.client.setMode('host', 0, '房主');
    const n0 = log.children.length;
    ok(T.debug.showAdvice() === false, '多人模式：策略分析展示开关关闭');
    T.debug.logAction(pa, actWithOpts, '跟注2', { potBefore: 10, toCall: 2, prevBet: 2 });
    const added = log.children.slice(n0);
    ok(added.length === 1, '多人模式：一次行动只写 1 行（仅动作行）', 'n=' + added.length);
    ok(added.length && clsOf(added[0]).indexOf('lg2-act') >= 0, '多人模式：动作行照常渲染');
    ok(!added.some(r => (r.innerHTML || '').indexOf('lg-verdict') >= 0), '多人模式：动作行不含"是否符合"判定胶囊');
    ok(!added.some(r => clsOf(r).indexOf('lg2-opt') >= 0), '多人模式：不产生 GTO 建议块');

    /* 客机视角同样不展示 */
    T.client.setMode('client', 1, '客机');
    const n1 = log.children.length;
    T.debug.logAction(pa, actWithOpts, '跟注2', { potBefore: 10, toCall: 2, prevBet: 2 });
    const addedC = log.children.slice(n1);
    ok(addedC.length === 1 && !addedC.some(r => clsOf(r).indexOf('lg2-opt') >= 0), '客机视角：同样只显示动作行');

    /* 对照：单机模式仍展示建议块 + 判定胶囊 */
    T.client.setMode('single', 0, '我');
    const n2 = log.children.length;
    ok(T.debug.showAdvice() === true, '单机模式：策略分析展示开关开启（对照组）');
    T.debug.logAction(pa, { type: 'call', to: 2, gtoAdvice: [{ act: { type: 'call' }, prob: 0.6, chosen: true }] },
      '跟注2', { potBefore: 10, toCall: 2, prevBet: 2 });
    const added2 = log.children.slice(n2);
    ok(added2.some(r => clsOf(r).indexOf('lg2-opt') >= 0), '单机模式：仍显示 GTO 建议块（对照组）');
    ok(added2.some(r => (r.innerHTML || '').indexOf('lg-verdict') >= 0), '单机模式：仍显示判定胶囊（对照组）');
  }

  /* ---------- 顶部起手牌跟随所选对局（2026-10-20） ---------- */
  {
    ok(/const histHole = \{\};/.test(html) &&
       /histHole\[handNo\] = \(meE\.hole \|\| \[\]\)\.map/.test(html),
      '① 本手结束时记录"我当时"的起手牌到 histHole（本地视角，联机客机也各记各的）');
    ok((html.match(/for \(const hk in histHole\) delete histHole\[hk\];/g) || []).length >= 7,
      '① 全部对局重置点（开局/退出/恢复）都清空 histHole');
    ok(/if \(viewMode === 'hist'\) \{[\s\S]*?histHole\[selHandNo\][\s\S]*?第 ' \+ selHandNo \+ ' 局起手牌/.test(html),
      '① 查看历史对局时顶部显示该局起手牌（未参与则显示"未参与本局"）');
    ok(/refreshHistBtn\(\);\s*\n\s*updateHint\(\);/.test(html),
      '① 下拉切换对局时刷新顶部起手牌（实时=当前手牌；历史=该局手牌）');
  }

  /* ---------- 结果 ---------- */
  console.log('=== 对局信息面板 v2 测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
