/* 预操作端到端回归（真实浏览器）
   为什么需要它：test-preaction.js 用的是 DOM 桩，只能验证"函数被调用"；
   而"预选弃牌，轮到本人时仍要手点"这类 bug 恰恰出在**真实牌局主循环**里 ——
   消费点若放在 humanResolve 就位之前，动作会被 resolveHuman 静默丢弃，
   桩里看不出来（lastSubmittedAction 早已被赋值，假通过）。

   本测试在真实 Edge 里跑完整单机牌局：不是自己回合时真点"弃牌"预选，
   然后看轮到自己时是否自动执行。
   关键信号：预选后若出现"actingIdx === 0 且行动条被放开" → 预选没生效。
   （旧实现：badTurns = [1] 且牌局卡死在第一手等人；修复后 badTurns = []）

   无 Edge/Chrome 时跳过（不算失败），与 test-prearm-hit.js 同策略。
   用法：node test-preaction-e2e.js [html 路径] */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const BUDGET = 46000;              // 虚拟时间预算（ms）；Worker 计时器已禁用 → 可快进
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const browser = CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!browser) {
  console.log('=== 预操作端到端测试：跳过（未找到 Edge/Chrome） ===');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = function (c, name) {
  if (c) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
};

const target = process.argv[2] || path.join(DIR, 'gto策略培养皿.html');
const patchedFile = path.join(DIR, 'tmp-pae2e-target.html');
const driverFile = path.join(DIR, 'tmp-pae2e-driver.html');

/* 补丁副本：禁 Web Worker 计时器 → hardSetTimeout 退化为 setTimeout，
   virtual-time 才能快进整手牌（Worker 内 timer 不受虚拟时间控制）。 */
let html = fs.readFileSync(target, 'utf8');
if (html.indexOf('hardWorker = new Worker(') < 0) {
  console.log('=== 预操作端到端测试：跳过（找不到 Worker 计时器锚点） ===');
  process.exit(0);
}
fs.writeFileSync(patchedFile, html.replace('hardWorker = new Worker(', 'if (1) throw 0; hardWorker = new Worker('));

fs.writeFileSync(driverFile, `<!doctype html><html><head><meta charset="utf-8"><title>PENDING</title></head>
<body style="margin:0;background:#111">
<iframe id="f" width="390" height="844" src="${path.basename(patchedFile)}"></iframe>
<script>
var R = { preHands: [], badTurns: [], folds: [], preLogs: [], manualClicks: 0, samples: 0 };
var preSet = false, preHandNo = -1, lastPreHand = -1;
var f = document.getElementById('f');
f.addEventListener('load', function () {
  var d = f.contentDocument, w = f.contentWindow;
  try { d.getElementById('nick-input').value = '探针'; } catch (e) {}
  try { d.getElementById('btn-start').click(); } catch (e) { R.startErr = String(e && e.message); }
  var iv = setInterval(function () {
    try {
      var T = w.__PokerTest; if (!T) return;
      var s = T.debug.state();
      R.samples++;
      T.logLines().forEach(function (l) {
        if (l.text.indexOf('（预操作）') >= 0 && R.preLogs.indexOf(l.text) < 0) R.preLogs.push(l.text);
      });
      if (preHandNo !== -1 && s.handNo !== preHandNo) { preSet = false; preHandNo = -1; }  // 换手：复位
      if (preSet) {
        if (s.seats[0] && s.seats[0].inHand === false && R.folds.indexOf(preHandNo) < 0) R.folds.push(preHandNo);
        // 关键信号：预选还在，人却被要求行动 → 预选没生效
        if (s.actingIdx === 0 && !s.handSettling && R.badTurns.indexOf(preHandNo) < 0) R.badTurns.push(preHandNo);
        return;
      }
      if (s.handSettling) return;
      if (s.actingIdx === 0) {                       // 正常轮到我（未预选）→ 点按钮推进牌局
        var b = d.getElementById('btn-check'), fb = d.getElementById('btn-fold');
        if (b && !b.disabled) b.click(); else if (fb) fb.click();
        R.manualClicks++;
        return;
      }
      if (lastPreHand === s.handNo) return;          // 本手已预选过，不重复
      if (T.preAction.canPreAct() && T.preAction.barClass('pre-armed')) {
        d.getElementById('btn-fold').click();        // 真点"弃牌"预选
        if (T.preAction.state() === 'fold') {
          preSet = true; preHandNo = s.handNo; lastPreHand = s.handNo;
          if (R.preHands.indexOf(s.handNo) < 0) R.preHands.push(s.handNo);
        }
      }
    } catch (e) { R.err = String(e && e.message); }
  }, 40);
  setTimeout(function () { clearInterval(iv); document.title = 'R=' + JSON.stringify(R); }, ${BUDGET});
});
</script></body></html>`);

let out = '';
try {
  out = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--virtual-time-budget=' + (BUDGET + 4000),
    '--window-size=460,920', '--dump-dom', 'file:///' + driverFile.replace(/\\/g, '/')
  ], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  out = (e && e.stdout) ? String(e.stdout) : '';
}

console.log('--- 真实浏览器：单机牌局预选弃牌 ---');
const m = out.match(/<title>([\s\S]*?)<\/title>/);
const t = m ? m[1].trim() : '';
try { fs.unlinkSync(patchedFile); } catch (e) {}
try { fs.unlinkSync(driverFile); } catch (e) {}

if (!t.startsWith('R=')) {
  console.log('=== 预操作端到端测试：跳过（浏览器未产出结果：' + (t || '(no title)').slice(0, 120) + '） ===');
  process.exit(0);
}
const R = JSON.parse(t.slice(2));
console.log('  采样 ' + R.samples + ' 次；预选过的牌局 = [' + R.preHands.join(', ') + ']');
console.log('  预选后本人真的弃牌的牌局 = [' + R.folds.join(', ') + ']');
console.log('  "（预操作）"日志 = ' + JSON.stringify(R.preLogs.slice(0, 3)));

ok(R.preHands.length >= 1, '抓到预选窗口并成功预选弃牌（' + R.preHands.length + ' 手）');
ok(R.badTurns.length === 0,
  '预选后从未被要求手动行动（未被要求行动的牌局外：' + (R.badTurns.length ? '[' + R.badTurns.join(', ') + '] ✗' : '无 ✓') + '）');
ok(R.folds.length >= 1, '轮到时动作真的交回牌局（本人实际弃牌 ' + R.folds.length + ' 手）');
ok(R.preLogs.some(function (s) { return s.indexOf('（预操作）弃牌') >= 0; }), '日志出现"（预操作）弃牌"');

console.log('\n=== 预操作端到端测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
