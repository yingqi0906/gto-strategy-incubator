/* 校验行动顺序（标准规则）
   6max：翻前首动 = 枪口（大盲下一位）；翻后首动 = 小盲起顺时针第一个未弃牌位
   单挑（2 人）：按钮位即小盲 → 翻前首动 = 按钮·小盲；翻后首动 = 大盲（按钮位最后行动）
   用法：node check-order.js <全量日志文件>（退出码 0 = 全部符合，1 = 存在不符合项）
   也可被测试 require：const { checkOrder } = require('./check-order.js') */
'use strict';
const fs = require('fs');

/* 从「名字·位置[手牌]：」这类行动行中取出位置名（位置后可能紧跟所显示的手牌） */
function posOf(line) {
  if (line.indexOf('：') < 0 || line.indexOf('·') < 0) return null;
  if (/按钮/.test(line) && /小盲/.test(line)) return '按钮·小盲';
  if (/大盲/.test(line)) return '大盲';
  if (/小盲/.test(line)) return '小盲';
  if (/枪口/.test(line)) return '枪口';
  if (/中位/.test(line)) return '中位';
  if (/关煞/.test(line)) return '关煞';
  if (/按钮/.test(line)) return '按钮';
  return null;
}
function isFoldLine(line) {
  const t = line.trim();
  return t === '弃牌' || (t.indexOf('弃牌') === 0 && t.indexOf('本次选择') >= 0 && t.indexOf('本次未选择') < 0);
}

/* 返回 { hands, checkedPre, checkedPost, bad } */
function checkOrder(text) {
  const hands = String(text || '').split(/^===== 第 \d+ 局 =====$/m).slice(1);
  let checkedPre = 0, checkedPost = 0;
  const bad = [];
  for (const h of hands) {
    const lines = h.split(/\r?\n/);
    const isHU = h.indexOf('按钮·小盲') >= 0;
    const preIdx = lines.findIndex(l => l.indexOf('--- 翻牌前 ---') >= 0);
    const flopIdx = lines.findIndex(l => l.indexOf('--- 翻牌 ---') >= 0);
    if (preIdx < 0) continue;
    const pre = flopIdx > preIdx ? lines.slice(preIdx + 1, flopIdx) : lines.slice(preIdx + 1);
    const posAct = []; const folded = new Set(); let cur = null;
    for (const l of pre) {
      const p = posOf(l);
      if (p) { cur = p; if (!posAct.includes(p)) posAct.push(p); continue; }
      if (cur && isFoldLine(l)) folded.add(cur);
    }
    const firstPre = posAct[0];
    if (!firstPre) continue; // 日志不完整（该手刚开始/被截断，无任何行动记录）→ 跳过
    const wantPre = isHU ? '按钮·小盲' : '枪口';
    if (firstPre !== wantPre) bad.push(['翻前首动', firstPre, '应为 ' + wantPre]);
    else checkedPre++;

    if (flopIdx > 0) {
      const post = lines.slice(flopIdx + 1);
      let firstPost = null;
      for (const l of post) { const p = posOf(l); if (p) { firstPost = p; break; } }
      if (firstPost) {
        const order = isHU ? ['大盲', '按钮·小盲'] : ['小盲', '大盲', '枪口', '中位', '关煞', '按钮'];
        const want = order.find(p => posAct.includes(p) && !folded.has(p)) || order[0];
        if (firstPost !== want) bad.push(['翻后首动', firstPost, '应为 ' + want]);
        else checkedPost++;
      }
    }
  }
  return { hands: hands.length, checkedPre: checkedPre, checkedPost: checkedPost, bad: bad };
}

module.exports = { checkOrder: checkOrder, posOf: posOf };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log('用法: node check-order.js <全量日志文件>'); process.exit(0); }
  const r = checkOrder(fs.readFileSync(file, 'utf8'));
  console.log('手数:', r.hands, ' 翻前首动校验:', r.checkedPre, ' 翻后首动校验:', r.checkedPost, ' 错误:', r.bad.length);
  r.bad.slice(0, 10).forEach(b => console.log('错:', b.join(' | ')));
  process.exit(r.bad.length ? 1 : 0);
}
