/* 优质起手牌闪光特效（AA/KK/QQ/AK）测试：
   ① CSS 四层（流光层/pop/sweep/d2 错峰 + reduced-motion）
   ② isPremiumHand 真实逻辑（从源码提取函数体 eval 后喂用例）
   ③ renderSeat 挂接（每手一次、只对自己、双牌齐才触发） */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/gto策略培养皿.html', 'utf8');
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.log('  ✗ ' + msg); }
}

/* ---------- ① CSS ---------- */
ok(/\.hole-cards \.card\.pfx \{ overflow: hidden; transform-origin: 50% 60%; \}/.test(html),
  '① pfx 基础：overflow 裁剪流光 + origin 50% 60%（朝桌心弹起）');
ok(/\.hole-cards \.card\.pfx::after \{[\s\S]*?rgba\(255,213,74,\.75\) 50%[\s\S]*?transform: translateX\(-160%\) skewX\(-18deg\)/.test(html),
  '① 流光层：金白双色 45° 光带，平时停在卡左外');
ok(/\.hole-cards \.card\.pfx\.play \{ animation: cardpop \.8s cubic-bezier\(\.34, 1\.4, \.5, 1\) both; \}/.test(html) &&
  /@keyframes cardpop \{[\s\S]*?scale\(1\.3\)[\s\S]*?scale\(1\.15\)/.test(html),
  '① 膨胀回弹：0.8s 峰值 1.3 + 1.15 中间帧（防弹簧抖两下）');
ok(/\.hole-cards \.card\.pfx\.play\.d2 \{ animation-delay: \.1s; z-index: 2; \}/.test(html) &&
  /\.hole-cards \.card\.pfx\.play\.d2::after \{ animation-delay: \.1s; \}/.test(html),
  '① 第二张牌 0.1s 错峰 + z-index:2（1.3 倍下两卡压边时叠放次序稳定）');
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.hole-cards \.card\.pfx\.play[\s\S]*?animation: none/.test(html),
  '① prefers-reduced-motion 时停用动画');
ok(!/cardfx/.test(html),
  '① 未引入演示稿的 cardfx 类（用项目自己的 pfx 类，不影响普通牌/牌背）');

/* ---------- ② isPremiumHand 真实逻辑 ---------- */
const m = html.match(/function isPremiumHand[\s\S]*?\n  \}/);
ok(!!m, '② 源码中能提取 isPremiumHand 函数体');
if (m) {
  const isPremiumHand = new Function('return (' + m[0] + ')')();
  const C = (r, s) => ({ r: r, s: s || 0, id: r * 4 + (s || 0) });
  ok(isPremiumHand(C(14, 0), C(14, 1)) === true, '② AA（不同花色对子）触发');
  ok(isPremiumHand(C(13, 2), C(13, 3)) === true, '② KK 触发');
  ok(isPremiumHand(C(12, 1), C(12, 2)) === true, '② QQ 触发');
  ok(isPremiumHand(C(14, 1), C(13, 0)) === true, '② AKs 触发');
  ok(isPremiumHand(C(13, 3), C(14, 2)) === true, '② AKo 触发（顺序无关）');
  ok(isPremiumHand(C(11, 0), C(11, 1)) === false, '② JJ 不触发（对子只到 Q）');
  ok(isPremiumHand(C(7, 0), C(2, 3)) === false, '② 72o 不触发');
  ok(isPremiumHand(C(13, 0), C(12, 1)) === false, '② KQ 不触发');
  ok(isPremiumHand(C(14, 0), C(14, 0)) === true, '② 同 id 对子（理论不出现）按点数判定为 true');
  ok(isPremiumHand(null, C(14)) === false && isPremiumHand(C(14), null) === false && isPremiumHand(null, null) === false,
    '② 空牌防御：任一张缺失返回 false');
}

/* ---------- ③ renderSeat 挂接 ---------- */
ok(/let premiumFXHand = -1;/.test(html), '③ 每手一次的防重放标记 premiumFXHand');
ok(/const myCardEls = \[\]; \/\/ 主角本次渲染的两张手牌 DOM（优质起手特效用）/.test(html) &&
  /isMe && handNo > 0 && premiumFXHand !== handNo && p\.hole\.length === 2 &&\s*\n\s*myCardEls\.length === 2 && isPremiumHand\(p\.hole\[0\], p\.hole\[1\]\)/.test(html),
  '③ 触发条件：只对自己 + handNo>0 + 每手一次 + 双牌齐 + isPremiumHand');
ok(/premiumFXHand = handNo;\s*\n\s*playPremiumFX\(myCardEls\);/.test(html),
  '③ 触发后立即记录本手号（挡住 renderSeat 高频重放）');
ok(/if \(!el \|\| !el\.classList \|\| typeof el\.classList\.add !== 'function'\) return;/.test(html) &&
  /setTimeout\(function \(\) \{ clear\(\); \}, 1100\);/.test(html),
  '③ playPremiumFX 防御：无头桩无 classList 直接跳过；1100ms 兜底摘类（0.8s+0.1s 错峰留余量）');

/* ---------- 汇总 ---------- */
console.log('--- 优质起手牌特效测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
if (fail) process.exit(1);
