/* test-qr.js — 二维码验证第 1 步：生成我的矩阵写入 /tmp/qr-mine.json
   （第 2 步由 verify-qr.py 与 Python qrcode 库比对：字节模式、纠错M、最小版本、掩码0） */
'use strict';
const fs = require('fs');
const path = require('path');
const QR = require('./qr.js');

const OUT = path.join(__dirname, 'qr-mine.json');

const cases = [
  'http://192.168.0.10:8787/?room=12345',
  'http://192.168.100.100:8787',
  'A',
  'HELLO-WORLD-0123456789',
  'http://10.255.254.1:8787/?room=00000&x=1',
  'http://172.16.5.43:8787/?room=98765'
];

const out = cases.map(function (text) {
  const m = QR.encode(text);
  return { text: text, size: m.length, rows: m.map(function (r) { return r.map(function (b) { return b ? 1 : 0; }).join(''); }) };
});
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('已生成 ' + out.length + ' 个矩阵 → qr-mine.json（运行 python verify-qr.py 比对）');
