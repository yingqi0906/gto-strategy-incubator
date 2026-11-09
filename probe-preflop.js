/* 纯翻前蒙特卡洛：6 个 AI 全用新策略，统计翻前结局 */
const C = require('./core.js');
const N = parseInt(process.argv[2] || '2000', 10);

const deck0 = [];
for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck0.push({ r: r, s: s });
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

let foldwin = 0, seesFlop = 0, threeBetPots = 0, fourBetPots = 0, raiseCnt = 0, callCnt = 0, foldCnt = 0, checkCnt = 0;
let openedCnt = 0, openedSeesFlop = 0, bbFacedOpen = 0, bbDefended = 0, sbFacedOpen = 0, sbDefended = 0;
const bbDbg = [];
const sizeHist = {};

for (let hand = 0; hand < N; hand++) {
  const deck = shuffle(deck0.slice());
  const hole = [];
  for (let i = 0; i < 6; i++) hole.push([deck.pop(), deck.pop()]);
  const buttonIdx = Math.floor(Math.random() * 6);
  const bb = 1;
  let currentBet = bb, lastRaiseSize = bb, lastRaiserIdx = (buttonIdx + 2) % 6;
  const inHand = [true, true, true, true, true, true];
  const acted = [false, false, false, false, false, false];
  const bet = [0, 0, 0, 0, 0, 0];
  bet[(buttonIdx + 1) % 6] = 0.5; bet[(buttonIdx + 2) % 6] = 1;
  let pot = 1.5;
  let any3bet = false, any4bet = false;
  let openHappened = false, bbFaced = false, bbCont = false, sbFaced = false, sbCont = false;
  let pf = { raises: 0, opener: null, threeBettor: null, lastRaiser: null, lastSize: 0, callers: 0, firstCaller: null, limper: null };
  const PN = { 0: 'BTN', 1: 'SB', 2: 'BB', 3: 'UTG', 4: 'HJ', 5: 'CO' };
  const posNameOf = (p) => PN[(p - buttonIdx + 6) % 6];
  let cursor = (buttonIdx + 3) % 6; // UTG
  let guard = 0;
  while (guard++ < 60) {
    let idx = -1;
    for (let i = 0; i < 6; i++) {
      const k = (cursor + i) % 6;
      if (inHand[k] && !acted[k]) { idx = k; break; }
    }
    if (idx === -1) break;
    cursor = idx;
    const alive = inHand.filter(Boolean).length;
    if (alive <= 1) break;
    const p = idx;
    const posIdx = (p - buttonIdx + 6) % 6;
    const toCall = Math.min(currentBet - bet[p], 100);
    if (currentBet > bb && posIdx === 2 && !bbFaced) { bbFaced = true; bbFacedOpen++; }
    if (currentBet > bb && posIdx === 1 && !sbFaced) { sbFaced = true; sbFacedOpen++; }
    const a = C.aiDecide({
      hole: hole[p], community: [], nOpp: alive - 1,
      toCall: toCall, pot: pot + 0, chips: 100 - bet[p],
      bb: bb, currentBet: currentBet, posIdx: posIdx,
      posName: posNameOf(p), pf: pf, bet: bet[p],
      openerPos: (lastRaiserIdx - buttonIdx + 6) % 6
    });
    if (posIdx === 2 && bbFaced && a.type !== 'fold') bbCont = true;
    if (posIdx === 2 && currentBet > bb && pf.raises === 1) bbDbg.push({ op: (lastRaiserIdx - buttonIdx + 6) % 6, t: a.type });
    if (posIdx === 1 && sbFaced && a.type !== 'fold') sbCont = true;
    acted[p] = true;
    if (a.type === 'fold') { inHand[p] = false; foldCnt++; }
    else if (a.type === 'check') checkCnt++;
    else if (a.type === 'call') {
      bet[p] = currentBet; pot += toCall; callCnt++;
      if (pf.raises === 0) pf.limper = posNameOf(p);
      else { pf.callers++; if (!pf.firstCaller) pf.firstCaller = posNameOf(p); }
    }
    else if (a.type === 'raise') {
      const to = Math.max(a.to, currentBet + lastRaiseSize);
      pot += to - bet[p]; bet[p] = to;
      if (to > currentBet) {
        if (currentBet > bb * 4.5) any4bet = true;
        else if (currentBet > bb) any3bet = true;
        else openHappened = true;
        lastRaiseSize = to - currentBet; currentBet = to; lastRaiserIdx = p;
        pf.raises++; pf.callers = 0; pf.firstCaller = null;
        if (pf.raises === 1) pf.opener = posNameOf(p);
        if (pf.raises === 2) pf.threeBettor = posNameOf(p);
        pf.lastRaiser = posNameOf(p);
        pf.lastSize = to / bb;
        for (let q = 0; q < 6; q++) if (q !== p && inHand[q]) acted[q] = false;
        raiseCnt++;
        const bbs = to / bb;
        const bucket = bbs <= 2.4 ? '2-2.4' : bbs <= 3.2 ? '2.5-3.2' : bbs <= 4.5 ? '3.3-4.5' : bbs <= 9 ? '5-9' : '9+';
        sizeHist[bucket] = (sizeHist[bucket] || 0) + 1;
      }
    }
  }
  if (inHand.filter(Boolean).length <= 1) foldwin++;
  else {
    seesFlop++; if (any3bet) threeBetPots++; if (any4bet) fourBetPots++;
    if (openHappened) openedSeesFlop++;
  }
  if (openHappened) openedCnt++;
  if (bbFaced && bbCont) bbDefended++;
  if (sbFaced && sbCont) sbDefended++;
}

console.log('手数:', N);
console.log('翻前全弃牌:', (100 * foldwin / N).toFixed(1) + '%', '| 见翻牌:', (100 * seesFlop / N).toFixed(1) + '%');
console.log('有开池的手:', (100 * openedCnt / N).toFixed(1) + '%', '| 有开池且见翻牌:', (100 * openedSeesFlop / Math.max(1, openedCnt)).toFixed(1) + '%');
console.log('BB 面对开池', bbFacedOpen, '次, 防守率:', (100 * bbDefended / Math.max(1, bbFacedOpen)).toFixed(1) + '%');
const byOp = {};
for (const d of bbDbg) { const k = 'op' + d.op; byOp[k] = byOp[k] || { n: 0, fold: 0, call: 0, raise: 0 }; byOp[k].n++; byOp[k][d.t === 'fold' ? 'fold' : d.t === 'call' ? 'call' : 'raise']++; }
for (const k of Object.keys(byOp)) console.log('  ' + k, JSON.stringify(byOp[k]));
console.log('SB 面对开池', sbFacedOpen, '次, 防守率:', (100 * sbDefended / Math.max(1, sbFacedOpen)).toFixed(1) + '%');
console.log('含3bet的池:', (100 * threeBetPots / N).toFixed(1) + '%', '| 含4bet:', (100 * fourBetPots / N).toFixed(1) + '%');
console.log('动作: 加注' + raiseCnt + ' 跟注' + callCnt + ' 弃牌' + foldCnt + ' 过牌' + checkCnt);
console.log('加注尺度分布(BB):', JSON.stringify(sizeHist));
