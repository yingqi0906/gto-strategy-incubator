/* WPT 新版式几何探针：
   - iframe 精确控制视口（无头 Edge --window-size 有最小宽限制）
   - 补丁副本：env(safe-area-inset-*) 替换为固定值；禁 Worker 计时器（virtual-time 可快进牌局）
   - 开局跑牌，轮到玩家时采样：牌桌/座位/按钮浮层几何 + 截图
   用法: node probe-layout.js <W> <H> [SAFE_TOP] */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const W = parseInt(process.argv[2] || '393', 10);
const H = parseInt(process.argv[3] || '852', 10);
const SAFE_TOP = parseInt(process.env.SAFE_TOP || '59', 10);
const SAFE_BOT = parseInt(process.env.SAFE_BOT === undefined ? '34' : process.env.SAFE_BOT, 10);
const SHOT = process.env.SHOT || '';
const OPEN = process.env.OPEN === '1';
const SEATS = parseInt(process.env.SEATS || '0', 10);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!fs.existsSync(EDGE)) { console.error('Edge 不存在'); process.exit(2); }

let html = fs.readFileSync(process.env.SRC || path.join(__dirname, 'gto策略培养皿.html'), 'utf8');
html = html.replace(/env\(safe-area-inset-top,\s*0px\)/g, SAFE_TOP + 'px');
html = html.replace(/env\(safe-area-inset-bottom,\s*0px\)/g, SAFE_BOT + 'px');
html = html.replace('hardWorker = new Worker(', 'if (1) throw 0; hardWorker = new Worker(');
if (SEATS) html = html.replace('const SEAT_SINGLE = 6,', 'const SEAT_SINGLE = ' + SEATS + ',');
fs.writeFileSync(path.join(__dirname, 'tmp-wpt-target.html'), html);

const driver = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>body{margin:0;background:#222;display:flex;align-items:flex-start;justify-content:center;padding:6px}
iframe{border:1px solid #666;display:block}
#safe{position:absolute;left:0;right:0;top:0;height:${SAFE_TOP}px;background:rgba(255,80,80,.15);
  border-bottom:2px dashed rgba(255,60,60,.8);z-index:9;pointer-events:none}</style></head>
<body><div id="safe"></div><iframe id="f" width="${W}" height="${H}" src="tmp-wpt-target.html"></iframe>
<script>
var f = document.getElementById('f');
f.addEventListener('load', function () {
  setTimeout(function () {
    try {
      var d = f.contentDocument;
      var inp = d.getElementById('nick-input');
      if (inp) inp.value = '探针';
      d.getElementById('btn-start').click();
    } catch (e) { document.title = 'ERR:' + e.message; }
  }, 500);
  /* 多点采样：0.8s 间隔 × 20 次（virtual-time 快进整手牌），抓"轮到玩家且行动条展开"的最坏几何 */
  window.__samples = [];
  var iv = setInterval(function () {
    try {
      var d = f.contentDocument;
      if (${OPEN ? 'true' : 'false'}) {
        var fa = d.getElementById('free-arrow');
        if (fa && d.body.className.indexOf('vopen') < 0 && fa.style.display !== 'none') fa.click();
      }
      var bar = d.getElementById('action-bar');
      var R = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
        return { t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), l: +r.left.toFixed(1), rt: +r.right.toFixed(1) }; };
      var tbl = d.getElementById('table');
      var seats = [].slice.call(d.querySelectorAll('.seat'));
      var mnT = 1e9, mxB = -1, hero = null;
      var seatRects = [];
      seats.forEach(function (s, i) {
        var r = s.getBoundingClientRect();
        if (s.className.indexOf('hero') >= 0) hero = R(s);
        if (r.top < mnT) mnT = r.top; if (r.bottom > mxB) mxB = r.bottom;
        seatRects.push(i + ':' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
          Math.round(r.width) + '×' + Math.round(r.height) +
          (/hero/.test(s.className) ? '(hero)' : ''));
      });
      var stack = d.getElementById('raise-stack');
      var board = d.getElementById('board');
      /* 底排座位 / 主角 与按钮浮层的重叠检测 */
      var btns = [];
      ['btn-fold', 'btn-check', 'free-arrow', 'raise-stack', 'vslider'].forEach(function (id) {
        var e = d.getElementById(id);
        if (!e) return;
        var st = f.contentWindow.getComputedStyle(e);
        if (st.display === 'none' || st.visibility === 'hidden') return;
        var r = e.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        btns.push({ id: id, r: r });
      });
      var ovl = [];
      /* 手牌出屏：任何座位的手牌必须完整落在视口内（2026-10-15 真机报障：
         外扩坐标把两侧座位的手牌推到屏幕外） */
      cards.forEach(function (h, hi) {
        var hr = h.getBoundingClientRect();
        if (hr.width < 1 || hr.height < 1) return;
        if (hr.left < -1 || hr.right > f.contentWindow.innerWidth + 1)
          ovl.push({ seat: '手牌' + hi + '出屏', btn: 'viewport', area: Math.round((hr.left < 0 ? -hr.left : hr.right - f.contentWindow.innerWidth) * hr.height) });
      });
      /* 下注筹码标识 vs 手牌/名牌：用户报障"筹码遮挡手牌"（2026-10-15） */
      var chips = [].slice.call(d.querySelectorAll('.bet-chip'));
      var cards = [].slice.call(d.querySelectorAll('.seat .hole-cards'));
      chips.forEach(function (c, ci) {
        var cr = c.getBoundingClientRect();
        if (cr.width < 1 || cr.height < 1) return;
        cards.forEach(function (h, hi) {
          var hr = h.getBoundingClientRect();
          if (hr.width < 1 || hr.height < 1) return;
          var ox = Math.min(cr.right, hr.right) - Math.max(cr.left, hr.left);
          var oy = Math.min(cr.bottom, hr.bottom) - Math.max(cr.top, hr.top);
          if (ox > 2 && oy > 2) ovl.push({ seat: 'chip' + ci + '×手牌' + hi, btn: 'bet-chip', area: Math.round(ox * oy) });
        });
      });
      seats.forEach(function (s, si) {
        var sr = s.getBoundingClientRect();
        btns.forEach(function (b) {
          var ox = Math.min(sr.right, b.r.right) - Math.max(sr.left, b.r.left);
          var oy = Math.min(sr.bottom, b.r.bottom) - Math.max(sr.top, b.r.top);
          if (ox > 2 && oy > 2) ovl.push({ seat: si, btn: b.id, area: Math.round(ox * oy) });
        });
        /* 座位与座位：手牌/名牌互相压盖（面积 > 900px² 才算真压） */
        for (var j = si + 1; j < seats.length; j++) {
          var r2 = seats[j].getBoundingClientRect();
          var ox2 = Math.min(sr.right, r2.right) - Math.max(sr.left, r2.left);
          var oy2 = Math.min(sr.bottom, r2.bottom) - Math.max(sr.top, r2.top);
          if (ox2 > 2 && oy2 > 2 && ox2 * oy2 > 4000)
            ovl.push({ seat: si, btn: '座位' + j, area: Math.round(ox2 * oy2) });
        }
      });
      var out = {
        acting: bar && bar.className.indexOf('disabled') < 0,
        abarH: bar ? +bar.getBoundingClientRect().height.toFixed(1) : -1,
        table: R(tbl), seatMinTop: +mnT.toFixed(1), seatMaxBot: +mxB.toFixed(1), hero: hero,
        stackTop: stack ? +stack.getBoundingClientRect().top.toFixed(1) : -1,
        btnTop: btns.length ? Math.min.apply(null, btns.map(function (b) { return b.r.top; })) : -1,
        btns: btns.map(function (b) { return b.id + ':' + Math.round(b.r.left) + ',' + Math.round(b.r.top) + ' ' + Math.round(b.r.width) + '×' + Math.round(b.r.height); }),
        seatRects: seatRects,
        ovl: ovl,
        board: R(board), vw: f.contentWindow.innerWidth, vh: f.contentWindow.innerHeight
      };
      window.__samples.push(out);
    } catch (e) {}
  }, 800);
  setTimeout(function () {
    clearInterval(iv);
    /* 判定：所有样本中 顶部座位不进安全区、底部座位不压按钮浮层 */
    var bad = [], worstOvl = 0, ovlSeen = {};
    window.__samples.forEach(function (s, i) {
      if (s.table && s.table.t < ${SAFE_TOP} - 55) bad.push('样本' + i + ' 牌桌顶=' + s.table.t);
      if (s.seatMinTop < ${SAFE_TOP}) bad.push('样本' + i + ' 座位顶=' + s.seatMinTop);
      if (s.ovl && s.ovl.length) {
        s.ovl.forEach(function (o) {
          ovlSeen['座位' + o.seat + '×' + o.btn] = 1;
          if (o.area > worstOvl) worstOvl = o.area;
        });
        bad.push('样本' + i + ' 座位压按钮: ' + s.ovl.map(function (o) { return '座位' + o.seat + '×' + o.btn + '(面积' + o.area + ')'; }).join(', '));
      }
    });
    window.__ovlSeen = Object.keys(ovlSeen); window.__worstOvl = worstOvl;
    document.title = 'S=' + JSON.stringify({ samples: window.__samples.length, bad: bad, last: window.__samples[window.__samples.length - 1] });
  }, 17000);
});
</script></body></html>`;
fs.writeFileSync(path.join(__dirname, 'tmp-wpt-driver.html'), driver);

const dom = execFileSync(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--virtual-time-budget=19000', '--window-size=' + (W + 40) + ',' + (H + 40),
  ...(SHOT ? ['--screenshot=' + SHOT] : []),
  '--dump-dom', 'file:///' + path.join(__dirname, 'tmp-wpt-driver.html').replace(/\\/g, '/')
], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });

const m = dom.match(/<title>([\s\S]*?)<\/title>/);
const t = m ? m[1].trim() : '(no title)';
if (t.startsWith('S=')) {
  const o = JSON.parse(t.slice(2));
  console.log('视口 ' + W + '×' + H + '  安全区 上' + SAFE_TOP + '/下' + SAFE_BOT + '  采样 ' + o.samples + ' 次');
  if (o.bad && o.bad.length) { console.log('✗ 违规:'); o.bad.slice(0, 6).forEach(b => console.log('   ' + b)); }
  else console.log('✓ 全部样本：座位顶 ≥ 安全区、几何无违规');
  const L = o.last || {};
  if (L.table) {
    console.log('末次采样: 牌桌 ' + (L.table.rt - L.table.l).toFixed(0) + '×' + (L.table.b - L.table.t).toFixed(0) +
      ' @top ' + L.table.t + '  座位Y ' + L.seatMinTop + '~' + L.seatMaxBot +
      '  浮层高 ' + L.abarH + '（展开=' + L.acting + '）');
    if (L.hero) console.log('  主角座位 Y ' + L.hero.t + '~' + L.hero.b + ' X ' + L.hero.l + '~' + L.hero.rt);
    if (L.board) console.log('  公共牌行 Y ' + L.board.t + '~' + L.board.b);
    if (L.btnTop >= 0) console.log('  按钮浮层最高点 Y ' + L.btnTop);
    if (L.btns) console.log('  按钮盒: ' + L.btns.join(' | '));
    if (L.seatRects) console.log('  座位盒: ' + L.seatRects.join(' | '));
  }
} else {
  console.log('探针未产出：' + t.slice(0, 120));
}
