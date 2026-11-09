/* 大牌提示（缎带）测试
   规则（2026-10-27 用户拍板）：
     1) 暗三条 / 顺子 / 同花 / 葫芦 —— 最佳五张里两张手牌必须都用上
     2) 金刚 / 同花顺 / 皇家同花顺 —— 至少 1 张手牌参与即可
     3) 公共牌自身就能凑成同分牌型（五张全来自公共牌）→ 不算击中
     4) 两对及以下不播
   展示：只判本机玩家自己的手牌（只本人可见）；时机=当街公共牌发完；
        1s 动画后自动消失；本手同档只播一次、升级再播、每手复位 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
};

class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div';
    this.children = [];
    this._class = new Set();
    this.style = {};
    this.parentNode = null;
    this.textContent = '';
    this._innerHTML = '';
    this._listeners = {};
    this._qs = {};
  }
  get classList() {
    const self = this;
    return {
      add: c => self._class.add(c),
      remove: c => self._class.delete(c),
      toggle: (c, f) => { if (f === undefined) { self._class.has(c) ? self._class.delete(c) : self._class.add(c); } else if (f) self._class.add(c); else self._class.delete(c); },
      contains: c => self._class.has(c)
    };
  }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  appendChild(ch) { ch.parentNode = this; this.children.push(ch); return ch; }
  removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; }
  insertAdjacentHTML(pos, html) {
    const m = /class="([^"]+)"/.exec(html || '');
    const el = new FakeEl('div');
    if (m) el.className = m[1];
    el._innerHTML = html || '';
    this.appendChild(el);
    return el;
  }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
}

const cd = (r, s) => ({ r: r, s: s, id: r * 4 + s });

(async function main() {
  console.log('--- 大牌提示：命中规则 + 展示链路 ---');
  const byId = {};
  global.document = {
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener() {}
    /* 故意不提供 querySelector：缎带金边（.rr-lit）是可选项，无 DOM 时应静默跳过 */
  };
  global.window = global;
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  global.requestAnimationFrame = fn => setTimeout(fn, 0);

  /* 页面加载顺序与线上一致：先 rank-ribbon.js，再主脚本 */
  eval(fs.readFileSync(path.join(__dirname, 'rank-ribbon.js'), 'utf8'));
  ok(!!global.RankRibbon && !!global.RankRibbon.show, '缎带模块加载（RankRibbon.show 可用）');

  global.PokerCore = require('./core.js');
  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  eval(m[1]);
  const T = global.window.__PokerTest;
  const P = T.players;

  /* ---------- 源码级接线 ---------- */
  ok(/<script src="rank-ribbon\.js\?v=\d+[a-z]"><\/script>/.test(html), 'HTML 引入 rank-ribbon.js（在主脚本之前）');
  ok(html.includes('id="rank-ribbon-slot"'), '牌桌内有缎带挂载点 #rank-ribbon-slot');
  ok(/#rank-ribbon-slot\.rr-slot \{[^}]*position: fixed/.test(html), '挂载点为 fixed 定位（坐标由 JS 按主角手牌算）');
  ok(/\.rr\.rr-on \{ animation: rr-in 1s/.test(html), '缎带 1s 动画（播完自动消失）');
  ok(/try \{ maybeShowBigHand\(\); \} catch \(e\) \{\}/.test(html), '发牌循环之后调用大牌判定（当街公共牌发完时）');
  ok(/bigHandTier = 0;      \/\/ 大牌提示：本手档位去重复位/.test(html), '每手开始复位档位去重');
  ok(/if \(!tier \|\| tier <= bigHandTier\) return 0;/.test(html), '同一手内同档不重复播放（升级才再播）');
  ok(/if \(!me \|\| !me\.seatType \|\| !me\.inHand \|\| me\.revealed\) return 0;/.test(html), '只判本机在局玩家（弃牌 / 摊牌后不播）');
  ok(/const CLIENT_JS = \[[\s\S]*?'rank-ribbon\.js'[\s\S]*?\];/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')),
    'server.js 白名单登记 rank-ribbon.js（联机 HTTP 可加载）');

  /* ---------- 规则表 ---------- */
  const tierOf = T.debug.bigHand.tierOf;
  const cases = [
    ['暗三条（手牌一对 + 公共牌一张）', [cd(7, 0), cd(7, 2)], [cd(7, 1), cd(13, 0), cd(2, 0)], 1],
    ['明三条（flop 手里 1 张 + 公共牌一对，踢脚来自手牌）→ 只认暗三条，不播', [cd(14, 0), cd(13, 0)], [cd(14, 1), cd(14, 3), cd(5, 2)], 0],
    ['公共牌三条（三张 7 全在公共牌，手牌只是踢脚）→ 不播', [cd(13, 1), cd(12, 2)], [cd(7, 0), cd(7, 1), cd(7, 2), cd(2, 0), cd(3, 0)], 0],
    ['顺子（手牌 9 8 都用上）', [cd(9, 0), cd(8, 1)], [cd(10, 2), cd(11, 0), cd(12, 1)], 2],
    ['顺子只用 1 张（T 补成 T 高顺）→ 不播', [cd(10, 0), cd(2, 1)], [cd(6, 2), cd(7, 0), cd(8, 1), cd(9, 0), cd(3, 2)], 0],
    ['同花只用 1 张（公共牌 4 张黑桃 + 手里 1 张黑桃）→ 不播（用户举例）', [cd(7, 0), cd(3, 2)], [cd(14, 0), cd(9, 0), cd(5, 0), cd(2, 0)], 0],
    ['同花（手里两张黑桃都用上）', [cd(7, 0), cd(6, 0)], [cd(14, 0), cd(9, 0), cd(5, 0), cd(2, 1), cd(13, 2)], 3],
    ['葫芦（手牌一对 7 + 公共牌 7 K K）', [cd(7, 0), cd(7, 2)], [cd(7, 1), cd(13, 0), cd(13, 1)], 4],
    ['葫芦只用 1 张（公共牌 7 7 K K + 手牌补一张 7）→ 不播', [cd(7, 0), cd(2, 2)], [cd(7, 1), cd(7, 3), cd(13, 0), cd(13, 1), cd(5, 2)], 0],
    ['金刚（手牌 1 张 7 + 公共牌三张 7）→ 用 1 张也算', [cd(7, 0), cd(2, 2)], [cd(7, 1), cd(7, 3), cd(7, 2), cd(13, 0), cd(12, 0)], 5],
    ['金刚（四张 7 全在公共牌）→ 不播', [cd(14, 1), cd(13, 2)], [cd(7, 0), cd(7, 1), cd(7, 2), cd(7, 3), cd(13, 0)], 0],
    ['同花顺（手里 9♠ 补齐 5-9）→ 用 1 张也算', [cd(9, 0), cd(2, 1)], [cd(5, 0), cd(6, 0), cd(7, 0), cd(8, 0), cd(13, 2)], 6],
    ['皇家同花顺（手里 A♠ 补齐 TJQK）→ 用 1 张也算', [cd(14, 0), cd(2, 1)], [cd(10, 0), cd(11, 0), cd(12, 0), cd(13, 0), cd(3, 2)], 7],
    ['同花顺全在公共牌 → 不播', [cd(14, 1), cd(13, 2)], [cd(5, 0), cd(6, 0), cd(7, 0), cd(8, 0), cd(9, 0)], 0],
    ['两对 → 不做', [cd(14, 0), cd(14, 2)], [cd(13, 0), cd(13, 1), cd(2, 0), cd(3, 1), cd(4, 2)], 0],
    ['公共牌已是顺子，手牌只是把顺子做大 → 仍属公共牌形成，不播', [cd(9, 2), cd(10, 2)], [cd(5, 3), cd(6, 1), cd(7, 3), cd(8, 3), cd(9, 3)], 0],
    ['公共牌不足 3 张 → 不判', [cd(14, 0), cd(14, 2)], [cd(13, 0), cd(13, 1)], 0],
    ['手牌不足 2 张 → 不判', [cd(14, 0)], [cd(13, 0), cd(13, 1), cd(2, 0)], 0]
  ];
  cases.forEach(function (c) { ok(tierOf(c[1], c[2]) === c[3], '档位：' + c[0], '实际 ' + tierOf(c[1], c[2])); });

  /* ---------- 展示链路 ---------- */
  const slot = document.getElementById('rank-ribbon-slot');
  const clsOf = () => (slot.children[0] ? slot.children[0].className : '(空)');
  T.client.setMode('single', 0, '我');
  P.forEach(function (p) { p.seatType = null; p.inHand = false; p.revealed = false; p.hole = []; });
  P[0].seatType = 'host'; P[0].name = '我'; P[0].inHand = true; P[0].revealed = false;
  P[1].seatType = 'ai'; P[1].name = 'AI-1'; P[1].inHand = true;
  P[0].hole = [cd(7, 0), cd(7, 2)];                 // 暗三条
  P[1].hole = [cd(14, 0), cd(14, 2)];               // 对手拿着 AA（不该影响我）
  T.duel.setBoard([cd(7, 1), cd(13, 0), cd(2, 0)]);
  T.debug.bigHand.reset();

  ok(T.debug.bigHand.check() === 1, '当街发完：本人击中暗三条 → 播第 1 档');
  ok(/rr-t1/.test(clsOf()), '牌桌上真的挂出了"暗三条"缎带节点', clsOf());

  ok(T.debug.bigHand.check() === 0, '同一档位重复检查 → 不重复播');
  T.duel.setBoard([cd(7, 1), cd(13, 0), cd(13, 1)]);  // 7 7 + 7 K K → 葫芦
  ok(T.debug.bigHand.check() === 4, '牌型升级（三条 → 葫芦）→ 再播第 4 档');
  ok(/rr-t4/.test(clsOf()), '缎带节点换成"葫芦"档', clsOf());

  /* 只判本人：把本人手牌换成垃圾牌，对手仍是暗三条 */
  T.debug.bigHand.reset();
  P[0].hole = [cd(2, 2), cd(3, 2)];
  P[1].hole = [cd(14, 0), cd(14, 2)];
  T.duel.setBoard([cd(14, 1), cd(14, 3), cd(14, 2), cd(5, 0), cd(6, 1)]); // 公共牌 AAA → 对手四条 A，本人无
  ok(T.debug.bigHand.check() === 0, '对手击中大牌而本人没有 → 本机不播（仅本人可见）');

  /* 弃牌 / 已摊牌不播 */
  T.debug.bigHand.reset();
  P[0].hole = [cd(7, 0), cd(7, 2)];
  T.duel.setBoard([cd(7, 1), cd(13, 0), cd(2, 0)]);
  P[0].inHand = false;
  ok(T.debug.bigHand.check() === 0, '本人已弃牌 → 不播');
  P[0].inHand = true; P[0].revealed = true;
  ok(T.debug.bigHand.check() === 0, '已摊牌（牌已亮）→ 不播');
  P[0].revealed = false;

  /* 换手复位：上一手播过，这一手同档还能再播 */
  T.debug.bigHand.reset();
  ok(T.debug.bigHand.tier() === 0, '新一手复位档位记录');
  ok(T.debug.bigHand.check() === 1, '复位后同一档位可再次播放（每手独立）');

  /* 自动消失：1.1s 兜底清场 */
  ok(slot.children.length === 1, '播放时挂载点内有缎带节点');
  await new Promise(r => setTimeout(r, 1250));
  ok(slot.children.length === 0, '约 1.1s 后缎带节点自动移除（不留残影）');

  /* 缎带节点内容自检：七档都能构建出对应类名与文案 */
  for (let t = 1; t <= 7; t++) {
    const h = global.RankRibbon.build(t, '');
    ok(new RegExp('rr rr-t' + t).test(h) && h.indexOf(global.RankRibbon.TIERS[t].name) >= 0,
      '第 ' + t + ' 档模板完整（' + global.RankRibbon.TIERS[t].name + '）');
  }

  console.log('\n=== 大牌提示测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
