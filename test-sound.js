/* 音效引擎测试（2026-10-17）
   背景：手机端完全没声音——移动浏览器禁止"非用户手势内"的音频播放，
   旧实现只有 <audio> 通道，首次 play() 在定时器里被静音拦截且永不解锁。
   本测试验证新引擎：WebAudio 主通道 + 手势解锁 + <audio> 兜底 + 开关门控。 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  [' + extra + ']' : '')); }
}

/* ---------- ① 源码层：双通道与手势绑定 ---------- */
const sndSrc = (function () {
  const i = html.indexOf('const SND = (function () {');
  if (i < 0) return '';
  const j = html.indexOf('\n  })();', i);
  return html.slice(i, j + 8);
})();
ok(!!sndSrc, '① 能定位 SND 音效模块源码');
ok(/window\.AudioContext \|\| window\.webkitAudioContext/.test(sndSrc),
  '① 主通道使用 WebAudio（含 webkitAudioContext 兼容）');
ok(/decodeAudioData/.test(sndSrc) && /createBufferSource/.test(sndSrc),
  '① 音效预先 decodeAudioData 成 AudioBuffer，用 BufferSource 播放');
ok(/function unlock\(\)/.test(sndSrc) && /if \(unlocked\) return;/.test(sndSrc),
  '① 有一次性 unlock 流程');
ok(/document\.addEventListener\('pointerdown', onGesture, true\)/.test(sndSrc) &&
  /document\.addEventListener\('touchstart', onGesture, true\)/.test(sndSrc),
  '① 首次 pointerdown/touchstart 触发解锁（捕获阶段，早于业务逻辑）');
ok(/a\.muted = true;[\s\S]*?a\.play\(\)/.test(sndSrc),
  '① <audio> 兜底通道在手势内静音试播一次完成 iOS 解锁');
ok(/ctx\.state === 'suspended'[\s\S]*?ctx\.resume\(\)/.test(sndSrc),
  '① 切后台/来电后 AudioContext 被挂起 → 下次手势自动 resume');
ok(/if \(!APP_SETTINGS\.sound\) return;/.test(sndSrc),
  '① 设置关闭时 SND.play 直接返回（不发声）');
ok(/if \(ctx && buffers\[name\]\)[\s\S]*?src\.start\(0\);[\s\S]*?return;/.test(sndSrc),
  '① 播放优先走 WebAudio（buffer 就绪时不再用 <audio>）');
/* 静态契约：滑块横条 + 面板级热区 */
ok(/#vslider-thumb \{[\s\S]*?width: 48px; height: 22px/.test(html),
  '① 滑块为横向长方形 48×22');

/* ---------- ② 行为层：用假浏览器跑真模块 ---------- */
function makeEnv(opts) {
  opts = opts || {};
  const env = { started: [], fetched: [], elementPlays: 0, handlers: {}, ctxState: 'suspended' };
  const AudioStub = function (src) {
    this.src = src; this.muted = false; this.volume = 1; this.currentTime = 0;
    this.preload = ''; this.paused = true;
  };
  AudioStub.prototype.load = function () {};
  AudioStub.prototype.pause = function () { this.paused = true; };
  AudioStub.prototype.play = function () {
    env.elementPlays++;
    // 模拟移动端：未静音且不在手势内 → 拒绝
    if (!this.muted && !env.unlockedByGesture) {
      return Promise.reject(new Error('NotAllowedError'));
    }
    this.paused = false;
    return Promise.resolve();
  };
  const ACStub = function () { this.state = env.ctxState; this.destination = {}; env.ctxInstance = this; };
  ACStub.prototype.resume = function () { env.ctxState = 'running'; this.state = 'running'; return Promise.resolve(); };
  ACStub.prototype.decodeAudioData = function (buf, res) { res({ fake: true, len: buf.byteLength }); };
  ACStub.prototype.createBufferSource = function () {
    const self = this;
    return { buffer: null, connect: function () {}, start: function () { env.started.push(this.buffer); } };
  };
  ACStub.prototype.createGain = function () {
    return { gain: { value: 1 }, connect: function () {} };
  };
  const doc = {
    addEventListener: function (t, fn) { (env.handlers[t] = env.handlers[t] || []).push(fn); }
  };
  const win = { AudioContext: ACStub };
  const fetchStub = function (u) {
    env.fetched.push(u);
    return Promise.resolve({ arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } });
  };
  const APP_SETTINGS = { sound: opts.sound !== false };
  const fn = new Function('APP_SETTINGS', 'document', 'window', 'fetch', 'Audio',
    sndSrc + '\n; return SND;');
  const SND = fn(APP_SETTINGS, doc, win, fetchStub, AudioStub);
  env.SND = SND; env.doc = doc; env.settings = APP_SETTINGS; env.win = win;
  return env;
}

(async function run() {
  /* ②-1 加载阶段不发声 */
  let env = makeEnv();
  ok(env.fetched.length === 0, '② 页面加载阶段不请求/播放音效（等手势）');

  /* ②-2 手势解锁：resume + 拉取 6 个音效 + 静音试播 */
  const handlers = env.handlers.pointerdown || [];
  ok(handlers.length === 1, '② pointerdown 手势监听已注册');
  env.unlockedByGesture = true;          // 手势内浏览器放行
  handlers[0]();
  ok(env.ctxState === 'running', '② 手势触发后 AudioContext 被 resume');
  ok(env.fetched.length === 6, '② 手势后拉取全部 6 个音效（实际 ' + env.fetched.length + '）');
  ok(env.elementPlays === 6, '② <audio> 兜底通道各自静音试播一次完成解锁（' + env.elementPlays + '）');

  /* 等 decode */
  await new Promise(r => setTimeout(r, 30));
  const beforeEl = env.elementPlays, beforeBuf = env.started.length;
  env.SND.play('raise', 0.5);
  ok(env.started.length === beforeBuf + 1, '② 解码完成后走 WebAudio BufferSource 播放');
  ok(env.elementPlays === beforeEl, '② 走 WebAudio 时不再动 <audio> 元素');

  /* ②-3 关闭音效 → 完全静默 */
  const env2 = makeEnv({ sound: false });
  env2.unlockedByGesture = true;
  (env2.handlers.pointerdown || []).forEach(f => f());
  await new Promise(r => setTimeout(r, 30));
  const s0 = env2.started.length;
  env2.SND.play('call');
  ok(env2.started.length === s0, '② 设置关闭声音时 SND.play 不发声');

  /* ②-4 手势前调用 play（模拟定时器里的动作音）→ 只能落到 <audio> 且被拒，不抛异常 */
  const env3 = makeEnv();
  let threw = false;
  try { env3.SND.play('fold'); } catch (e) { threw = true; }
  ok(!threw, '② 未解锁时播放不抛异常（安全降级）');

  /* ②-5 后台恢复：再次手势把 suspended 上下文唤醒 */
  const env4 = makeEnv();
  env4.unlockedByGesture = true;
  (env4.handlers.pointerdown || []).forEach(f => f());
  await new Promise(r => setTimeout(r, 20));
  env4.ctxState = 'suspended';                  // 模拟切后台（实例状态也置为 suspended）
  if (env4.ctxInstance) env4.ctxInstance.state = 'suspended';
  const again = env4.handlers.pointerdown[0];
  again();
  ok(env4.ctxState === 'running', '② 切后台后再触摸 → AudioContext 重新 resume');

  console.log('\n--- 音效引擎测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
  process.exit(fail ? 1 : 0);
})();
