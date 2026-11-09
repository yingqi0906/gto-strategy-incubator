/* E2E 客机进程：游戏中加入真实房间，监测行动条是否在轮到自己时启用 */
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
global.alert = function (msg) { console.log('CLIENT-ALERT: ' + msg); };

const BASE = 'http://127.0.0.1:8902';
const realFetch = global.fetch;
global.fetch = function (u, o) { return realFetch(BASE + u, o); };

require('./core.js');
global.PokerCore = module.require('./core.js');
const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
eval(m[1]);

const $ = id => document.getElementById(id);
const sleepTick = () => new Promise(r => realSetTimeout(r, 0));
const wallSleep = ms => new Promise(r => realSetTimeout(r, ms));

(async function main() {
  const room = process.argv[2] || fs.readFileSync(path.join(__dirname, 'e2e-room.txt'), 'utf8').trim();
  $('nick-input').value = '迟到者';
  $('room-input').value = room;
  $('btn-join').onclick();
  console.log('CLIENT-JOIN-SENT');

  const t0 = Date.now();
  let enabledAt = -1, acted = false, joinedPlaying = false;
  while (Date.now() - t0 < 55000) {
    await wallSleep(120);
    if (!joinedPlaying && !$('overlay').classList.contains('hidden')) {
      joinedPlaying = true;
      console.log('CLIENT-IN-GAME (观战视角)');
    }
    const enabled = !$('action-bar').classList.contains('disabled') &&
      $('btn-check').textContent.length > 0; // showActionUI 设置过按钮文字才算真启用
    if (enabled && enabledAt < 0) {
      enabledAt = Date.now() - t0;
      console.log('CLIENT-ACTION-ENABLED at ' + enabledAt + 'ms  按钮: [' +
        $('btn-fold').textContent + '/' + $('btn-check').textContent + '/' + $('btn-raise').textContent + ']');
    }
    if (enabled && !acted) {
      acted = true;
      try { byId['btn-check'].onclick(); console.log('CLIENT-ACTED (点击跟注/过牌)'); }
      catch (e) { console.log('CLIENT-CLICK-ERR', e.message); }
    }
  }
  if (enabledAt < 0) console.log('CLIENT-FAIL: 55秒内行动条从未启用（复现按钮灰态bug）');
  else console.log('CLIENT-OK');
  process.exit(enabledAt < 0 ? 2 : 0);
})().catch(e => { console.error('客机异常:', e); process.exit(1); });
