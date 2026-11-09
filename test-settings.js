/* 设置功能测试（声音开关 / 下注按钮底池比例）+ 秀牌点按化
   1) 源码级：菜单与主界面入口、设置弹窗结构、滑杆范围、声音门控、快捷按钮读取设置、
      秀牌由长按改为点按、齿轮按钮随牌局显隐、退出清理
   2) 行为级：设置打开回填、声音开/关切换、滑杆实时显示与持久化（localStorage） */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };

/* ================= 第一部分：无头 UI 测试 ================= */
function uiTests() {
  console.log('--- 无头 UI：设置 / 秀牌点按 ---');
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
  const settingsModal = seed('settings-modal', ['modal', 'hidden']);
  const settingsFab = seed('settings-fab', []);
  const settingsToggle = seed('settings-toggle', []);
  const soundOn = seed('btn-sound-on', []);
  const soundOff = seed('btn-sound-off', []);
  const blindOn = seed('btn-blindbadge-on', []);
  const blindOff = seed('btn-blindbadge-off', []);
  const closeBtn = seed('btn-settings-close', []);
  const sliders = [0, 1, 2, 3].map(i => seed('betpct-' + i, []));
  const labels = [0, 1, 2, 3].map(i => seed('betpctv-' + i, []));

  /* localStorage 记录写入，验证持久化 */
  let savedRaw = null;
  global.localStorage = {
    getItem: () => null,
    setItem: (k, v) => { if (k === 'gto_settings_v1') savedRaw = v; }
  };
  global.document = {
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener() {}
  };
  global.window = global;
  global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  global.PokerCore = require('./core.js');
  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  eval(m[1]);
  const T = global.window.__PokerTest;

  /* ---------- 源码级：入口 ---------- */
  ok(/<div id="menu-list"[^>]*>[\s\S]*?id="settings-toggle"[\s\S]*?id="exit-toggle"/.test(html),
    '菜单中包含"⚙ 设置"入口，且位于"退出牌局"之前');
  ok(/#settings-fab\s*\{[^}]*position:\s*fixed[^}]*right:\s*12px[^}]*bottom:/.test(html),
    '主界面右下角齿轮按钮（fixed 右下）');
  ok(/id="settings-fab"[\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?<\/button>/.test(html),
    '齿轮按钮使用齿轮图形样式（内嵌 SVG）');

  /* ---------- 源码级：设置弹窗结构 ---------- */
  ok(html.includes('id="btn-sound-on"') && html.includes('id="btn-sound-off"'), '声音设置含 开/关 两个选项');
  ok(/id="betpct-0"[^>]*min="10"[^>]*max="200"/.test(html) && /id="betpct-3"[^>]*min="10"[^>]*max="200"/.test(html),
    '4 行下注按钮设置，滑杆 10%~200%');
  ok((html.match(/class="betpct-row"/g) || []).length === 4, '下注按钮设置恰好 4 行（按钮1~按钮4）');

  /* ---------- 源码级：逻辑接线 ---------- */
  ok(html.includes('if (!APP_SETTINGS.sound) return;'), '声音关闭时不再播放任何音效（SND.play 门控）');
  ok(html.includes('APP_SETTINGS.betPcts.slice().reverse().forEach(function (pct) {'), '翻牌后快捷下注按钮按自定义底池比例生成（逆序插入=大额在上）');
  ok(!html.includes("mk('25%池'"), '已移除写死的快捷按钮比例');
  ok(html.includes("addEventListener('pointerup', function (ev) {") && html.includes('toggleShowCard(ci, !me.showFlags[ci]);'),
    '秀牌：点按手牌即切换秀牌状态');
  ok(!html.includes('pressTimer = setTimeout'), '已移除长按计时逻辑');
  ok(html.includes("$('settings-fab').classList.toggle('show', inGame && !compact);"),
    '齿轮按钮随牌局主界面显隐（宽屏悬浮显示；窄屏由菜单入口提供，避免压住快捷下注按钮）');
  ok(html.includes("$('settings-toggle').style.display = menuable ? '' : 'none';"),
    '菜单内设置入口随牌局显隐（窄屏/大厅叠层时的唯一入口）');
  /* ---------- 源码级：UI 评审报告修复项 ---------- */
  ok(/@media \(max-width: 1000px\) and \(orientation: landscape\) and \(max-height: 560px\)/.test(html),
    'UI-P0①：新增手机横屏断点分支（横向 844/896/915px 也能正常布局）');
  ok(/aspect-ratio: 780 \/ 460; border-width: 8px;/.test(html) && /orientation: landscape[\s\S]{0,3400}#raise-stack \{ max-width: 136px;/.test(html),
    'UI-P0①：横屏牌桌高度受视口约束 + 预设堆横屏压紧（2026-10-14 WPT 浮层版式）');
  ok(/id="free-arrow"/.test(html) && /id="mid-col"/.test(html) && /bodyClass\('vopen'/.test(html),
    'UI-P0①：自由下注模块（中列箭头展开竖向滑条 vopen）横屏同样可用');
  ok(/const compact = \(function \(\) \{[\s\S]{0,120}?matchMedia\('\(max-width: 1000px\)'\)/.test(html),
    'UI-P0②：窄屏不显示右下角悬浮齿轮（改为菜单入口，避免压住快捷下注按钮）');
  ok(/\.seat \.info \.name \.nm \{ overflow: hidden; text-overflow: ellipsis/.test(html),
    'UI-P0③：座位名字牌限宽省略号，不再折行');
  ok(/border: 1px dashed rgba\(255,255,255,\.45\);/.test(html) && /background: rgba\(255,255,255,\.06\)/.test(html),
    'UI-P1⑤：公共牌空槽提高对比度并加淡填充');
  ok(/\.btn:disabled \{ opacity: \.55;/.test(html) && /#wait-hint/.test(html),
    'UI-P1⑤：禁用态更可读 + 等待他人行动时显示"等待 XX 行动…"');
  ok(/function betPosOf\(/.test(html) && /\(compact \? 0\.70 : 0\.62\)/.test(html) && !/data-pushx/.test(html),
    'UI-P1④：下注筹码沿"座位→桌心"方向偏移（窄屏偏移更大，与名字牌分离；betPosOf 统一计算）');
  ok(/@media \(min-width: 1200px\) and \(min-height: 720px\)/.test(html),
    'UI-P1③：大屏牌桌随视口放大（上限 1120px）');
  ok(/id="resume-row"/.test(html) && /id="btn-resume"/.test(html) && /bodyClass\('over-game'/.test(html),
    'UI-P2⑥：刷新恢复的对局改由"返回牌局/退出牌局"分流，背景牌局暂停渲染');
  ok(/:root \{[\s\S]{0,600}?--gold: #ffd54a;/.test(html), 'UI-P2⑦：抽取设计令牌（:root CSS 变量）');
  ok(/font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif/.test(html),
    'UI-P2⑦：字体栈改为 system-ui 优先');
  ok(/font-variant-numeric: tabular-nums/.test(html), 'UI-P2⑦：数字等宽（筹码额不抖动）');
  ok(!html.includes('user-scalable=no'), 'UI-P2⑦：允许用户缩放（WCAG 1.4.4）');
  ok(/button:focus-visible, input:focus-visible/.test(html), 'UI-P2⑦：补键盘焦点环');
  ok(/exitToMenu[\s\S]*?'settings-modal'/.test(html) === false || html.includes("'squid-modal', 'settings-modal'"),
    '退出牌局时清理设置弹窗');

  /* ---------- 行为级 ---------- */
  const st = T.settings.state;
  ok(st.sound === true && JSON.stringify(st.betPcts) === '[33,50,75,100]', '默认设置：声音开，比例 33/50/75/100%（WPT 版式默认）');

  /* 打开设置：回填当前值 */
  T.settings.open();
  ok(!settingsModal.classList.contains('hidden'), '点击设置打开设置界面');
  ok(String(sliders[0].value) === '33' && String(sliders[3].value) === '100', '打开时滑杆回填当前比例');
  ok(String(labels[0].textContent) === '33%' && String(labels[3].textContent) === '100%', '打开时实时显示当前比例');

  /* 声音开关 */
  soundOff.onclick();
  ok(st.sound === false && soundOff.classList.contains('active') && !soundOn.classList.contains('active'),
    '选择"关"：声音关闭并高亮"关"按钮');
  soundOn.onclick();
  ok(st.sound === true && soundOn.classList.contains('active') && !soundOff.classList.contains('active'),
    '选择"开"：声音开启并高亮"开"按钮');

  /* 大小盲标识开关（2026-10-16 新增，默认关=仅庄位） */
  ok(st.blindBadges === false, '默认设置：大小盲标识关闭（仅显示庄位 D）');
  ok(html.includes('id="btn-blindbadge-on"') && html.includes('id="btn-blindbadge-off"') &&
     html.includes('body.no-blind-badges .seat .sb-badge'),
    '大小盲标识设置含 显示/仅庄位 两选项 + CSS 显示层开关（点亮类数据层不变）');
  blindOn.onclick();
  ok(st.blindBadges === true && blindOn.classList.contains('active') && !blindOff.classList.contains('active'),
    '选择"显示 S / B"：开启并高亮');
  blindOff.onclick();
  ok(st.blindBadges === false && blindOff.classList.contains('active') && !blindOn.classList.contains('active'),
    '选择"仅庄位 D"：关闭并高亮');
  ok(savedRaw && JSON.parse(savedRaw).blindBadges === false,
    '大小盲标识设置写入 localStorage 持久化');

  /* 滑杆自定义比例 + 实时显示 + 持久化 */
  sliders[1].value = '80';
  sliders[1].oninput.call(sliders[1]);
  ok(String(labels[1].textContent) === '80%' && st.betPcts[1] === 80, '拖动滑杆实时显示比例（一格 1%）并生效');
  sliders[0].value = '300';
  sliders[0].oninput.call(sliders[0]);
  ok(st.betPcts[0] === 200, '滑杆超出上限 200% 时钳制为 200%');
  sliders[0].value = '5';
  sliders[0].oninput.call(sliders[0]);
  ok(st.betPcts[0] === 10, '滑杆低于下限 10% 时钳制为 10%');
  ok(savedRaw && JSON.parse(savedRaw).betPcts.join(',') === '10,80,75,100' && JSON.parse(savedRaw).sound === true,
    '设置变更写入 localStorage 持久化');

  /* 关闭 */
  closeBtn.onclick();
  ok(settingsModal.classList.contains('hidden'), '点击关闭收起设置界面');

  return { pass, fail };
}

/* ================= 第二部分：持久化回读（进程级模拟） ================= */
function reloadTests() {
  console.log('--- 持久化回读 ---');
  const fs = require('fs');

  class FakeEl {
    constructor() {
      this.children = []; this._class = new Set(); this.style = {}; this.parentNode = null;
      this.textContent = ''; this._innerHTML = ''; this.disabled = false; this.value = '';
      this.scrollTop = 0; this.scrollHeight = 0; this.onclick = null; this._qs = {}; this._listeners = {};
    }
    get classList() {
      const self = this;
      return {
        add: c => self._class.add(c), remove: c => self._class.delete(c),
        toggle: (c, f) => { if (f === undefined) { self._class.has(c) ? self._class.delete(c) : self._class.add(c); } else if (f) self._class.add(c); else self._class.delete(c); },
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
    addEventListener() {} focus() {}
  }
  const byId = {};
  let store = { gto_settings_v1: JSON.stringify({ sound: false, betPcts: [33, 60, 120, 200] }) };
  global.localStorage = { getItem: k => store[k] || null, setItem: () => {} };
  global.document = {
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(); },
    addEventListener() {}
  };
  global.window = global;
  global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  global.PokerCore = require('./core.js');
  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const st = global.window.__PokerTest.settings.state;
  ok(st.sound === false && st.betPcts.join(',') === '33,60,120,200', '启动时从 localStorage 回读上次的设置');

  /* 损坏的存档：回退默认值 */
  store = { gto_settings_v1: '{broken json' };
  delete global.window.__PokerTest; // 重新 eval 会重建
  eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const st2 = global.window.__PokerTest.settings.state;
  ok(st2.sound === true && st2.betPcts.join(',') === '33,50,75,100', '存档损坏时回退默认设置');

  /* 非法比例：回退默认值 */
  store = { gto_settings_v1: JSON.stringify({ sound: true, betPcts: [5, 50, 999, 75] }) };
  delete global.window.__PokerTest;
  eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const st3 = global.window.__PokerTest.settings.state;
  ok(st3.betPcts.join(',') === '33,50,75,100', '存档含越界比例时回退默认设置');
}

const ui = uiTests();
console.log('--- 无头 UI 小计: ' + ui.pass + ' 通过, ' + ui.fail + ' 失败 ---');
reloadTests();
console.log('\n=== 设置/秀牌测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
