/* test-menu-v2.js — 主菜单面板 v2（内容三分离）回归
   覆盖：源码结构（参数胶囊 / 模式卡片分组 / 开发者信息移出 / 标题回归产品名）
        行为（联机说明弹窗开关 / 遮罩点击关闭 / 五个入口按钮仍绑定）
   用法：node test-menu-v2.js                                                  */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; failures.push(msg + (extra ? '   [' + extra + ']' : '')); }
}

/* ---------- 极简 DOM stub（记录事件监听，便于验证遮罩点击） ---------- */
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
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = new FakeEl(); return this._qs[sel]; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
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
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
global.PokerCore = require('./core.js');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const $ = id => document.getElementById(id);

/* ---------- 1) 源码级：主菜单结构 ---------- */
const menu = html.slice(html.indexOf('id="lobby-select"'), html.indexOf('id="lobby-host"'));
ok(/class="ms-head"/.test(menu), '主菜单头部卡片（副标题 + 参数摘要）就位');
ok((menu.match(/class="ms-chip"/g) || []).length === 4, '参数胶囊共 4 枚', 'n=' + (menu.match(/class="ms-chip"/g) || []).length);
ok(/100BB/.test(menu) && /0\.5 \/ 1/.test(menu) && /自动买入/.test(menu) && /GTO 范围 \+ MDF/.test(menu),
  '参数胶囊内容：100BB / 盲注 0.5/1 / 破产自动买入 / AI 策略');
ok(/class="ms-nick"/.test(menu) && /id="nick-input"/.test(menu), '昵称行保留（含 nick-input）');
ok((menu.match(/class="ms-gt"/g) || []).length === 2 && /单机与训练/.test(menu) && />\s*联机\s*</.test(menu),
  '模式分两组：「单机与训练」/「联机」');
ok((menu.match(/class="ms-mode"/g) || []).length === 3 && (menu.match(/class="ms-mode primary"/g) || []).length === 1,
  '模式卡片：3 张次级 + 1 张主推荐', '次级=' + (menu.match(/class="ms-mode"/g) || []).length);
ok(/class="ms-mode primary" id="btn-start"/.test(menu), '「单机游戏」为推荐主入口（primary 高亮）');
ok(['btn-start', 'btn-train', 'btn-duel', 'btn-create', 'btn-join'].every(id => menu.indexOf('id="' + id + '"') >= 0),
  '五个入口按钮 id 全部保留');
ok(/id="room-input"/.test(menu), '房间号输入框保留');
ok(/class="ms-mode"[^>]*>[\s\S]*?<b>翻前训练<\/b><em>/.test(menu) && /<b>超能力单挑<\/b><em>2 人 · 特殊视角能力<\/em>/.test(menu),
  '模式卡承担说明文字（名称 + 一句副标题）');
ok(/class="ic"[^>]*>⚡</.test(menu) && !/<b>[^<]*(🎓|⚡|🦑)/.test(menu), 'emoji 移出按钮文案，改放左侧图标位');
ok(/class="ms-jbtn" id="btn-join"/.test(menu), '加入房间为蓝色主操作按钮');

/* 开发者信息必须移出主菜单 */
ok(!/node server\.js/.test(menu) && !/服务器IP/.test(menu) && !/GTO Wizard 范围表策略/.test(menu),
  '开发者信息（启动命令 / IP / 策略实现细节）已移出主菜单');

/* 标题与页面标题回归产品名 */
ok(/<h1>德州扑克训练营<\/h1>/.test(html), '标题回归产品名「德州扑克训练营」');
ok(/<title>德州扑克训练营<\/title>/.test(html), '浏览器标题同步为产品名');

/* 帮助弹窗承接开发者信息 */
const helpSeg = html.slice(html.indexOf('id="nethelp-modal"'), html.indexOf('id="nethelp-modal"') + 2400);
ok(/node server\.js/.test(helpSeg) && /8787/.test(helpSeg), '联机启动说明弹窗保留启动命令与端口');
ok(/id="btn-nethelp-close"/.test(helpSeg), '联机说明弹窗有关闭按钮');
ok(html.indexOf("'settings-modal', 'nethelp-modal']") >= 0, 'exitToMenu 弹窗归零列表含 nethelp-modal');
ok(/\.ms-mode\.primary\s*\{[\s\S]*?rgba\(31,157,85/.test(html), 'CSS：主推荐卡用绿边渐变（视觉主次）');

/* ---------- 2) 行为级：帮助弹窗开关 ---------- */
ok(typeof $('btn-net-help').onclick === 'function', '主菜单「⟡ 联机启动说明」入口已绑定点击');
$('btn-net-help').onclick();
ok(!$('nethelp-modal')._class.has('hidden'), '点击入口打开联机说明弹窗');
$('btn-nethelp-close').onclick();
ok($('nethelp-modal')._class.has('hidden'), '「知道了」关闭弹窗');
$('btn-net-help').onclick();
const lis = $('nethelp-modal')._listeners['click'] || [];
ok(lis.length > 0, '弹窗注册了遮罩点击关闭');
lis.forEach(fn => fn.call($('nethelp-modal'), { target: $('nethelp-modal') }));
ok($('nethelp-modal')._class.has('hidden'), '点击遮罩本身关闭弹窗');

/* ---------- 3) 行为级：入口按钮仍可用 ---------- */
['btn-start', 'btn-train', 'btn-duel', 'btn-create', 'btn-join'].forEach(function (id) {
  ok(typeof $(id).onclick === 'function', '入口 ' + id + ' 仍绑定点击处理');
});
$('nick-input').value = '临时玩家';
$('btn-start').onclick();   // 单机开局：不应抛错
ok(global.window.__PokerTest && global.window.__PokerTest.players, '点击「单机游戏」后测试钩子正常（未抛错）');

/* ---------- 结果 ---------- */
console.log('=== 主菜单面板 v2 测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  ✗ ' + f)); }
process.exit(fail ? 1 : 0);
