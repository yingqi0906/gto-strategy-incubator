/* 摊牌日志一致性校验：对 dump 中每条"赢得"行，用该手 board 与玩家手牌独立验算牌型与赢家 */
'use strict';
const fs = require('fs');
const C = require('./core.js');

const dumpFile = process.argv[2];
if (!dumpFile) { console.log('用法: node verify-showdown.js <dump文件>（先用 DUMP_ALL=xx.txt node harness.js 400 生成）'); process.exit(0); }
const lines = fs.readFileSync(dumpFile, 'utf8').split('\n');
const hands = []; let cur = null;
for (const l of lines) {
  const m = l.match(/^===== 第 (\d+) 局 =====$/);
  if (m) { if (cur) hands.push(cur); cur = { no: +m[1], lines: [] }; }
  else if (cur) cur.lines.push(l);
}
if (cur) hands.push(cur);

/* "10♥ A♠ K♦" -> 内部牌对象 */
function parseCards(s) {
  return (s.match(/(10|[A2-9JQK])[♠♥♦♣]/g) || []).map(function (t) {
    const rank = t.slice(0, -1);
    const r = rank === 'A' ? 14 : rank === 'K' ? 13 : rank === 'Q' ? 12 : rank === 'J' ? 11 : +rank;
    const su = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 }[t[t.length - 1]];
    return { r: r, s: su, id: r * 4 + su };
  });
}

let totalWin = 0, badName = [], badWinner = [], noHole = 0;
for (const h of hands) {
  // 本手公牌：取最后一条街行
  let board = [];
  for (const l of h.lines) {
    const m = l.match(/^--- (翻牌|转牌|河牌) --- (.+)$/);
    if (m) board = parseCards(m[2]);
  }
  // 各玩家手牌：①行动行"名字·位置·手牌1手牌2：" ②AI 展示行"名字·位置 手牌：手牌1 手牌2"
  const CARD = '(?:10|[A2-9JQK])[♠♥♦♣]';
  const reAct = new RegExp('^(.+?)·[^·]+·(' + CARD + ')\\s?(' + CARD + ')：');
  const reShow = new RegExp('^(.+?)·[^·]+ 手牌：(' + CARD + ') (' + CARD + ')$');
  const holes = {};
  for (const l of h.lines) {
    let m = l.match(reAct);
    if (m) { holes[m[1]] = parseCards(m[2] + m[3]); continue; }
    m = l.match(reShow);
    if (m) holes[m[1]] = parseCards(m[2] + ' ' + m[3]);
  }
  for (const l of h.lines) {
    const m = l.match(/^(主池|边池\d?|未遇注|底池)?\s*(.+?) 赢得 ([\d.]+)（(.+?)）$/);
    if (!m) continue;
    totalWin++;
    const winners = m[2].split('、');
    const claimed = m[4];
    // 验算：赢家集合中最高牌型的名称应与行内一致
    let bestName = null, bestScore = null;
    let allKnown = winners.length > 0;
    for (const wFull of winners) {
      const key = Object.keys(holes).find(function (k) { return wFull === k || wFull.startsWith(k + '·'); });
      const hole = key ? holes[key] : null;
      if (!hole || board.length < 5) { allKnown = false; break; }
      const b = C.best7(hole.concat(board));
      if (!bestScore || C.cmpScore(b.score, bestScore) > 0) { bestScore = b.score; bestName = C.handName(b.score); }
    }
    if (!allKnown) { noHole++; continue; }
    if (bestName !== claimed) {
      badName.push({ hand: h.no, line: l, expect: bestName, holes: winners.map(w => w + '=' + holes[w].map(C.cardText).join('')) });
    }
  }
}
console.log('摊牌行总数:', totalWin, ' 手牌缺失:', noHole, ' 牌型标注错误:', badName.length);
badName.slice(0, 6).forEach(function (b) {
  console.log('--- 第' + b.hand + '局');
  console.log('  行:', b.line);
  console.log('  期望:', b.expect);
  console.log('  手牌:', b.holes.join(' | '));
});
process.exit(0);
