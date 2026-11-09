/* 预操作（Pre-action）功能测试
   覆盖：
   1) 源码级：CSS 类 .pre-armed/.pre-on、提示元素、按钮存在
   2) 可预操作前提 canPreAct()：牌局中/有牌在局/未轮到自己/有筹码
   3) 预选与取消：点击弃牌/跟注按钮 → 高亮；再次点击 → 取消
   4) 轮到本人时自动执行（弃牌 / 跟注 / 无跟注额时转成过牌）
   5) 跟注额变化（有人加注）→ 自动取消"跟注"预操作，保留"弃牌"预操作
   6) 换街 / 新一局 → 清空预操作
   7) 已 allin / 已弃牌 / 非牌局中 → 不可预操作 */
'use strict';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };

/* ---------- 无头 DOM 桩 ---------- */
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
    this.min = 0; this.max = 0; this.step = 1;
    this.scrollTop = 0; this.scrollHeight = 0;
    this.onclick = null; this.oninput = null;
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
  querySelectorAll() { return []; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener() {}
  focus() {}
  getBoundingClientRect() { return { width: 100, height: 100, top: 0, left: 0 }; }
}

const byId = {};
global.document = {
  getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
  createElement(tag) { return new FakeEl(tag); },
  addEventListener() {},
  body: new FakeEl('body'),
  documentElement: new FakeEl('html')
};
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
global.PokerCore = require('./core.js');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const T = global.window.__PokerTest;
const PA = T.preAction;

/* ---------- 源码级 ---------- */
console.log('--- 源码约束 ---');
ok(/#action-bar\.pre-armed \.btn\.pre-on/.test(html), '存在预操作高亮样式 .pre-armed .btn.pre-on');
ok(/#action-bar\.pre-armed \.btn\.pre-on \{[^}]*pointer-events:\s*auto/.test(html),
  '预操作按钮覆盖 .disabled 的 pointer-events（保持可点）');
/* 2026-10-13 修复：只给 .pre-on 开 pointer-events 会死锁 ——
   未预选的按钮 pointer-events:none，第一次点击到不了按钮，永远进不了 .pre-on。
   必须在"可预选"状态（.pre-armed）就让 #btn-fold / #btn-check 可点。 */
ok(/#action-bar\.pre-armed #btn-fold,\s*\n\s*#action-bar\.pre-armed #btn-check \{ pointer-events: auto/.test(html),
  '预选前按钮即可点（修 CSS 死锁：否则第一次点击被 pointer-events:none 吞掉）');
ok(/#btn-raise/.test(html.match(/#action-bar\.pre-armed #btn-fold[\s\S]{0,160}?\}/)[0]) === false,
  '「加注」不参与预选（未被放开 pointer-events）');
ok(/if \(active\) \{\s*\n\s*const f = \$\('btn-fold'\);\s*\n\s*if \(f\) f\.disabled = false;/.test(html),
  '预操作期放开 #btn-fold 的 disabled（可免费过牌时遗留的 disabled 会吞掉点击）');

/* CSS 级联特异性机械校验：放开规则必须真的压过 .disabled 的 pointer-events:none
   （无头测试桩不实现 CSS 层叠，真实浏览器点击是否可穿透只能这样静态验证） */
(function () {
  const specOf = function (sel) {
    const ids = (sel.match(/#/g) || []).length;
    const cls = (sel.match(/\./g) || []).length;
    return ids * 100 + cls * 10;
  };
  const mDisabled = html.match(/#action-bar\.disabled \.btn \{([^}]*)\}/);
  const mArm = html.match(/#action-bar\.pre-armed #btn-fold,\s*\n\s*#action-bar\.pre-armed #btn-check \{([^}]*)\}/);
  ok(mDisabled && /pointer-events:\s*none/.test(mDisabled[1]), '等待期禁用规则仍为 pointer-events:none');
  ok(mArm && /pointer-events:\s*auto/.test(mArm[1]), '等待期"弃牌/跟注"放开为 pointer-events:auto');
  const sDisabled = specOf('#action-bar.disabled .btn');   // 1 id + 2 class
  const sArm = specOf('#action-bar.pre-armed #btn-fold');  // 2 id + 1 class
  ok(sArm > sDisabled, '放开规则权重更高（' + sArm + ' > ' + sDisabled + '），确实覆盖禁用规则');
})();
ok(!/id="pre-act-hint"/.test(html), '行动条不再显示"已预选…"文字提示（仅靠按钮亮起反馈）');
ok(/filter: brightness\(1\.3\)/.test((html.match(/#action-bar\.pre-armed \.btn\.pre-on \{[^}]*\}/) || [''])[0]),
  '高亮强化：.pre-on 按钮提亮（无文字提示时按钮亮起即唯一反馈）');
ok(/function preActOrSubmit\(type, normalFn\)/.test(html), '弃牌/跟注按钮统一走 preActOrSubmit 入口');
ok(/function consumePreAction\(p\)/.test(html), '存在轮到本人时消费预操作的函数');
ok(/function checkPreActionStillValid\(\)/.test(html), '存在跟注额变化检测函数');
ok(/try \{ checkPreActionStillValid\(\); \} catch \(e\) \{\}/.test(html), 'applyAction 末尾检查跟注额变化');
/* 2026-10-14 真机报障根修：预操作的消费必须在 humanResolve 就位之后。
   旧实现放在 setActing 里 —— 那时 humanResolve 还是 null，
   submitAction → resolveHuman 第一行 `if (!humanResolve) return;` 把动作静默丢弃，
   牌局根本没收到；而 lastSubmittedAction 在 submitAction 开头就赋值了，
   所以旧断言（只看 lastSubmitted）全绿，真机却"预选了弃牌，轮到时仍要手点"。 */
(function () {
  const m = html.match(/function setActing\(p\) \{[\s\S]*?\n  \}/);
  const body = m ? m[0] : '';
  ok(body.length > 0 && !/consumePreAction/.test(body),
    'setActing 内【不】消费预操作（此刻 humanResolve 为 null，动作会被静默丢弃）');
  const mh = html.match(/function humanAction\(p\) \{[\s\S]*?\n  \}/);
  const hbody = mh ? mh[0] : '';
  ok(/humanResolve = resolve;[\s\S]*?if \(p\.idx === MP\.mySeat && MP\.mode !== 'client' && consumePreAction\(p\)\) return;/.test(hbody),
    'humanAction：先置 humanResolve，再消费预操作（顺序即根修）');
  ok(/humanTurn: function \(seat\) \{\s*\n\s*const p = players\[seat\];\s*\n\s*setActing\(p\);\s*\n\s*return humanAction\(p\);/.test(html),
    '测试钩子 humanTurn 复刻真实两步链路（setActing → humanAction）');
})();
ok(/function preActionAlive\(\)/.test(html) && /if \(!preActionAlive\(\) && preAction\) \{ preAction = null; preActionToCall = 0; \}/.test(html),
  'syncPreAction 只在"前提消失"时清空；轮到自己不清（保留给消费点）');
ok(/if \(!preActionAlive\(\)\) \{ preAction = null; preActionToCall = 0; syncPreAction\(\); return; \}/.test(html),
  'checkPreActionStillValid 同样改用 preActionAlive（轮到自己不清）');
ok(/if \(preAction === 'call'\) clearPreAction\(\);\s*\n\s*else \{ try \{ syncPreAction\(\); \} catch \(e\) \{\} \}/.test(html),
  '换街只清"跟注"预操作，弃牌跨街保留（与"弃牌与投入无关"同一口径）');
ok(/if \(mine && !pendingAction\) \{\s*\n\s*\/\/ 轮到自己：先执行预操作/.test(html),
  '客机 syncClientActionBar：轮到自己时先执行预操作');
ok(/clearPreAction\(\);     \/\/ 新一局/.test(html), '新一局开始时清空预操作（弃牌跨街但不跨手）');

/* ---------- 行为级 ---------- */
console.log('--- 行为：可预操作前提 ---');
function seat(setup) {
  T.players.forEach(function (p) {
    p.seatType = null; p.name = ''; p.chips = 0; p.inHand = false;
    p.bet = 0; p.hole = []; p.showFlags = [false, false]; p.showRevealed = [false, false];
  });
  T.client.setMode('single', 0, '我');
  MP_setPhase('playing');
  T.players[0].seatType = 'host'; T.players[0].name = '我';
  T.players[0].chips = 200; T.players[0].inHand = true;
  T.players[0].hole = [{ r: 14, s: 0 }, { r: 14, s: 1 }];
  T.players[1].seatType = 'ai'; T.players[1].name = 'AI'; T.players[1].chips = 200; T.players[1].inHand = true;
  if (setup) setup();
}
function MP_setPhase(ph) { T.client.setMode(MP_getMode(), 0, '我'); }
/* 直接操纵 MP.phase：通过 setMode 已置 playing */
function MP_getMode() { return 'single'; }
/* 让"当前行动者"为他人 → 允许预操作 */
function othersTurn() { PA.turnTo(1); }
/* 让"当前行动者"为本人 —— 必须走真实两步链路（setActing → humanAction）。
   旧版只调 setActing，而消费点根本不在那里，于是"预操作没生效"这个真 bug
   被这层假链路完美掩盖（2026-10-14 真机报障）。 */
function myTurn() { return PA.humanTurn(0); }

seat();
PA.clear();
T.setBettingState(20);
T.players[0].bet = 0;
othersTurn();
ok(PA.canPreAct() === true, '牌局中、有牌在局、他人行动 → 可预操作');
myTurn();
ok(PA.canPreAct() === false, '轮到自己 → 不可预操作（直接正常操作）');
othersTurn();
T.players[0].chips = 0;
ok(PA.canPreAct() === false, '本人已 allin（chips=0）→ 不可预操作');
seat();
T.setBettingState(20); othersTurn();
T.players[0].inHand = false;
ok(PA.canPreAct() === false, '本人已弃牌 → 不可预操作');

console.log('--- 行为：预选与取消 ---');
seat();
PA.clear();
T.setBettingState(20);
T.players[0].bet = 0;
T.players[0].chips = 200;
othersTurn();
PA.tapFold();
ok(PA.state() === 'fold', '他人行动时点"弃牌" → 记下弃牌预操作');
ok(PA.barClass('pre-armed') === true, '行动条加 .pre-armed 类（允许点击）');
ok(PA.btnClass('btn-fold', 'pre-on') === true, '弃牌按钮高亮 .pre-on');
ok($t('btn-fold').classList.contains('pre-on') === true, '弃牌按钮亮起（唯一反馈，无文字提示）');
PA.tapFold();
ok(PA.state() === null, '再次点击"弃牌" → 取消预操作');
ok(PA.btnClass('btn-fold', 'pre-on') === false, '弃牌按钮取消高亮');
ok(PA.btnClass('btn-check', 'pre-on') === false, '跟注按钮未高亮（未预选）');

PA.tapCheck();
ok(PA.state() === 'call', '他人行动时点"跟注" → 记下跟注预操作');
ok(PA.btnClass('btn-check', 'pre-on') === true, '跟注按钮高亮');
ok(PA.btnClass('btn-fold', 'pre-on') === false, '弃牌按钮不同时高亮（互斥）');
PA.tapCheck();
ok(PA.state() === null, '再次点击"跟注" → 取消预操作');

/* 互斥：预选弃牌后再点跟注 → 切换为跟注 */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200; othersTurn();
PA.tapFold();
PA.tapCheck();
ok(PA.state() === 'call', '预选弃牌后点跟注 → 切换为跟注预操作');
ok(PA.btnClass('btn-fold', 'pre-on') === false && PA.btnClass('btn-check', 'pre-on') === true,
  '高亮随之切换（弃牌灭、跟注亮）');

console.log('--- 行为：轮到本人自动执行（同步可见部分） ---');
/* 注意：本段只断言"预选被消费 + submitAction 被调用"（同步可见）。
   动作是否真的交回牌局（resolveHuman 生效）由文件末尾的
   "setActing → humanAction 真实链路"段用 Promise 断言把关。 */
/* 弃牌预操作 → 自动弃牌（有跟注额） */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapFold();
myTurn();
ok(PA.state() === null, '轮到本人：预操作被消费清空');
ok(PA.lastSubmitted() && PA.lastSubmitted().type === 'fold', '预选弃牌 → 轮到时自动提交 fold');
ok(T.logLines().some(l => l.text.indexOf('（预操作）弃牌') >= 0), '日志记录"（预操作）弃牌"');

/* 跟注预操作 → 自动跟注（有跟注额） */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapCheck();
ok(PA.state() === 'call', '记下跟注预操作');
myTurn();
ok(PA.lastSubmitted() && PA.lastSubmitted().type === 'call', '预选跟注 → 轮到时自动提交 call');
ok(T.logLines().some(l => l.text.indexOf('（预操作）跟注') >= 0), '日志记录"（预操作）跟注"');

/* 无跟注额时："跟注"预操作自动转为过牌 */
seat();
PA.clear(); T.setBettingState(0); T.players[0].bet = 0; T.players[0].chips = 200;
T.players[1].bet = 0;
othersTurn();
PA.tapCheck();
myTurn();
ok(PA.lastSubmitted() && PA.lastSubmitted().type === 'check', '无跟注额时跟注预操作 → 自动提交 check');
ok(T.logLines().some(l => l.text.indexOf('（预操作）过牌') >= 0), '日志记录"（预操作）过牌"');

/* 无跟注额时"弃牌"预操作 → 转为过牌（避免无谓弃牌） */
seat();
PA.clear(); T.setBettingState(0); T.players[0].bet = 0; T.players[0].chips = 200; T.players[1].bet = 0;
othersTurn();
PA.tapFold();
myTurn();
ok(PA.lastSubmitted() && PA.lastSubmitted().type === 'check', '无跟注额时弃牌预操作 → 自动提交 check（不弃牌）');

console.log('--- 行为：跟注额变化 → 取消跟注预操作 ---');
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapCheck();
ok(PA.state() === 'call' && PA.toCallSnapshot() === 20, '跟注预操作记录当时跟注额 20');
/* 有人加注：currentBet 抬到 60 */
T.setBettingState(60);
PA.check();
ok(PA.state() === null, '跟注额由 20 变为 60 → 自动取消跟注预操作');
ok(PA.btnClass('btn-check', 'pre-on') === false, '跟注按钮取消高亮');

/* 加注额不变（他人跟注）→ 跟注预操作保留 */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapCheck();
T.setBettingState(20); // 未变化
PA.check();
ok(PA.state() === 'call', '跟注额未变化 → 保留跟注预操作');

/* 弃牌预操作不受加注影响 */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapFold();
T.setBettingState(60);
PA.check();
ok(PA.state() === 'fold', '跟注额变化不影响"弃牌"预操作（仍然保留）');

/* 强化：弃牌预选与跟注额"彻底解耦"—— 预选弃牌不记快照、连续加注也不取消（2026-10-13 需求） */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapFold();
ok(PA.toCallSnapshot() === 0, '预选弃牌不记录跟注额快照（恒为 0，与金额解耦）');
T.setBettingState(60); PA.check();
ok(PA.state() === 'fold' && PA.btnClass('btn-fold', 'pre-on') === true, '加注 20→60：弃牌预选保留且按钮仍亮');
T.setBettingState(200); PA.check();
ok(PA.state() === 'fold' && PA.btnClass('btn-fold', 'pre-on') === true, '再连加 60→200：弃牌预选依旧保留');
T.players[0].chips = 40; PA.check();
ok(PA.state() === 'fold', '本人筹码被压低（跟注额触顶）仍不影响弃牌预选');
myTurn();
ok(PA.lastSubmitted() && PA.lastSubmitted().type === 'fold', '轮到本人：仍按预选自动弃牌');

/* 预选跟注的快照语义未受影响（对照：快照 = 当时的跟注额） */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapCheck();
ok(PA.toCallSnapshot() === 20, '预选跟注记录当时跟注额 20（仍受加注作废）');

console.log('--- 行为：清理时机 ---');
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapCheck();
PA.clear();
ok(PA.state() === null, 'clearPreAction 立即清空');

/* 失去行动权（本人被弃牌）→ sync 自动清空 */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapCheck();
T.players[0].inHand = false;
PA.sync();
ok(PA.state() === null, '本人弃牌后 sync → 清空预操作');

/* 轮到本人时 setActing【不得】清掉预选 —— 它只是"标记行动者"，
   消费点（humanAction）紧随其后。旧实现在这里就把预选清了（并在 humanResolve
   尚为 null 时提交 → 动作被丢弃），这正是"预选了弃牌，轮到时仍要手点"的现场。 */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
othersTurn();
PA.tapCheck();
PA.turnTo(0);                       // 只切行动者，不等价于 humanAction
ok(PA.state() === 'call', 'setActing 只标记行动者，不清掉预选（留给消费点执行）');
ok(PA.btnClass('btn-check', 'pre-on') === false, '此时已撤掉预选高亮（行动条由正常操作 UI 接管）');
ok(PA.barClass('pre-armed') === false, '此时撤掉 .pre-armed（不再可预选）');
PA.clear();

/* 上回合"可免费过牌"会把 #btn-fold 置为 disabled（HTML 属性，吞掉一切点击）；
   等待他方行动时必须放开，否则真实浏览器里预选弃牌点不动（2026-10-13 修复） */
seat();
PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
$t('btn-fold').disabled = true;
othersTurn();
PA.sync();
ok($t('btn-fold').disabled === false, '等待期放开 #btn-fold 的 disabled（真实浏览器才能点到）');
PA.tapFold();
ok(PA.state() === 'fold', '放开后仍可正常预选弃牌');

/* 轮到自己时由 showActionUI 重新裁定禁用态（规则不变：可免费过牌时不许弃牌） */
ok(/\$\('btn-fold'\)\.disabled = toCall <= 0;/.test(html),
  'showActionUI 仍按 toCall 裁定 #btn-fold 是否禁用（放开只发生在等待期）');

/* ---------- 行为：多人（联机客机）预操作完整链路 ---------- */
console.log('--- 行为：联机客机预操作 ---');
const REAL_FETCH = global.fetch;
global.fetch = function () {   // 桩：不真发请求
  return Promise.resolve({
    ok: true,
    json: function () { return Promise.resolve({ ok: true }); },
    text: function () { return Promise.resolve('{"ok":true}'); }
  });
};
seat();
PA.clear();                                   // 防上一块的遗留预选
T.client.setMode('client', 0, '我');          // setMode 已把 phase 置 playing（勿再调 MP_setPhase，它会把模式重置回 single）
T.client.clearPending();
T.players[0].seatType = 'client'; T.players[0].name = '我'; T.players[0].inHand = true;
T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
T.client.acting(1);          // 快照：轮到别人（客机路径：直接赋值，不走 setActing）
T.client.sync();
ok(PA.barClass('pre-armed'), '多人客机等待期：行动条进入 pre-armed（可预选）');
ok($t('btn-fold').disabled === false, '多人客机等待期：#btn-fold 不再被 disabled 吞掉点击');
ok(T.client.canAct() === false, '等待期仍不可直接行动（预选择 ≠ 立刻行动）');
PA.tapFold();
ok(PA.state() === 'fold', '多人客机等待期可预选弃牌');
PA.clear(); PA.tapCheck();
ok(PA.state() === 'call', '多人客机等待期可预选跟注');
PA.tapCheck();
ok(PA.state() === null, '再点一次取消预选');
PA.tapFold();
T.client.acting(0);          // 快照：轮到我
T.client.sync();
ok(PA.state() === null, '轮到自己：预操作已被消费');
ok(T.client.pending() !== null, '轮到自己：预选动作已自动投给主机');
ok(PA.lastSubmitted() && PA.lastSubmitted().type === 'fold', '自动提交的正是预选的弃牌');
T.client.clearPending();
global.fetch = REAL_FETCH;

/* ---------- 行为：预操作真的交回牌局（setActing → humanAction 真实两步链路） ----------
   2026-10-14 真机报障："预选弃牌，轮到我时还是需要执行操作"。
   根因：消费点原在 setActing 内，而那一刻 humanResolve 仍为 null →
   submitAction → resolveHuman 第一行 `if (!humanResolve) return;` 把动作静默丢弃，
   牌局压根没收到。lastSubmittedAction 在 submitAction 开头就已赋值，
   所以"动作没进牌局"这件事在旧断言里完全看不出来（假通过）。
   这里改用 Promise 是否真的 resolve 来判真伪。 */
console.log('--- 行为：真实链路 setActing → humanAction ---');
(function () {
  const settle = function (pr, ms) {
    return Promise.race([
      Promise.resolve(pr).then(function (a) { return { done: true, a: a }; },
                               function () { return { done: false }; }),
      new Promise(function (r) { setTimeout(function () { r({ done: false }); }, ms); })
    ]);
  };
  (async function () {
    let r;

    /* ① 预选弃牌 → 动作真的交回牌局 */
    seat();
    PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
    othersTurn();
    PA.tapFold();
    r = await settle(myTurn(), 500);
    ok(r.done === true, '① 预选弃牌 → 轮到时动作真的交回牌局（不再被 resolveHuman 静默丢弃）');
    ok(r.done && r.a && r.a.type === 'fold', '① 交回牌局的动作 = fold');
    ok(PA.state() === null, '① 交回后预选清空');

    /* ② 预选跟注 → 交回 call（跟注额取轮到时的新值） */
    seat();
    PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
    othersTurn();
    PA.tapCheck();
    r = await settle(myTurn(), 500);
    ok(r.done && r.a && r.a.type === 'call', '② 预选跟注 → 轮到时交回牌局的动作 = call');

    /* ③ 无跟注额 → 转为过牌 */
    seat();
    PA.clear(); T.setBettingState(0); T.players[0].bet = 0; T.players[0].chips = 200;
    T.players[1].bet = 0;
    othersTurn();
    PA.tapFold();
    r = await settle(myTurn(), 500);
    ok(r.done && r.a && r.a.type === 'check', '③ 无跟注额时预选弃牌 → 交回过牌（不无谓弃牌）');

    /* ④ 未预选 → 不自动动作（必须手点，正常流程行为不变） */
    seat();
    PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
    othersTurn();
    r = await settle(myTurn(), 300);
    ok(r.done === false, '④ 未预选 → 轮到时不会自动动作（仍需手动点，行为不变）');

    /* ⑤ 回归守卫：只调 setActing（旧消费点）不得吞掉预选 */
    seat();
    PA.clear(); T.setBettingState(20); T.players[0].bet = 0; T.players[0].chips = 200;
    othersTurn();
    PA.tapFold();
    PA.turnTo(0);
    ok(PA.state() === 'fold', '⑤ 回归守卫：单独调 setActing 不会吞掉预选（旧 bug 的现场）');
    r = await settle(myTurn(), 500);
    ok(r.done && r.a && r.a.type === 'fold', '⑤ 随后 humanAction 仍能正常执行该预选');

    console.log('\n=== 预操作测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
    process.exit(fail ? 1 : 0);
  })();
})();

function $t(id) { return document.getElementById(id); }
