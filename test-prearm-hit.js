/* 真实浏览器命中测试（A/B）：从成品 HTML 抽取真实 CSS，用 Edge(Chromium) 无头模式验证
   #btn-fold 在"未轮到自己（.disabled + .pre-armed）"状态下能否真正接到点击。
   elementFromPoint 是 pointer-events 的真实语义 —— 若为 none，命中的会是父元素。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
/* 可选参数：指定要校验的 html（默认本地成品；可指向 gto策略培养皿-线上 验证已发布产物） */
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'gto策略培养皿.html');
console.log('校验目标：' + target);
const html = fs.readFileSync(target, 'utf8');

/* 从成品文件里原样抽取三条关键规则 */
function rule(id) { return id; }
const R_DISABLED = html.match(/#action-bar\.disabled \.btn \{[^}]*\}/)[0];
const R_ARM_BTN = html.match(/#action-bar\.pre-armed #btn-fold,\s*\n\s*#action-bar\.pre-armed #btn-check \{[^}]*\}/)[0];
const R_PREON = html.match(/#action-bar\.pre-armed \.btn\.pre-on \{[^}]*\}/)[0];
console.log('--- 从成品文件抽取的规则 ---');
console.log(R_DISABLED);
console.log(R_ARM_BTN);
console.log(R_PREON);

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const EDGE = EDGE_CANDIDATES.filter(function (p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } })[0];
if (!EDGE) {
  console.log('（跳过：本机未找到 Edge/Chrome，真实浏览器命中测试无法执行）');
  process.exit(0);
}

function makePage(name, css) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><title>hit</title><style>
.btn { padding: 12px 22px; font-size: 16px; }
${css}
</style></head><body>
<div id="action-bar" class="disabled pre-armed"><div id="main-buttons" style="display:flex;gap:10px">
<button class="btn" id="btn-fold">FOLD</button>
<button class="btn" id="btn-check">CHECK</button>
<button class="btn" id="btn-raise">RAISE</button>
</div></div>
<script>
window.addEventListener('load', function () {
  function hit(id) {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { pe: getComputedStyle(el).pointerEvents, hitsSelf: at === el, hitId: at ? (at.id || at.tagName) : null };
  }
  document.body.setAttribute('data-result', JSON.stringify({ fold: hit('btn-fold'), check: hit('btn-check'), raise: hit('btn-raise') }));
});
</script></body></html>`, 'utf8');
  return file;
}

function run(file) {
  const out = execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--virtual-time-budget=3000', '--dump-dom', 'file:///' + file.replace(/\\/g, '/')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  const m = out.match(/data-result="([^"]*)"/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null;
}

let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } }

/* ---------- 修复前（旧规则：只有 .pre-on 放开） ---------- */
const OLD_CSS = [R_DISABLED, '#action-bar.pre-armed .btn.pre-on { pointer-events: auto !important; opacity: 1 !important; }'].join('\n');
const oldFile = makePage('prearm-old.html', OLD_CSS);
const oldRes = run(oldFile);
console.log('\n--- 修复前（旧 CSS）---');
console.log(JSON.stringify(oldRes));
ok(oldRes && oldRes.fold.hitsSelf === false,
  '旧 CSS：#btn-fold 未预选时点不中（pointer-events:none 命中父元素）→ 复现"预选择不生效"');

/* ---------- 修复后（成品文件真实规则） ---------- */
const newFile = makePage('prearm-new.html', [R_DISABLED, R_ARM_BTN, R_PREON].join('\n'));
const newRes = run(newFile);
console.log('\n--- 修复后（成品 CSS）---');
console.log(JSON.stringify(newRes));
ok(newRes && newRes.fold.hitsSelf === true, '修复后：#btn-fold 在等待期可以真正接到点击');
ok(newRes && newRes.check.hitsSelf === true, '修复后：#btn-check 在等待期可以真正接到点击');
ok(newRes && newRes.raise.hitsSelf === false, '修复后："加注"仍不可点（不参与预选）');

[oldFile, newFile].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
console.log('\n=== 真实浏览器命中测试: ' + pass + ' 通过, ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
