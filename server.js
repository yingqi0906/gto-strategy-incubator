/* 德州扑克多人联机服务器：房间管理 + 消息中继（主机权威模式）
 *
 * 运行：node server.js   （默认端口 8787，可用环境变量 PORT 覆盖）
 * 所有玩家浏览器打开 http://<本机IP>:8787/
 *
 * 职责：
 *  - 创建/加入房间（5位数字唯一房间号，客机随机分配空座位）
 *  - 长轮询消息中继：主机 <-> 客机
 *  - 状态快照个性化：按接收者脱敏他人底牌（未亮牌的一律剥离）
 *  - 掉线检测与房间回收
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

function lanIPv4s() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (k) {
    (ifaces[k] || []).forEach(function (it) {
      if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
    });
  });
  return ips;
}

const PORT = parseInt(process.env.PORT || '8787', 10);
const ROOT = __dirname;
const MP_SEATS = parseInt(process.env.MP_SEATS || '8', 10);   // 常规联机房间座位数（超能力单挑固定 2；2026-10-14 起 9→8，WPT 版式）
const CLIENT_TIMEOUT = parseInt(process.env.MP_CLIENT_TIMEOUT || '40000', 10);
const HOST_TIMEOUT = parseInt(process.env.MP_HOST_TIMEOUT || '70000', 10);
const SWEEP_MS = parseInt(process.env.MP_SWEEP || '15000', 10);
const ROOM_TTL = 3 * 3600 * 1000;

const rooms = new Map(); // code -> room

function genCode() {
  let c;
  do { c = String(Math.floor(10000 + Math.random() * 90000)); } while (rooms.has(c));
  return c;
}

function makeBox() { return { msgs: [], waiters: [] }; }
function pushMsg(box, msg) {
  box.msgs.push(msg);
  box.waiters.splice(0).forEach(function (fn) { fn(); });
}

function createRoom(name, mode) {
  const code = genCode();
  const duel = mode === 'duel';
  const capacity = duel ? 2 : MP_SEATS;          // 超能力单挑：仅 2 个座位；常规联机：最多 9 人
  const hostSeat = Math.floor(Math.random() * capacity);
  const hostId = 'H' + Math.random().toString(36).slice(2, 10);
  const room = {
    code: code, hostId: hostId, hostSeat: hostSeat, phase: 'lobby',
    duel: duel, capacity: capacity,
    seats: new Array(capacity).fill(null),      // 服务端座位表（用于加入分配）
    clients: new Map(),                        // id -> {id,seat,name,box,lastSeen,token}
    joinTokens: new Map(),                     // 加入令牌 -> id（同一浏览器重复加入去重）
    kickedTokens: new Set(),                   // 被主机移出的浏览器令牌（禁止自动重连回房）
    hostBox: makeBox(), hostLastSeen: Date.now(),
    lastActive: Date.now()
  };
  room.seats[hostSeat] = { type: 'host', name: (name || '主机').slice(0, 12), id: hostId };
  rooms.set(code, room);
  return room;
}

function freeSeat(room) {
  const empties = [];
  for (let i = 0; i < room.capacity; i++) if (!room.seats[i]) empties.push(i);
  if (!empties.length) return -1;
  return empties[Math.floor(Math.random() * empties.length)];
}

/* 按接收者座位脱敏：只有自己的牌 + 已亮牌的牌可以下发
   逐张控制：摊牌（revealed）全亮；秀牌展示（showRevealed）只亮被标记的那几张
   超能力单挑：持有者超能力A → 可见其他座位的手牌；超能力B → 独享转牌/河牌预览（peek） */
function personalize(snap, seat) {
  const s = JSON.parse(JSON.stringify(snap));
  const powers = s.powers || [];
  const myPower = MP_DUEL_POWER(powers, seat);
  (s.seats || []).forEach(function (p, i) {
    if (i === seat || p.revealed) return;
    if (myPower === 'A') return;                  // 超能力A：保留对手手牌（透视）
    if (p.showRevealed && (p.showRevealed[0] || p.showRevealed[1])) {
      p.hole = (p.hole || []).map(function (c, ci) { return p.showRevealed[ci] ? c : null; });
    } else {
      p.hole = [];
    }
  });
  if (myPower !== 'B') s.peek = { turn: null, river: null }; // 转牌/河牌预览只发给超能力B 持有者
  s.mySeat = seat;
  return s;
}

function MP_DUEL_POWER(powers, seat) {
  const p = powers[seat];
  return (p === 'A' || p === 'B') ? p : null;
}

function dropClient(room, c, silent) {
  if (!room.clients.has(c.id)) return;
  room.clients.delete(c.id);
  /* 释放加入令牌映射：同一浏览器下次加入可正常分配新座位 */
  if (c.token && room.joinTokens.get(c.token) === c.id) room.joinTokens.delete(c.token);
  if (!silent) pushMsg(room.hostBox, { type: 'left', seat: c.seat, name: c.name });
  // 座位一律释放（大厅/游戏中均如此）：掉线玩家由主机踢出后座位空出，可被新玩家使用
  if (room.seats[c.seat] && room.seats[c.seat].id === c.id) {
    room.seats[c.seat] = null;
  }
}

function closeRoom(room) {
  pushMsg(room.hostBox, { type: 'closed' });
  room.clients.forEach(function (c) { pushMsg(c.box, { type: 'closed' }); });
  rooms.delete(room.code);
}

/* ---------- HTTP 基础 ---------- */
const JSONH = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

/* JSON 响应（2026-10-17）：大于 1KB 且客户端支持时 gzip。
   对局快照里重复的键名/日志文本压缩率很高（通常 5–10 倍），
   家庭宽带上行 / 公网隧道下能明显减少传输时间；小响应不压（省 CPU、省一个 tick）。 */
function sendJson(req, res, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const ae = String((req && req.headers && req.headers['accept-encoding']) || '');
  if (buf.length > 1024 && /\bgzip\b/i.test(ae)) {
    zlib.gzip(buf, function (err, gz) {
      if (err || !gz) { res.writeHead(200, JSONH); res.end(buf); return; }
      res.writeHead(200, Object.assign({}, JSONH, {
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding'
      }));
      res.end(gz);
    });
    return;
  }
  res.writeHead(200, JSONH);
  res.end(buf);
}

function sendFile(req, res, name, type) {
  fs.readFile(path.join(ROOT, name), function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const head = { 'Content-Type': type, 'Cache-Control': 'no-store' };
    /* 静态文本（入口 html 400KB、翻后策略表 800KB、解算内核 270KB）也 gzip：
       手机上经隧道首屏能省 70%~85%，否则新模块一上首屏就要下 1.5MB */
    const ae = String((req && req.headers && req.headers['accept-encoding']) || '');
    if (/^text\//.test(type) && data.length > 4096 && /\bgzip\b/i.test(ae)) {
      zlib.gzip(data, function (e2, gz) {
        if (e2 || !gz) { res.writeHead(200, head); res.end(data); return; }
        res.writeHead(200, Object.assign({}, head, {
          'Content-Encoding': 'gzip', Vary: 'Accept-Encoding'
        }));
        res.end(gz);
      });
      return;
    }
    res.writeHead(200, head);
    res.end(data);
  });
}

function withBody(req, res, fn) {
  let data = '';
  req.on('data', function (ch) { data += ch; if (data.length > 1e6) req.destroy(); });
  req.on('end', function () {
    let body = {};
    try { body = data ? JSON.parse(data) : {}; } catch (e) {}
    res.json = function (o) {
      sendJson(req, res, o);
    };
    fn(body);
  });
}

/* ---------- 路由 ---------- */
/* 允许经 HTTP 直接下发的客户端脚本（白名单：只放行根目录下这几个文件名，
   既防目录穿越，也保证新增模块时统一在这里登记） */
const CLIENT_JS = [
  'core.js', 'gw-ranges.js', 'postflop-engine.js', 'qr.js',
  /* 2026-10-18/19 新增：翻后策略表 + 现场解内核/桥接。
     漏登记 → 经 HTTP（局域网/公网联机）404 → 查表与现场解静默回退旧引擎 */
  'postflop-table.js', 'postflop-table-data.js',
  'solver-kernel-src.js', 'postflop-solver-bridge.js',
  /* 2026-10-27 新增：大牌提示缎带模块（漏登记 → 联机版静默无提示） */
  'rank-ribbon.js'
];

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch (e) {}

  if (req.method === 'GET') {
    if (p === '/' || p === '/gto策略培养皿.html') return sendFile(req, res, 'gto策略培养皿.html', 'text/html; charset=utf-8');
    /* 客户端脚本（白名单——**新增模块必须登记在这里**，
       否则经 HTTP 打开时 404，core.js 会静默退回内联降级策略） */
    if (CLIENT_JS.indexOf(p.slice(1)) >= 0 && p.charAt(0) === '/')
      return sendFile(req, res, p.slice(1), 'text/javascript; charset=utf-8');
    /* 音效资源（/sounds/*.wav，白名单防目录穿越） */
    const mSnd = p.match(/^\/sounds\/([A-Za-z0-9_-]+\.wav)$/);
    if (mSnd) return sendFile(req, res, 'sounds/' + mSnd[1], 'audio/wav');
    /* 界面组件图片（/pic/*.png，白名单防目录穿越） */
    const mPic = p.match(/^\/pic\/([A-Za-z0-9_@.-]+\.png)$/);
    if (mPic) return sendFile(req, res, 'pic/' + mPic[1], 'image/png');
  }

  /* ---------- 局域网地址（供主机大厅生成手机扫码链接） ---------- */
  if (p === '/api/lan' && req.method === 'GET') {
    const ips = [];
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach(function (k) {
      (ifaces[k] || []).forEach(function (it) {
        if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
      });
    });
    res.writeHead(200, JSONH);
    return res.end(JSON.stringify({ ok: true, ips: ips, port: PORT }));
  }

  /* ---------- 历史战绩存储（按玩家 pid 隔离，存 stats.json） ---------- */
  const STATS_FILE = path.join(ROOT, 'stats.json');
  let statsCache = null;
  function loadStatsFile() {
    if (!statsCache) {
      try { statsCache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
      catch (e) { statsCache = []; }
      if (!Array.isArray(statsCache)) statsCache = [];
    }
    return statsCache;
  }
  function saveStatsFile() {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(statsCache)); } catch (e) {}
  }

  if (p === '/api/stats' && req.method === 'GET') {
    const pid = u.searchParams.get('pid') || '';
    return withBody(req, res, function () {
      res.json({ ok: true, records: loadStatsFile().filter(function (r) { return r.pid === pid; }) });
    });
  }
  if (p === '/api/stats' && req.method === 'POST') {
    return withBody(req, res, function (body) {
      if (!body.pid || !body.record) return res.json({ ok: false, err: '参数缺失' });
      const list = loadStatsFile();
      const rec = Object.assign({ pid: body.pid }, body.record);
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].pid === body.pid && list[i].sid === rec.sid) list.splice(i, 1);
      }
      list.push(rec);
      saveStatsFile();
      res.json({ ok: true });
    });
  }
  if (p === '/api/stats/clear' && req.method === 'POST') {
    return withBody(req, res, function (body) {
      statsCache = loadStatsFile().filter(function (r) { return r.pid !== body.pid; });
      saveStatsFile();
      res.json({ ok: true });
    });
  }

  if (p === '/api/create' && req.method === 'POST') {
    return withBody(req, res, function (body) {
      const room = createRoom(body.name, body.mode);
      res.json({ ok: true, room: room.code, id: room.hostId, seat: room.hostSeat, duel: room.duel });
    });
  }

  if (p === '/api/join' && req.method === 'POST') {
    return withBody(req, res, function (body) {
      const room = rooms.get(String(body.room || ''));
      if (!room) return res.json({ ok: false, err: '房间不存在，请检查房间号' });
      /* 大厅与游戏中均可加入（游戏中加入者下一手牌开始时入座） */
      if (room.phase !== 'lobby' && room.phase !== 'playing') {
        return res.json({ ok: false, err: '当前无法加入' });
      }
      const name = (body.name || '玩家').slice(0, 12);
      const token = body.token ? String(body.token).slice(0, 64) : '';
      /* 已被主机移出的玩家不得再次进入（否则客机掉线自救会自动"踢了又回来"） */
      if (token && room.kickedTokens.has(token)) {
        return res.json({ ok: false, kicked: true, err: '你已被房主移出该房间' });
      }
      /* 重复校验：同一浏览器（同一加入令牌）重复请求 → 返回原有座位，不再分配新座位、不再通知主机。
         覆盖弱网下连点"加入房间"、失败重试、页面刷新重进等场景，避免同一玩家占多个座位。 */
      if (token) {
        const prevId = room.joinTokens.get(token);
        const prev = prevId ? room.clients.get(prevId) : null;
        if (prev) {
          prev.lastSeen = Date.now();
          prev.name = name;
          if (room.seats[prev.seat]) room.seats[prev.seat].name = name;
          return res.json({ ok: true, room: room.code, id: prev.id, seat: prev.seat,
            phase: room.phase, duel: !!room.duel, rejoin: true });
        }
        if (prevId) room.joinTokens.delete(token); // 陈旧映射：原客户端已被服务器除名
      }
      const seat = freeSeat(room);
      if (seat < 0) return res.json({ ok: false, err: '房间已满（' + room.capacity + '人）' });
      const id = 'C' + Math.random().toString(36).slice(2, 10);
      room.seats[seat] = { type: 'client', name: name, id: id };
      room.clients.set(id, { id: id, seat: seat, name: name, box: makeBox(), lastSeen: Date.now(), token: token });
      if (token) room.joinTokens.set(token, id);
      room.lastActive = Date.now();
      pushMsg(room.hostBox, { type: 'joined', seat: seat, name: name });
      res.json({ ok: true, room: room.code, id: id, seat: seat, phase: room.phase, duel: !!room.duel });
    });
  }

  if (p === '/api/msg' && req.method === 'POST') {
    return withBody(req, res, function (body) {
      const room = rooms.get(String(body.room || ''));
      if (!room) return res.json({ ok: false, err: '房间不存在' });
      room.lastActive = Date.now();
      const msg = body.msg || {};
      if (body.id === room.hostId) {
        room.hostLastSeen = Date.now();
        if (msg.type === 'state') {
          room.phase = (msg.snap && msg.snap.phase) || room.phase;
          room.clients.forEach(function (c) {
            pushMsg(c.box, { type: 'state', snap: personalize(msg.snap, c.seat) });
          });
        } else if (msg.type === 'lobby') {
          // 同步 AI 座位到服务端座位表（避免加入时分配到 AI 占位）
          (msg.seats || []).forEach(function (s, i) {
            if (s && s.type === 'ai' && (!room.seats[i] || room.seats[i].type === 'ai')) {
              room.seats[i] = { type: 'ai', name: s.name };
            }
          });
          room.clients.forEach(function (c) { pushMsg(c.box, msg); });
        } else if (msg.type === 'phase') {
          room.phase = msg.phase;
          room.clients.forEach(function (c) { pushMsg(c.box, msg); });
        } else if (msg.type === 'chat') {
          // 主机发言：广播给所有客机（name/seat/text 限长防滥用）
          const text = String(msg.text || '').trim().slice(0, 120);
          if (text) {
            const out = {
              type: 'chat',
              name: String(msg.name || '主机').slice(0, 12),
              seat: typeof msg.seat === 'number' ? msg.seat : room.hostSeat,
              text: text
            };
            room.clients.forEach(function (c) { pushMsg(c.box, out); });
          }
        } else if (msg.type === 'kick') {
          let kicked = null;
          room.clients.forEach(function (c) { if (c.seat === msg.seat) kicked = c; });
          if (kicked) {
            if (kicked.token) room.kickedTokens.add(kicked.token);  // 记住被踢者，禁止其自动重连回房
            pushMsg(kicked.box, { type: 'closed', reason: 'kicked' });
            dropClient(room, kicked, true);
            /* 通知主机座位已释放：否则主机本地仍占着该座位，
               大厅会一直显示已被踢的玩家，且新玩家落到该座位时主机不予落座 */
            pushMsg(room.hostBox, { type: 'left', seat: kicked.seat, name: kicked.name, exited: true });
          }
        } else if (msg.type === 'close') {
          // 主机主动退出牌局：解散房间
          closeRoom(room);
        }
      } else {
        const c = room.clients.get(body.id);
        if (!c) {
          // 客户端已被按超时除名（手机长时间后台切屏）→ 明确回执，客户端据此自动重新加入
          return res.json({ ok: false, gone: true, err: 'client gone' });
        }
        c.lastSeen = Date.now();
        // 客机主动退出牌局：释放座位并通知主机（主机保留其本局战绩）
        if (msg.type === 'leave') {
          pushMsg(room.hostBox, { type: 'left', seat: c.seat, name: c.name, exited: true });
          if (room.seats[c.seat] && room.seats[c.seat].id === c.id) room.seats[c.seat] = null;
          dropClient(room, c, true);
        } else {
          // seq：客机动作序号（主机侧幂等去重，防止网络中断重发导致重复执行）
          pushMsg(room.hostBox, { type: msg.type || 'action', seat: c.seat, action: msg.action, seq: msg.seq });
        }
      }
      res.json({ ok: true });
    });
  }

  if (p === '/api/poll' && req.method === 'GET') {
    const room = rooms.get(String(u.searchParams.get('room') || ''));
    const id = u.searchParams.get('id') || '';
    const since = parseInt(u.searchParams.get('seq') || '0', 10);
    function replyClosed() {
      sendJson(req, res, { ok: false, closed: true, seq: since, msgs: [] });
    }
    if (!room) return replyClosed();
    let box = null;
    if (id === room.hostId) { box = room.hostBox; room.hostLastSeen = Date.now(); }
    else {
      const c = room.clients.get(id);
      if (c) { c.lastSeen = Date.now(); box = c.box; }
    }
    if (!box) return replyClosed();
    room.lastActive = Date.now();

    function reply() {
      if (res.writableEnded || res.destroyed) return;
      sendJson(req, res, { ok: true, seq: box.msgs.length, msgs: box.msgs.slice(since) });
    }
    if (box.msgs.length > since) return reply();
    let t = null;
    function go() { if (t) clearTimeout(t); reply(); }
    t = setTimeout(function () { go(); }, 20000);
    box.waiters.push(go);
    // 客户端中断连接（手机切屏 / 页面冻结 / 主动重连）→ 立即注销等待者，避免堆积
    req.on('close', function () {
      if (t) clearTimeout(t);
      const i = box.waiters.indexOf(go);
      if (i >= 0) box.waiters.splice(i, 1);
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

/* ---------- 掉线清理 ---------- */
setInterval(function () {
  const now = Date.now();
  rooms.forEach(function (room) {
    const gone = [];
    room.clients.forEach(function (c) { if (now - c.lastSeen > CLIENT_TIMEOUT) gone.push(c); });
    gone.forEach(function (c) { dropClient(room, c); });
    if (now - room.hostLastSeen > HOST_TIMEOUT || now - room.lastActive > ROOM_TTL) closeRoom(room);
  });
}, SWEEP_MS);

server.listen(PORT, '0.0.0.0', function () {
  console.log('德州扑克联机服务器已启动：');
  console.log('  本机访问   http://localhost:' + PORT + '/');
  const ips = lanIPv4s();
  if (ips.length) {
    ips.forEach(function (ip) {
      console.log('  手机/局域网 http://' + ip + ':' + PORT + '/   （手机与电脑连同一WiFi后扫码或输入此地址）');
    });
  } else {
    console.log('  未检测到局域网网卡，手机暂时无法接入。');
  }
});
