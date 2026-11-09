/* 聊天功能测试
   1) 服务器中继：主机发言广播全员、客机发言中继主机、空文本不广播、超长截断
   2) 无头 UI：addChat 未读数、面板开合、空输入提示"请输入内容"、本人消息 me 标记 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };

/* ================= 第一部分：无头 UI 测试 ================= */
function uiTests() {
  console.log('--- 无头 UI：聊天面板 ---');
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
    get className() { return [...this._class].join(' '); }
    set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); } /* 与真实 DOM 一致 */
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) { this._innerHTML = v; this.children = []; } /* 与真实 DOM 一致：置空即清空子节点 */
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
  /* 按 HTML 初始状态预置聊天相关元素 */
  const chatModal = seed('chat-modal', ['modal', 'hidden']);
  const chatToggle = seed('chat-toggle', []);
  const chatInput = seed('chat-input', []);
  const chatHint = seed('chat-hint', []);
  const chatBadge = seed('chat-badge', []);
  seed('chat-msgs', []);
  seed('btn-chat-send', []);
  seed('btn-chat-close', []);
  seed('nick-input', []);

  global.document = {
    getElementById(id) { if (!byId[id]) byId[id] = new FakeEl(); return byId[id]; },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener() {}
  };
  global.window = global;
  global.localStorage = { getItem: () => null, setItem: () => {} };
  global.PokerCore = require('./core.js');
  const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  eval(m[1]);
  const T = global.window.__PokerTest;

  /* 源码级：结构与样式 */
  ok(/id="chat-toggle"/.test(html) && /<svg[\s\S]*?<\/svg>\s*<span id="chat-badge"/.test(html), '聊天按钮含聊天气泡 SVG 图形与未读角标');
  // 2026-10-10 调整：按钮从"贴视口底部"改为"贴行动条上沿"
  // （手机端行动条较高，贴底部会压住"弃牌/过牌/加注"按钮）
  ok(/#chat-toggle\s*\{[^}]*position:\s*fixed[^}]*left:\s*12px/.test(html) &&
     /#chat-toggle\s*\{[^}]*bottom:\s*calc\(var\(--action-bar-h\)/.test(html),
    '聊天按钮固定于左下角、位于底部行动条上方');
  ok(/id="chat-msgs"/.test(html) && /id="chat-input-row"/.test(html) && /id="btn-chat-send"/.test(html),
    '聊天面板分为消息区（chat-msgs）与输入区（chat-input-row + 发送按钮）');
  ok(/chat-row\.me \{ align-items: flex-end/.test(html) && /chat-row:not\(\.me\)/.test(html),
    '微信式布局：自己的发言居右（.me 右对齐），他人居左');
  ok(/chat-row\.me \.chat-bubble \{ background: #95ec69/.test(html), '自己消息为微信式绿泡');
  ok(html.includes("chatHint('请输入内容')"), '空内容发送返回提示"请输入内容"');

  /* 行为级 */
  const st = () => T.chat.state();
  ok(st().log.length === 0 && st().unread === 0, '初始无消息、无未读');

  T.chat.addChat('张三', '大家好', false);
  ok(st().log.length === 1 && st().log[0].name === '张三' && st().log[0].text === '大家好' && !st().log[0].me,
    '他人消息入记录：含名称与内容');
  ok(st().unread === 1, '面板未打开时消息计入未读');
  ok(chatBadge.classList.contains('show'), '未读角标显示');

  T.chat.toggleChat(true);
  ok(!chatModal.classList.contains('hidden'), '点击后打开聊天界面');
  ok(st().unread === 0 && !chatBadge.classList.contains('show'), '打开面板后未读清零');
  const box = byId['chat-msgs'];
  ok(box.children.length === 1 && !box.children[0].classList.contains('me'), '他人消息行无 me 标记（居左）');

  /* 空输入：提示且不发送 */
  chatInput.value = '   ';
  T.chat.chatSend();
  ok(chatHint.textContent === '请输入内容' && chatHint.classList.contains('show'), '空/空白输入返回提示"请输入内容"');
  ok(st().log.length === 1, '空输入未产生新消息');

  /* 有输入（单机模式不发送到服务器）：输入框清空 */
  chatInput.value = '单机试试';
  T.chat.chatSend();
  ok(chatInput.value === '', '发送后输入框清空');
  ok(st().log.length === 1, '单机模式不写入聊天（聊天仅联机可用）');

  /* 本人消息：me 标记（居右） */
  T.chat.addChat('我', '我发一条', true);
  T.chat.addChat('超长'.repeat(100), 'x', false);
  ok(st().log.length === 3, '新消息入记录');
  T.chat.toggleChat(true);
  const rows = box.children;
  ok(rows.length === 3 && rows[1].classList.contains('me') && !rows[0].classList.contains('me') && !rows[2].classList.contains('me'),
    '本人消息行带 me 标记（居右绿泡），他人消息居左');
  ok(rows[1].children[1].textContent === '我发一条', '气泡内容正确（textContent 渲染防注入）');
  ok(rows[2].children[0].textContent.length === 12, '超长名称截断到 12 字');

  T.chat.toggleChat(false);
  ok(chatModal.classList.contains('hidden'), '关闭聊天界面');
  return { pass, fail };
}

/* ================= 第二部分：服务器中继 E2E ================= */
async function serverTests() {
  console.log('--- 服务器中继：聊天消息 ---');
  const PORT = 18793;
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
  const c2 = await post('/api/join', { room: host.room, name: '客机二' });
  ok(host.ok && c1.ok && c2.ok, '主机与两客机入座');

  /* 主机发言 → 广播全员 */
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'chat', name: '主机', seat: host.seat, text: '各位晚上好' } });
  const b1 = await pollOnce(host.room, c1.id, 0);
  const b2 = await pollOnce(host.room, c2.id, 0);
  const m1 = b1.msgs.filter(x => x.type === 'chat');
  const m2 = b2.msgs.filter(x => x.type === 'chat');
  ok(m1.length === 1 && m1[0].text === '各位晚上好' && m1[0].name === '主机', '客机一收到主机发言（含名称与内容）');
  ok(m2.length === 1 && m2[0].text === '各位晚上好', '客机二收到主机发言');

  /* 客机发言 → 中继主机 */
  await post('/api/msg', { room: host.room, id: c1.id, msg: { type: 'chat', action: { text: '主机你好' } } });
  const hb = await pollOnce(host.room, host.id, 0);
  const relays = hb.msgs.filter(x => x.type === 'chat');
  ok(relays.length === 1 && relays[0].seat === c1.seat && relays[0].action && relays[0].action.text === '主机你好',
    '主机收到客机发言中继（带座位号）');

  /* 主机广播客机发言 → 全员（含发送者回显） */
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'chat', name: '客机一', seat: c1.seat, text: '主机你好' } });
  const e1 = await pollOnce(host.room, c1.id, b1.seq);
  const e2 = await pollOnce(host.room, c2.id, b2.seq);
  ok(e1.msgs.some(x => x.type === 'chat' && x.text === '主机你好' && x.seat === c1.seat),
    '发送者收到回显（seat 标记可判定本人）');
  ok(e2.msgs.some(x => x.type === 'chat' && x.text === '主机你好'), '其他客机收到广播');

  /* 空文本不广播；超长截断 */
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'chat', name: 'x', seat: host.seat, text: '   ' } });
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'chat', name: 'x', seat: host.seat, text: '啊'.repeat(300) } });
  const z = await pollOnce(host.room, c1.id, e1.seq);
  const zc = z.msgs.filter(x => x.type === 'chat');
  ok(zc.length === 1 && zc[0].text.length === 120, '空白文本不广播、超长文本截断到 120 字');

  srv.kill();
  await sleep(150);
}

(async function main() {
  const ui = uiTests();
  console.log('--- 无头 UI 小计: ' + ui.pass + ' 通过, ' + ui.fail + ' 失败 ---');
  await serverTests();
  console.log('\n=== 聊天功能测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
