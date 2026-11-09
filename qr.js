/* qr.js — 极简二维码生成器（零依赖）
   字节模式（UTF-8），版本 1-6 自动选择，纠错级 M，固定掩码 0。
   Node:  module.exports = { encode }
   浏览器: window.QR = { encode, draw } */
(function (global) {
  'use strict';

  /* ---------- GF(256) 域运算 ---------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

  /* 版本参数（纠错M）：总码字 / 数据码字 / 每块纠错码字 / 块数 */
  var SPEC = {
    1: { total: 26, data: 16, ec: 10, blocks: 1 },
    2: { total: 44, data: 28, ec: 16, blocks: 1 },
    3: { total: 70, data: 44, ec: 26, blocks: 1 },
    4: { total: 100, data: 64, ec: 18, blocks: 2 },
    5: { total: 134, data: 86, ec: 24, blocks: 2 },
    6: { total: 172, data: 108, ec: 16, blocks: 4 }
  };
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

  function toUtf8(s) {
    if (typeof TextEncoder !== 'undefined') {
      return Array.prototype.slice.call(new TextEncoder().encode(s));
    }
    var out = unescape(encodeURIComponent(s)), r = [];
    for (var i = 0; i < out.length; i++) r.push(out.charCodeAt(i) & 0xFF);
    return r;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 6; v++) {
      if (4 + 8 + byteLen * 8 <= SPEC[v].data * 8) return v;
    }
    throw new Error('QR: 内容过长（最多约100字节）');
  }

  /* ---------- 里德-所罗门纠错 ---------- */
  function rsGenPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var a = EXP[i], ng = new Array(g.length + 1), k;
      for (k = 0; k < ng.length; k++) ng[k] = 0;
      for (k = 0; k < g.length; k++) { ng[k] ^= gmul(a, g[k]); ng[k + 1] ^= g[k]; }
      g = ng;
    }
    return g; // 低->高
  }
  function rsEc(data, ec) {
    var gen = rsGenPoly(ec), genHL = [], i;
    for (i = gen.length - 1; i >= 0; i--) genHL.push(gen[i]);
    var res = data.concat(new Array(ec));
    for (i = 0; i < ec; i++) res[data.length + i] = 0;
    for (i = 0; i < data.length; i++) {
      var f = res[i];
      if (f) for (var j = 0; j < genHL.length; j++) res[i + j] ^= gmul(genHL[j], f);
    }
    return res.slice(data.length);
  }

  /* ---------- 码字组装（字节模式 v1-9：长度8bit） ---------- */
  function buildDataCodewords(bytes, v) {
    var bits = [];
    function push(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    push(4, 4);
    push(bytes.length, 8);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);
    bits.push(0, 0, 0, 0); // 终止符（数据满时截断）
    while (bits.length % 8 !== 0) bits.push(0);
    var cw = [];
    for (var b = 0; b + 8 <= bits.length; b += 8) {
      var val2 = 0;
      for (var k = 0; k < 8; k++) val2 = (val2 << 1) | bits[b + k];
      cw.push(val2);
    }
    var pads = [0xEC, 0x11], pi = 0;
    while (cw.length < SPEC[v].data) cw.push(pads[pi++ % 2]);
    return cw;
  }

  function makeCodewords(bytes, v) {
    var spec = SPEC[v], cw = buildDataCodewords(bytes, v);
    if (spec.blocks === 1) return cw.concat(rsEc(cw, spec.ec));
    var per = spec.data / spec.blocks, blocks = [], ecs = [];
    for (var b = 0; b < spec.blocks; b++) {
      var blk = cw.slice(b * per, (b + 1) * per);
      blocks.push(blk);
      ecs.push(rsEc(blk, spec.ec));
    }
    var out = [], i, j;
    for (i = 0; i < per; i++) for (j = 0; j < spec.blocks; j++) out.push(blocks[j][i]);
    for (i = 0; i < spec.ec; i++) for (j = 0; j < spec.blocks; j++) out.push(ecs[j][i]);
    return out;
  }

  /* ---------- 格式信息（纠错M=00，掩码0） ---------- */
  function formatBits() {
    var data5 = (0 << 3) | 0; // ECC M + mask 0
    var d = data5 << 10, i;
    for (i = 4; i >= 0; i--) if (d & (1 << (i + 10))) d ^= 0x537 << i;
    var ref = ((data5 << 10) | d) ^ 0x5412;
    var bits = new Array(15);
    for (i = 0; i < 15; i++) bits[i] = (ref >> i) & 1; // bits[0]=LSB
    return bits;
  }

  /* ---------- 矩阵构建 ---------- */
  function encode(text) {
    var bytes = toUtf8(String(text));
    var v = pickVersion(bytes.length);
    var size = 17 + 4 * v;
    var m = [], resv = [], r, c;
    for (r = 0; r < size; r++) { m.push(new Array(size).fill(false)); resv.push(new Array(size).fill(false)); }
    function setF(row, col, dark) {
      if (row < 0 || row >= size || col < 0 || col >= size) return;
      m[row][col] = !!dark; resv[row][col] = true;
    }

    /* 定位图形 + 分隔符 */
    function finder(row, col) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var rr = row + dr, cc = col + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setF(rr, cc, dark);
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    /* 校正图形（跳过与定位图形重叠的） */
    var centers = ALIGN[v], ai, aj;
    for (ai = 0; ai < centers.length; ai++) for (aj = 0; aj < centers.length; aj++) {
      var cr = centers[ai], cc2 = centers[aj];
      if (resv[cr][cc2]) continue;
      for (var dr2 = -2; dr2 <= 2; dr2++) for (var dc2 = -2; dc2 <= 2; dc2++) {
        setF(cr + dr2, cc2 + dc2, Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1);
      }
    }

    /* 时序图形 */
    for (var t = 8; t < size - 8; t++) {
      if (!resv[6][t]) setF(6, t, t % 2 === 0);
      if (!resv[t][6]) setF(t, 6, t % 2 === 0);
    }

    /* 格式信息（两份）+ 暗模块 */
    var fb = formatBits(), i;
    for (i = 0; i <= 5; i++) setF(i, 8, fb[i]);
    setF(7, 8, fb[6]); setF(8, 8, fb[7]); setF(8, 7, fb[8]);
    for (i = 9; i < 15; i++) setF(8, 14 - i, fb[i]);
    for (i = 0; i < 8; i++) setF(8, size - 1 - i, fb[i]);
    for (i = 8; i < 15; i++) setF(size - 15 + i, 8, fb[i]);
    setF(size - 8, 8, true);

    /* 数据码字按之字形放置 */
    var cw = makeCodewords(bytes, v), bi = 0;
    function nextBit() {
      if (bi >= cw.length * 8) return 0;
      var bit = (cw[bi >> 3] >> (7 - (bi & 7))) & 1;
      bi++;
      return bit;
    }
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var col = right - j;
          var upward = ((right + 1) & 2) === 0;
          var row = upward ? size - 1 - vert : vert;
          if (!resv[row][col]) m[row][col] = !!nextBit();
        }
      }
    }

    /* 掩码0：(row+col)%2==0 取反（仅数据模块） */
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) {
      if (!resv[r][c] && (r + c) % 2 === 0) m[r][c] = !m[r][c];
    }
    return m;
  }

  /* ---------- 浏览器绘制 ---------- */
  function draw(canvas, text, px) {
    var mat = encode(text), n = mat.length, quiet = 4, total = n + quiet * 2;
    px = px || 200;
    canvas.width = canvas.height = px;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#111111';
    var scale = px / total;
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (mat[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale + 0.6, scale + 0.6);
    }
  }

  var QR = { encode: encode, draw: draw };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  global.QR = QR;
})(typeof window !== 'undefined' ? window : globalThis);
