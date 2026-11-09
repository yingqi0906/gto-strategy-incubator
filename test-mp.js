/* 联机服务器流程测试：创建/加入/座位分配/大厅广播/快照脱敏/动作中继/踢人/掉线/开局拒绝加入 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18787;
const BASE = 'http://localhost:' + PORT;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}
async function pollOnce(room, id, seq) {
  const r = await fetch(BASE + '/api/poll?room=' + room + '&id=' + id + '&seq=' + (seq || 0));
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  // 启动服务器（加速掉线检测）
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      MP_SWEEP: '300', MP_CLIENT_TIMEOUT: '800', MP_HOST_TIMEOUT: '60000'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', d => srvLog += d);
  srv.stderr.on('data', d => srvLog += d);

  // 等待服务器就绪
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { await fetch(BASE + '/'); up = true; } catch (e) { await sleep(100); }
  }
  ok(up, '服务器启动并可访问静态页');
  if (!up) { console.error(srvLog); process.exit(1); }

  console.log('--- 房间创建与加入 ---');
  const host = await post('/api/create', { name: '主机' });
  ok(host.ok && /^\d{5}$/.test(host.room), '创建房间，房间号为5位数字: ' + host.room);
  ok(typeof host.seat === 'number' && host.seat >= 0 && host.seat <= 8, '主机分配合法座位 ' + host.seat);

  const clients = [];
  for (let i = 0; i < 7; i++) { // 2026-10-14：8 人桌 = 主机 + 7 客机
    const c = await post('/api/join', { room: host.room, name: '客机' + (i + 1) });
    ok(c.ok, '客机' + (i + 1) + '加入，座位 ' + c.seat);
    clients.push(c);
  }
  const seats = clients.map(c => c.seat);
  ok(new Set(seats).size === 7 && !seats.includes(host.seat), '7个客机座位随机且互不重复、不与主机冲突（8 人桌）');

  const full = await post('/api/join', { room: host.room, name: '第八人' });
  ok(!full.ok, '满员后加入被拒绝: ' + full.err);

  const bad = await post('/api/join', { room: '99999', name: 'x' });
  ok(!bad.ok, '不存在的房间号加入被拒绝');

  console.log('--- 主机消息（加入通知） ---');
  const hb1 = await pollOnce(host.room, host.id, 0);
  ok(hb1.ok && hb1.msgs.filter(m => m.type === 'joined').length === 7, '主机收到7条加入通知（8 人桌）');

  console.log('--- 大厅广播 ---');
  const lobbySeats = new Array(9).fill(null).map((_, i) => i === host.seat ? { type: 'host', name: '主机' }
    : seats.includes(i) ? { type: 'client', name: 'x' } : { type: 'ai', name: 'AI补位' });
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'lobby', seats: lobbySeats } });
  const cb = await pollOnce(host.room, clients[0].id, 0);
  ok(cb.ok && cb.msgs.some(m => m.type === 'lobby'), '客机收到大厅座位广播');

  console.log('--- 状态快照脱敏 ---');
  const holes = ['AsKs', 'QhQd', '7c8c', 'JhTh', '3s3d', '9h8h'];
  const snap = {
    phase: 'playing', handNo: 1, board: [], seats: players(2)
  };
  function players(buttonIdx) {
    return new Array(6).fill(null).map((_, i) => ({
      name: 'p' + i, type: 'ai', chips: 100, bet: 0, inHand: true,
      allIn: false, winner: false, revealed: i === 1, // 座位1已摊牌亮牌
      posName: '', offline: false, hole: [{ r: 14, s: 0 }]
    })).map((p, i) => { p.hole = [{ r: 14, s: i }]; return p; });
  }
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'state', snap: snap } });
  const csnap = await pollOnce(host.room, clients[2].id, 0);
  const st = csnap.msgs.filter(m => m.type === 'state').pop();
  ok(!!st, '客机收到状态快照');
  ok(st.snap.mySeat === clients[2].seat, '快照带 mySeat=' + st.snap.mySeat);
  const othersLeak = st.snap.seats.filter((p, i) => i !== clients[2].seat && i !== 1 && p.hole && p.hole.length);
  ok(othersLeak.length === 0, '未亮牌的其他座位底牌被剥离');
  ok(st.snap.seats[1].hole && st.snap.seats[1].hole.length === 1, '已亮牌座位保留底牌');

  console.log('--- 动作中继 ---');
  await post('/api/msg', { room: host.room, id: clients[0].id, msg: { type: 'action', action: { type: 'raise', to: 3 } } });
  const hb2 = await pollOnce(host.room, host.id, hb1.seq);
  const actMsg = hb2.msgs.filter(m => m.type === 'action').pop();
  ok(!!actMsg && actMsg.seat === clients[0].seat && actMsg.action.to === 3, '主机收到客机动作（带座位）');
  await post('/api/msg', { room: host.room, id: clients[1].id, msg: { type: 'action', action: { type: 'buyin', amount: 300 } } });
  const hb2b = await pollOnce(host.room, host.id, hb2.seq);
  const buyMsg = hb2b.msgs.filter(m => m.type === 'action' && m.action && m.action.type === 'buyin').pop();
  ok(!!buyMsg && buyMsg.seat === clients[1].seat && buyMsg.action.amount === 300, '主机收到客机买入请求（带座位与金额）');

  console.log('--- 踢人 ---');
  // 先排空积压消息，再挂起长轮询，验证 closed 消息能实时推送到被踢客机
  const drained = await pollOnce(host.room, clients[4].id, 0);
  const hangPoll = pollOnce(host.room, clients[4].id, drained.seq);
  await sleep(200);
  await post('/api/msg', { room: host.room, id: host.id, msg: { type: 'kick', seat: clients[4].seat } });
  const kc = await hangPoll;
  ok(kc.msgs.some(m => m.type === 'closed'), '被踢客机收到 closed');

  console.log('--- 掉线检测 ---');
  // clients[1] 不再轮询 → 应被判掉线并通知主机
  await sleep(1700);
  const hb3 = await pollOnce(host.room, host.id, hb2.seq);
  const leftMsg = hb3.msgs.filter(m => m.type === 'left');
  ok(leftMsg.some(m => m.seat === clients[1].seat), '停止轮询的客机被判定掉线并通知主机');
  const kc2 = await pollOnce(host.room, clients[4].id, kc.seq);
  ok(kc2.closed === true || kc2.ok === false, '被踢客机再次轮询返回 closed/失效');

  console.log('--- 游戏开始后加入（下一手生效） ---');
  // 新房间：主机 + 6 AI + 1 空位，开局后迟到者应落座唯一空位（8 人桌，2026-10-14 起 9→8）
  const h2 = await post('/api/create', { name: '主机2' });
  const aiSeats = new Array(8).fill(null).map((_, i) =>
    i === h2.seat ? { type: 'host', name: '主机2' }
      : i === (h2.seat + 1) % 8 ? null
        : { type: 'ai', name: 'AI' + i });
  await post('/api/msg', { room: h2.room, id: h2.id, msg: { type: 'lobby', seats: aiSeats } });
  await post('/api/msg', { room: h2.room, id: h2.id, msg: { type: 'phase', phase: 'playing' } });
  const late = await post('/api/join', { room: h2.room, name: '迟到者' });
  ok(late.ok && late.phase === 'playing' && typeof late.seat === 'number',
    '游戏开始后可加入，返回 phase=playing 与座位 ' + (late.seat !== undefined ? late.seat : late.err));
  ok(late.ok && late.seat === (h2.seat + 1) % 8, '迟到者随机落座在唯一空位（不占AI/主机座位）');
  const hb4 = await pollOnce(h2.room, h2.id, 0);
  ok(hb4.msgs.some(m => m.type === 'joined' && m.name === '迟到者'), '主机收到迟到者加入通知');
  const full2 = await post('/api/join', { room: h2.room, name: '再多一人' });
  ok(!full2.ok, '满员后游戏中加入仍被拒绝: ' + full2.err);

  console.log('--- 静态文件 ---');
  const idx = await (await fetch(BASE + '/')).text();
  ok(idx.indexOf('德州扑克') >= 0, 'index.html 可访问');
  const core = await (await fetch(BASE + '/core.js')).text();
  ok(core.indexOf('PokerCore') >= 0, 'core.js 可访问');
  const gw = await (await fetch(BASE + '/gw-ranges.js')).text();
  ok(gw.length > 1000, 'gw-ranges.js 可访问');

  srv.kill();
  console.log('\n=== 联机测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
