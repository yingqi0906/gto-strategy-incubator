/* E2E 主机进程：真实服务器上建房、加AI、开局、自动行动；观察迟到者入座日志 */
'use strict';
const fs = require('fs');
const path = require('path');

class FakeEl {
  constructor(tag) {
    this.tag = tag || 'div';
    this.children = [];
    this._class = new Set();
    this.style = {};
    this.parentNode = null;
    this.textContent = ''; this.innerHTML = '';
    this.disabled = false; this.value = '';
    this.min = ''; this.max = ''; this.step = '';
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
global.location = { host: '127.0.0.1:8902', origin: 'http://127.0.0.1:8902', href: 'http://127.0.0.1:8902/', search: '', protocol: 'http:', pathname: '/' };
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms, ...a) { return realSetTimeout(fn, Math.min(ms || 0, 80), ...a); };
global.alert = function (m) { console.log("HOST-ALERT: " + m); try { throw new Error('alert-trace'); } catch (e) { console.log(e.stack.split('\n').slice(1, 4).join('\n')); } };

const BASE = 'http://127.0.0.1:8902';
const realFetch = global.fetch;
global.fetch = function (u, o) {
  console.log('[FETCH]', u);
  const p = realFetch(BASE + u, o);
  p.catch(e => console.log('[FETCH-ERR]', u, e && e.message, e && e.cause && e.cause.message));
  return p;
};

require('./core.js');
global.PokerCore = module.require('./core.js');
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const catchOld = "catch(function () {\n      alert('无法连接服务器。请先运行 node server.js，然后通过 http://localhost:8787 打开本页面。');";
const catchNew = "catch(function (e) { console.log('[REAL-ERR]', e && (e.stack || String(e)));";
eval(m[1].split(catchOld).join(catchNew));

const $ = id => document.getElementById(id);
const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));

(async function main() {
  $('nick-input').value = '主机';
  $('btn-create').onclick(); console.log('HOST-CLICKED');
  fetch('/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'probe2' }) })
    .then(r => { console.log('[PROBE] status', r.status, r.headers.get('content-type')); return r.json(); })
    .then(d => console.log('HOST-PROBE-OK', JSON.stringify(d)))
    .catch(e => console.log('HOST-PROBE-ERR', e.message, e.cause && e.cause.message));
  // 复刻 mpApi 完整链
  realFetch(BASE + '/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'probe3' }) })
    .then(r => r.json())
    .then(function (d) { console.log('[MPAPI-CLONE]', JSON.stringify(d)); })
    .catch(function (e) { console.log('[MPAPI-CLONE-ERR]', e && e.message, e && e.stack && e.stack.split('\n')[1]); });
  // 等建房完成（room-tag 显示房间号）
  let room = '';
  for (let i = 0; i < 200 && !room; i++) {
    await sleepTick();
    room = ($('room-tag').textContent.match(/\d{5}/) || [''])[0];
  }
  if (!room) { console.log('HOST-FAIL: 建房超时'); process.exit(1); }
  console.log('HOST-ROOM:' + room);
  fs.writeFileSync(path.join(__dirname, 'e2e-room.txt'), room);

  // 加 2 个 AI 后开局
  await wallSleep(300);
  $('btn-addai').onclick(); await wallSleep(200);
  $('btn-addai').onclick(); await wallSleep(200);
  $('btn-mp-start').onclick();

  // 自动行动循环：主机本人尽快弃牌/过牌，同时监测迟到者入座
  const t0 = Date.now();
  let seated = false;
  while (Date.now() - t0 < 60000) {
    await sleepTick();
    while (logLines.length) {
      const line = logLines.shift();
      if (line.indexOf('迟到者') >= 0 && line.indexOf('开始加入游戏') >= 0 && !seated) {
        seated = true;
        console.log('HOST-SEATED: ' + line);
      }
    }
    if (!byId['btn-fold'].disabled) { byId['btn-fold'].onclick(); }
    else if (byId['btn-check'].textContent.indexOf('过牌') >= 0) { byId['btn-check'].onclick(); }
  }
  if (!seated) console.log('HOST-NO-SEAT-EVENT');
  console.log('HOST-DONE');
  process.exit(0);
})().catch(e => { console.error('主机异常:', e); process.exit(1); });
