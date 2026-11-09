/* test-mobile-ui.js — 手机端界面优化（2026-10-12 请求 7）回归
   覆盖：
     ① 底部信息条去重：移除 #info-row/#my-cards/#my-status（与侧栏 #hand-hint、座位名字牌重复）
     ② 座位外移：手机端（≤820px）启用外扩坐标 SEAT_POS_6_OUT / SEAT_POS_9_OUT，
        resize 时 layoutSeats() 重贴坐标（不重建 DOM）
     ③ 下注筹码精简：只显示 1 枚 20px 筹码（面值近似），去掉"下注 xx"文字胶囊，
        .bet-chip 去掉胶囊底/边框，减少互相遮挡
   用法：node test-mobile-ui.js                                            */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; failures.push(msg + (extra ? '   [' + extra + ']' : '')); }
}

const html = fs.readFileSync(path.join(__dirname, 'gto策略培养皿.html'), 'utf8');

/* ---------- ① 底部信息条去重 ---------- */
ok(!html.includes('id="info-row"') && !html.includes("id=\"my-cards\"") && !html.includes("id=\"my-status\""),
  '① HTML 已移除 #info-row / #my-cards / #my-status 结构');
ok(!html.includes('#info-row') && !html.includes('#my-cards') && !html.includes('#my-status'),
  '① CSS 中无 #info-row / #my-cards / #my-status 残留选择器');
ok(/function renderMyInfo\(\) \{[\s\S]{0,200}?updateHint\(\);[\s\S]{0,20}\}/.test(html),
  '① renderMyInfo 保留且只负责刷新侧栏起手牌行（updateHint）');
ok(!/renderMyInfo[\s\S]{0,400}?\$\('my-status'\)/.test(html),
  '① renderMyInfo 不再写 #my-status');
/* 行动条其他部分保持完整：三列（弃牌 | 中列跟注+箭头 | 右预设堆）—— 2026-10-14 晚 v2 版式 */
ok(/id="action-bar"/.test(html) && /id="mid-col"/.test(html) && /id="raise-stack"/.test(html) &&
  !html.includes('id="main-buttons"'),
  '① 行动条 = 三列：弃牌 | 中列(跟注+箭头) | 右预设堆（浮动浮层，无包裹面板）');
ok(/id="btn-fold"/.test(html) && /id="btn-check"/.test(html) && /id="btn-raise"/.test(html) && /id="wait-hint"/.test(html),
  '① 弃牌/过牌/加注按钮与等待提示完好');
ok(/id="free-arrow"/.test(html) && /id="vslider-track"/.test(html) &&
  html.indexOf('id="free-arrow"') < html.indexOf('id="btn-check"') &&
  html.indexOf('id="btn-check"') < html.indexOf('id="raise-stack"'),
  '① 三列次序：箭头在中列按钮上方，预设堆在最后（右列）');

/* ---------- ② 座位布局（2026-10-15 v2：两列内收贴桌边，手牌完整在屏内） ---------- */
ok(/const SEAT_POS_6_OUT = \[/.test(html) && /left: '3%', top: '34%'/.test(html) && /left: '97%', top: '34%'/.test(html),
  '② SEAT_POS_6_OUT 手机版坐标存在（左右两列内收 3%/97%，2026-10-15 真机报障外扩裁切手牌后改内收）');
ok(/top: '-2%'/.test(html) && /top: '89%'/.test(html) && !/top: '-4%'/.test(html) && !/top: '104%'/.test(html),
  '② 竖向已收敛：顶部不超 -2%、主角收在 89%（底排 66%，避开行动按钮浮层，2026-10-14 WPT 版式）');
ok(/const SEAT_POS_8 = \[/.test(html) && /left: '50%', top: '-3%'/.test(html) && /left: '101%', top: '44%'/.test(html),
  '② 8 人桌坐标表照抄 WPT 截图（顶中 1 + 左右各 3，主角左下角）');
ok(/const SEAT_POS_8_OUT = \[/.test(html) && (html.match(/left: '3%'/g) || []).length >= 3 && (html.match(/left: '97%'/g) || []).length >= 3,
  '② SEAT_POS_8_OUT 手机版坐标存在（左右各 3 座内收 3%/97%）');
ok(/function compactView\(\)/.test(html) && /matchMedia\('\(max-width: 820px\)'\)/.test(html),
  '② compactView()：≤820px 判定（与布局断点一致）');
ok(/const SEAT_POS_8_LAND = \[/.test(html) && /const SEAT_POS_6_LAND = \[/.test(html) &&
  /landShort\(\) \? SEAT_POS_8_LAND/.test(html) && /landShort\(\) \? SEAT_POS_6_LAND/.test(html),
  '② seatPosTable()：矮横屏用拉开版坐标表（landShort → 6/8 人各有 LAND 表）');
ok(/function layoutSeats\(\)/.test(html) && /layoutSeats\(\); \} catch \(e\)/.test(html),
  '② layoutSeats() 定义并挂到 resize 监听（转屏重贴坐标，不重建 DOM）');
ok(/p\.seatEl\.style\.left = sp\.left;/.test(html) && /p\.betEl\.style\.left = bp\.left;/.test(html),
  '② layoutSeats 同时更新座位与下注筹码位置');
ok(/env\(safe-area-inset-top, 0px\) - 96px\) \* 460 \/ 700/.test(html),
  '② 竖屏牌桌公式余量 96px（浮层按钮不占文档流后重调）：覆盖顶部安全区（灵动岛 59px）+ 座位外扩');

/* ---------- ③ 下注筹码精简 ---------- */
ok(/bet\.innerHTML = chipStackHtml\(p\.bet, 1, 20\) \+ '<span class="amt">' \+ fmtChips\(p\.bet\) \+ '<\/span>';/.test(html),
  '③ 下注 = 1 枚 20px 筹码（面值近似）+ .amt 金额数字');
ok(!html.includes("'<span>下注 '"),
  '③ 不再输出"下注"二字（只留数字）');
ok(/\.bet-chip \.amt \{/.test(html) && /text-shadow: 0 1px 3px rgba\(0,0,0,\.95\)/.test(html),
  '③ .amt 数字样式：白字强投影（绿毡上可读）');
ok(/function chipStackHtml\(amount, cap, px\)/.test(html) && /px = px \|\| 14;/.test(html),
  '③ chipStackHtml 新增 px 尺寸参数（默认 14，存量调用不受影响）');
ok(/chipStackHtml\(roundStartPot, 16\)/.test(html) && /chipStackHtml\(amount, 10\)/.test(html) && /chipStackHtml\(amount, 12\)/.test(html),
  '③ 底池/飞筹动画的存量 chipStackHtml 调用保持原样');
/* .bet-chip 去胶囊化：无底色/边框/内边距，保留绝对定位与投影 */
const betCss = (html.match(/\.bet-chip \{[\s\S]*?\n  \}/) || [''])[0];
ok(betCss.length > 0, '③ .bet-chip 规则存在');
ok(!/background: rgba\(0,0,0,\.72\)/.test(betCss) && !/border: 2px solid #ffd54a/.test(betCss) && !/padding: 4px 16px/.test(betCss),
  '③ .bet-chip 已去掉胶囊底色/金边/内边距');
ok(/position: absolute/.test(betCss) && /transform: translate\(-50%, -50%\)/.test(betCss) && /filter: drop-shadow/.test(betCss),
  '③ .bet-chip 保留居中绝对定位与投影（绿毡上可辨）');
ok(/\.bet-chip \{ font-size: 1[12]px/.test(html) === false,
  '③ 媒体查询中无 .bet-chip 文字样式残留（已无文字）');

/* ---------- ④ 牌背 canvas 尺寸修复（2026-10-13） ---------- */
ok(/const cv = document\.createElement\('canvas'\);[\s\S]{0,400}?cv\.width = W \* 2; cv\.height = H \* 2;[\s\S]{0,60}?ctx\.scale\(2, 2\);/.test(html),
  '④ buildCardBack 显式设置画布尺寸（默认 300×150 会把牌背压扁到卡片左侧 1/3）并 2x 绘制');
ok(/CARD_BACK_URL = cv\.toDataURL\('image\/png'\);/.test(html),
  '④ 牌背仍经 CARD_BACK_URL data URL 下发（不依赖网络图）');

/* ---------- ⑤ 行动条 v2：三列 + 中列双态（2026-10-14 晚，用户反馈 2/3 项） ---------- */
/* 右列预设堆保持 4 档纵向排列（参考截图版式），不再折叠成 2×2 网格 */
ok(/#raise-stack \{[^}]*flex-direction: column/.test(html) &&
  !/#raise-stack \{[^}]*grid-template-columns/.test(html) &&
  !/grid-template-columns: 1fr 1fr[^}]*\}[\s\S]{0,200}#raise-stack \.rbtn \{ height: (30|32|34|37|40)px/.test(html),
  '⑤ 预设堆 4 档纵排（flex column），全部断点无 2×2 网格折叠');
/* 中列双态：默认跟注/过牌；滑条展开（vopen）且所选额可开价 → "加注至 X"，按下提交该加注 */
ok(/function syncMidBtn\(\)/.test(html) && !/id="btn-free"/.test(html) && !/\$\('btn-free'\)/.test(html),
  '⑤ btn-free 已移除，中列按钮双态由 syncMidBtn() 统一渲染');
ok(/\$\('btn-check'\)\.onclick[\s\S]{0,420}bodyClass\('vopen'\) && raiseBounds && freeVal > currentBet \+ 1e-9[\s\S]{0,120}type: 'raise', to: clampToRaise\(freeVal\)/.test(html),
  '⑤ 中列按钮在滑条展开态提交"按滑条金额加注"');
ok(/syncMidBtn\(\);[\s\S]{0,40}\}/.test(html) &&
  /bodyClass\('vopen', false\); \/\/ 提交后收起自由下注滑条[\s\S]{0,80}syncMidBtn\(\)/.test(html),
  '⑤ 提交/等待时收起滑条并还原按钮文案（不残留"加注至 X"）');
/* 外点关闭：文档捕获阶段 pointerdown，点滑条/箭头/中列按钮以外任意区域收起 */
ok(/document\.addEventListener\('pointerdown', function \(e\) \{[\s\S]{0,200}bodyClass\('vopen'\)[\s\S]{0,300}t\.closest\('#vslider'\) \|\| t\.closest\('#free-arrow'\) \|\| t\.closest\('#btn-check'\)[\s\S]{0,160}bodyClass\('vopen', false\);[\s\S]{0,40}syncMidBtn\(\);[\s\S]{0,60}\}, true\);/.test(html),
  '⑤ 捕获阶段外点监听：点滑条以外区域收起滑条、按钮还原为跟注/过牌');
/* 滑条改挂中列（在箭头/按钮上方弹出），不再挂右列预设堆 */
ok(/#mid-col \{[^}]*position: relative/.test(html) && /#vslider \{[^}]*left: 50%; transform: translateX\(-50%\)/.test(html),
  '⑤ 竖向滑条在中列正上方居中弹出（跟随箭头控件）');

/* ---------- ⑥ v2 后续修正（2026-10-15 真机反馈 4 项） ---------- */
ok(/betPcts\.slice\(\)\.reverse\(\)\.forEach/.test(html),
  '⑥ 翻后预设档大额在上（betPcts 逆序插入，与翻前 4bb 在最上同规则）');
ok(/#raise-stack \.rbtn \{ height: 48px/.test(html) && /#raise-stack \.rbtn \{ height: 44px/.test(html),
  '⑥ 预设按钮恢复正常高度（≤480 竖屏 48px、SE 矮屏 44px，不再压扁）');
ok(/function betPosOf\(sp, isHero\)/.test(html) &&
  /const fx = isHero \? 0\.53 : \(compact \? 0\.70 : 0\.62\);/.test(html) &&
  /const fy = isHero \? 0\.48 : fx;/.test(html) &&
  /betPosOf\(seatPosOf\(p\.idx\), p\.idx === MP\.mySeat\)/.test(html),
  '⑥ 主角下注筹码再向右下（fx=0.53 离左列玩家更远、fy=0.48 纵向仍留净空不压大牌）');
ok(/#vslider-track \{[\s\S]*?width: 100%/.test(html) && /#vslider-track::before \{[\s\S]*?width: 12px/.test(html),
  '⑥ 滑条热区=整个面板宽（视觉条 ::before 居中 12px；细条热区在手机上点不到）');
ok(/#vslider-thumb \{[\s\S]*?width: 48px; height: 22px;[\s\S]*?border-radius: 7px/.test(html),
  '⑥ 滑块改为横向长方形（48×22，圆角 7px）——手指更好按住');
ok(/const panel = \$\('vslider'\)[\s\S]*?hit\.addEventListener\('pointerdown'/.test(html) &&
  /hit\.addEventListener\('pointermove'/.test(html),
  '⑥ 点击/拖动热区绑在整个滑条面板（含内边距与金额区），不再只有细轨道');
ok(/#vslider \{[\s\S]*?touch-action: none;/.test(html),
  '⑥ 滑条面板 touch-action:none（拖动不带动页面滚动）');

/* ---------- ⑦ 按钮质感（2026-10-15 按参考稿移植 WPT 四层结构） ---------- */
ok(/\.btn \{[\s\S]*?inset 0 1px 0 rgba\(255,255,255,\.14\)[\s\S]*?0 3px 0 rgba\(0,0,0,\.32\)/.test(html) &&
  /\.btn:active:not\(:disabled\) \{[\s\S]*?transform: translateY\(2px\)/.test(html),
  '⑦ .btn 基类 = 顶棱边 + 底部硬投影 + 按压位移 translateY(2px)（WPT 四层质感）');
ok(/\.btn\.primary \{ background: linear-gradient\(180deg, #2FB979 0%, #1F9D55 45%, #146B3A 100%\); \}/.test(html) &&
  /\.btn\.danger \{ background: linear-gradient\(180deg, #E05A50 0%, #C4453A 45%, #8F2D25 100%\); \}/.test(html),
  '⑦ 语义色改三段渐变（跟注绿 / 弃牌红，色相不变只做明度）');
ok(/#action-bar > #btn-fold \{[\s\S]*?linear-gradient\(180deg, #E05A50/.test(html) &&
  /#mid-col #btn-check \{[\s\S]*?linear-gradient\(180deg, #2FB979/.test(html) &&
  /#mid-col #btn-check\.raise-mode \{[\s\S]*?linear-gradient\(180deg, #55A0DC/.test(html),
  '⑦ 行动条：弃牌红 / 跟注绿渐变，自由下注态切加注蓝（.raise-mode）');
ok(/#raise-stack \.rbtn \{[\s\S]*?linear-gradient\(180deg, #2E4A6B 0%, #223754 45%, #16243A 100%\)/.test(html) &&
  /#raise-stack \.rbtn \.pct \{[\s\S]*?color: #ffd54a/.test(html),
  '⑦ 预设档 = 钢灰三段渐变 + 金色百分比（钢灰=非语义，与语义色按钮区分）');
ok(/function setMidRaiseMode\(on\)/.test(html) &&
  /setMidRaiseMode\(isRaiseMode\)/.test(html) &&
  /setMidRaiseMode\(false\); \/\/ 新回合默认跟注/.test(html),
  '⑦ 中列按钮语义类在同一处渲染（syncMidBtn 切 raise-mode，showActionUI 复位）');

/* ---------- 汇总 ---------- */
console.log('--- 手机端界面优化测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ---');
if (fail) {
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
