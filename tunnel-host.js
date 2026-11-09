/* tunnel-host.js — 一键公网联机：本地服务器 + Cloudflare 隧道 + 二维码
 *
 * 用法：node tunnel-host.js
 *  1. 在本地 8787 端口启动联机服务器（server.js）
 *  2. 用 cloudflared 建立公网隧道（trycloudflare.com 随机域名，免注册）
 *  3. 生成「公网地址.html」二维码页面并自动用浏览器打开，地址同时写入 公网地址.txt
 *  4. Ctrl+C 一次性关闭服务器与隧道
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '8787', 10);
const IS_WIN = process.platform === 'win32';

/* ---------- 定位 cloudflared 可执行文件 ---------- */
const CF_CANDIDATES = [
  path.join(ROOT, 'tools', 'cloudflared.exe'),
  path.join(ROOT, 'tools', 'node_modules', 'agentroam-cloudflared-win32-x64', 'vendor', 'cloudflared-windows-amd64.exe'),
  path.join(ROOT, 'tools', 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe'),
  'cloudflared'
];
function findCloudflared() {
  for (const c of CF_CANDIDATES) {
    try { if (c === 'cloudflared' || fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/* ---------- 二维码页面：生成 公网地址.html 并自动用浏览器打开 ---------- */
function openQRPage(url) {
  const QR = (() => { try { return require('./qr.js'); } catch (e) { return null; } })();
  if (!QR) return false;
  let m = null;
  try { m = QR.encode(url); } catch (e) { return false; }
  if (!m || !m.length) return false;
  // 把矩阵序列化成 0/1 字符串，页面端重建
  const rows = m.map(r => r.map(v => v ? 1 : 0).join(''));
  const html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>德州扑克 · 公网地址</title>\n' +
    '<style>\n' +
    '  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;\n' +
    '         background:#0c1420; color:#e8eef5; font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; gap:22px; padding:24px; }\n' +
    '  h1 { font-size:20px; font-weight:bold; margin:0; color:#ffd54a; }\n' +
    '  #qr { background:#fff; padding:18px; border-radius:14px; box-shadow:0 6px 24px rgba(0,0,0,.45); }\n' +
    '  .url { font-size:17px; color:#7ec8ff; word-break:break-all; text-align:center; max-width:92vw; }\n' +
    '  .tip { font-size:13px; color:#9db2cc; }\n' +
    '  button { font-size:15px; padding:9px 22px; border-radius:10px; border:1px solid #3a5070;\n' +
    '           background:#24344d; color:#e8eef5; cursor:pointer; }\n' +
    '  button:hover { background:#31466a; }\n' +
    '</style>\n</head>\n<body>\n' +
    '<h1>🃏 德州扑克 · 公网联机</h1>\n' +
    '<div id="qr"></div>\n' +
    '<div class="url">' + url + '</div>\n' +
    '<div class="tip">手机扫码或浏览器输入上方地址即可进入牌局</div>\n' +
    '<button onclick="navigator.clipboard&' +
    '&navigator.clipboard.writeText(document.querySelector(\'.url\').textContent).then(function(){this.textContent=\'✓ 已复制\'}.bind(this))">复制地址</button>\n' +
    '<script src="qr.js"></script>\n' +
    '<script>\n' +
    '  var ROWS = ' + JSON.stringify(rows) + ';\n' +
    '  (function(){\n' +
    '    var mod = ROWS.length, quiet = 3, scale = 8;\n' +
    '    var n = (mod + quiet*2) * scale;\n' +
    '    var cv = document.createElement("canvas"); cv.width = n; cv.height = n;\n' +
    '    var ctx = cv.getContext("2d");\n' +
    '    ctx.fillStyle = "#fff"; ctx.fillRect(0,0,n,n);\n' +
    '    ctx.fillStyle = "#000";\n' +
    '    for (var r=0;r<mod;r++) for (var c=0;c<mod;c++)\n' +
    '      if (ROWS[r][c]==="1") ctx.fillRect((c+quiet)*scale,(r+quiet)*scale,scale,scale);\n' +
    '    document.getElementById("qr").appendChild(cv);\n' +
    '  })();\n' +
    '</script>\n</body>\n</html>\n';
  const file = path.join(ROOT, '公网地址.html');
  try {
    fs.writeFileSync(file, html, 'utf8');
  } catch (e) { return false; }
  // Windows 下用默认浏览器打开
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', file], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [file], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {}
  return true;
}

/* ---------- 本机局域网 IP（备用地址） ---------- */
const os = require('os');
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(k => (ifs[k] || []).forEach(it => {
    if (it.family === 'IPv4' && !it.internal) out.push(it.address);
  }));
  return out;
}

/* ---------- 探测本地服务器是否已在监听 ---------- */
function probeServer() {
  return new Promise(resolve => {
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* ---------- 启动本地服务器（可靠版：轮询 HTTP 就绪，进程退出即报错） ---------- */
function startServer() {
  return new Promise(async (resolve, reject) => {
    const already = await probeServer();
    if (already) {
      console.log('   （检测到端口 ' + PORT + ' 已有服务器在运行，直接复用）');
      resolve(null); // null = 复用现有实例，退出时不重复清理
      return;
    }
    const ps = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let errMsg = '';
    ps.stderr.on('data', d => { errMsg += d.toString(); });
    ps.on('exit', code => reject(new Error('本地服务器进程退出（代码 ' + code + '）' + (errMsg ? '：' + errMsg.split('\n')[0] : ''))));
    // 轮询等待 HTTP 就绪（最多 10 秒）
    const t0 = Date.now();
    const poll = async () => {
      if (ps.exitCode !== null) return; // exit 事件已 reject
      if (await probeServer()) { resolve(ps); return; }
      if (Date.now() - t0 > 10000) { reject(new Error('本地服务器 10 秒内未就绪')); return; }
      setTimeout(poll, 400);
    };
    poll();
  });
}

/* ---------- 启动隧道并抓取公网地址 ---------- */
function startTunnel(cfPath) {
  return new Promise((resolve, reject) => {
    const ps = spawn(cfPath, ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    let url = null;
    const scan = d => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !url) { url = m[0]; resolve({ proc: ps, url: url }); }
    };
    ps.stdout.on('data', scan);
    ps.stderr.on('data', scan);
    ps.on('error', reject);
    ps.on('exit', code => { if (!url) reject(new Error('隧道进程已退出（代码 ' + code + '）')); });
    setTimeout(() => { if (!url) reject(new Error('等待隧道地址超时（60 秒）')); }, 60000);
  });
}

/* ---------- 主流程 ---------- */
(async function main() {
  console.log('');
  console.log('========================================');
  console.log('   德州扑克 · 公网联机服务器');
  console.log('========================================');
  console.log('');

  const cfPath = findCloudflared();
  if (!cfPath) {
    console.error('✗ 未找到 cloudflared，请先运行 tools 目录下的安装命令。');
    console.error('  缺少：tools/node_modules/agentroam-cloudflared-win32-x64/vendor/cloudflared-windows-amd64.exe');
    process.exit(1);
  }

  console.log('① 正在启动本地服务器（端口 ' + PORT + '）…');
  let serverProc = null; // null = 复用了已在运行的实例
  try {
    serverProc = await startServer();
    console.log('   ✓ 本地服务器已就绪');
  } catch (e) {
    console.error('   ✗ 本地服务器启动失败：' + e.message);
    console.error('     （若提示端口被占用，请先关闭旧的联机服务器窗口）');
    process.exit(1);
  }

  console.log('② 正在建立公网隧道…');
  let tunnel;
  try {
    tunnel = await startTunnel(cfPath);
    console.log('   ✓ 公网隧道已建立');
  } catch (e) {
    console.error('   ✗ 隧道建立失败：' + e.message);
    try { serverProc.kill(); } catch (err) {}
    process.exit(1);
  }

  const url = tunnel.url;
  try { fs.writeFileSync(path.join(ROOT, '公网地址.txt'), url + '\n', 'utf8'); } catch (e) {}

  console.log('');
  console.log('========================================');
  console.log('  ✅ 现在可以把下面的地址发给朋友了：');
  console.log('');
  console.log('    ' + url);
  console.log('');
  const qrOk = openQRPage(url);
  if (qrOk) {
    console.log('  📱 二维码页面已在浏览器中自动打开（公网地址.html）');
    console.log('     手机扫码或直接点击页面按钮复制地址');
  } else {
    console.log('  （二维码页面生成失败，请手动复制上面的地址）');
  }
  console.log('');
  console.log('  同一 WiFi 下的备用地址：');
  lanIPs().forEach(ip => console.log('    http://' + ip + ':' + PORT + '/'));
  console.log('');
  console.log('  地址也已保存到：公网地址.txt 和 公网地址.html');
  console.log('  【关闭】按 Ctrl+C 或直接关掉本窗口');
  console.log('========================================');
  console.log('');

  /* ---------- 退出清理 ---------- */
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    console.log('\n正在关闭服务器与隧道…');
    try { tunnel.proc.kill(); } catch (e) {}
    if (serverProc) {
      try { serverProc.kill(); } catch (e) {}
      if (IS_WIN) {
        // Windows 下确保子进程树被清理
        try { spawn('taskkill', ['/PID', String(tunnel.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
        try { spawn('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
      }
    }
    setTimeout(() => process.exit(0), 600);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  tunnel.proc.on('exit', () => { if (!closing) { console.log('\n⚠ 隧道已断开，程序退出。'); shutdown(); } });
})();
