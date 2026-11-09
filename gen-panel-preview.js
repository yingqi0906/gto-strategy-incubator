/* gen-panel-preview.js — 用无头 mock 跑真实单机牌局，把「对局信息面板」的真实渲染结果
   导出成一张可直接在浏览器打开的预览图（内联页面样式，非模拟数据）。
   用法：node gen-panel-preview.js
   产物：对局信息面板-实测预览.html                                  */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 与 harness.js 同源的极简 DOM stub ---------- */
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
  body: new FakeEl('body'),
  documentElement: new FakeEl('html'),
  hidden: false
};
global.window = global;
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { return setImmediate(fn); };  // 加速 AI 思考与动画

require('./core.js');
global.PokerCore = module.require('./core.js');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const sm = html.match(/<script>([\s\S]*?)<\/script>/);
if (!sm) { console.error('未找到内嵌脚本'); process.exit(1); }
eval(sm[1]);
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

const $ = id => byId[id];
const tick = (ms) => new Promise(r => realSetTimeout(r, ms || 0));

(async function main() {
  $('btn-start').onclick();                       // 单机游戏（6 人桌）
  const log = $('log');
  const t0 = Date.now();
  let seen = 0, guard = 0;

  /* 玩家策略：能过牌/跟注就跟，别无脑弃牌 —— 让牌局走到摊牌，才看得到手牌与牌型 */
  while (Date.now() - t0 < 90000 && guard++ < 400000) {
    await tick(0);
    const chk = $('btn-check'), fold = $('btn-fold');
    if (chk && !chk.disabled && chk.onclick) {
      const t = chk.textContent || '';
      if (t.indexOf('过牌') >= 0 || t.indexOf('跟注') >= 0) chk.onclick();
      else if (fold && !fold.disabled && fold.onclick) fold.onclick();
    } else if (fold && !fold.disabled && fold.onclick) fold.onclick();

    // 推进足够多手后收工
    const starts = countStarts(log);
    if (starts.length >= 12 && starts.length === seen) break;
    seen = starts.length;
  }

  const rows = log.children;
  const starts = [];
  rows.forEach(function (r, i) { if (/^===== 第 \d+ 局 =====$/.test(r.textContent || '')) starts.push(i); });
  if (starts.length < 2) { console.error('未收集到完整牌局'); process.exit(1); }

  /* 挑两手：一手走到摊牌（能看到牌型与底池条），一手常规 */
  let showdown = null, normal = null;
  for (let i = starts.length - 2; i >= 0; i--) {
    const seg = rows.slice(starts[i], starts[i + 1] || rows.length);
    const body = seg.map(r => r.textContent || '').join('\n');
    const isShow = /赢得底池/.test(body) || /（(两对|一对|三条|顺子|同花|三条|葫芦|四条|同花顺|高牌)）/.test(body);
    if (isShow && !showdown) showdown = seg;
    if (!normal) normal = seg;
    if (showdown && normal) break;
  }
  const picked = showdown || normal;

  const dump = (seg) => seg.map(function (r) {
    const cls = (r.className || '').trim();
    return '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + (r.innerHTML || '') + '</div>';
  }).join('\n');

  const page = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>对局信息面板 · 实测预览</title>\n<style>\n' + css + '\n' +
    '  body { background: #0b1220; margin: 0; padding: 22px; font-family: "Microsoft YaHei","PingFang SC",sans-serif; }\n' +
    '  .wrap { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }\n' +
    '  #side-panel { position: static; display: flex; height: 620px; }\n' +
    '  .tag { color: #8fb3d9; font-size: 12px; line-height: 1.8; max-width: 250px; }\n' +
    '  .tag b { color: #ffd54a; }\n' +
    '</style>\n</head>\n<body>\n' +
    '<div class="wrap">\n' +
    '<div id="side-panel" class="open">\n' +
    '  <h3>对局信息</h3>\n' +
    '  <div id="hand-hint">实测渲染 · 单机牌局</div>\n' +
    '  <div id="log">\n' + dump(picked) + '\n  </div>\n' +
    '</div>\n' +
    '<div class="tag">\n' +
    '  <p>这份预览<b>不是设计稿</b>，是真实牌局跑出来的渲染结果。</p>\n' +
    '  <p>数据来源：单机 6 人桌自动对局（本脚本驱动）。</p>\n' +
    '  <p>单机模式下对局信息面板的对手手牌<b>保持全秀开</b>；联机模式下未摊牌的对手会显示<b>牌背</b>。</p>\n' +
    '</div>\n</div>\n</body>\n</html>\n';

  const out = path.join(__dirname, '对局信息面板-实测预览.html');
  fs.writeFileSync(out, page, 'utf8');
  console.log('已生成：' + out);
  console.log('导出行数：' + picked.length + '（含' + (showdown ? '摊牌局' : '普通局') + '）');
  process.exit(0);
})().catch(function (e) { console.error('异常:', e); process.exit(1); });

function countStarts(log) {
  const out = [];
  log.children.forEach(function (r, i) {
    if (/^===== 第 \d+ 局 =====$/.test(r.textContent || '')) out.push(i);
  });
  return out;
}
