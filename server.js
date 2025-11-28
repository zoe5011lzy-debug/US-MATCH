// server.js
// Node + Express + socket.io
// - 负责：玩家同步 + 3 个 US 点状态机（idle / gathering / fusion / lockback）
// - 负责：match 小点生成、飘动 & 捕捉（共享状态）
// - 规则补充：
//   - 同一组玩家完成过某 US，一模一样的组合不能再触发该 US（除非组合发生变化）
//   - fusion 结束后立刻锁回 US（lockback 5 秒），此时进行统计 & 排行榜
//   - 捕捉期间不断补充同色 match 点（不会出现 0 个）

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ---------------------------
// 玩家
// ---------------------------
const players = new Map(); // id -> { x, y }

// ---------------------------
// US 点
// ---------------------------

function makeUS(id, x, y, color, name) {
  return {
    id,
    x,
    y,
    radiusRel: 0.12,
    color,
    name,

    state: 'idle',          // 'idle' | 'gathering' | 'fusion' | 'lockback'
    gatheringStart: null,
    gatheringDuration: 5000,

    fusionStart: null,
    fusionDuration: 10000,  // 捕捉 duration

    lockbackStart: null,
    lockbackDuration: 5000, // 锁回 duration

    currentGroup: [],       // 本轮参与者
    lastGroup: [],          // 上一轮完成的参与者（给前端画记忆线）

    currentRoundId: 0,      // match 回合 id
    lastRoundId: null,      // 上一轮 roundId（排行榜用）

    completedGroups: []     // [{ playerIds: ['a','b',...] }] 完成过该 US 的组（去重）
  };
}

const usPoints = [
  makeUS('yellow-us', 0.25, 0.5, '#FFD93D', 'Yellow'),
  makeUS('blue-us',   0.50, 0.5, '#6EC1FF', 'Blue'),
  makeUS('pink-us',   0.75, 0.5, '#FF90C9', 'Pink')
];

// ---------------------------
// match 系统（共享）
// ---------------------------
//
// 每颗小点：
// {
//   id,
//   xRel, yRel,
//   vxRel, vyRel,
//   colorHex,
//   state: 'free' | 'captured',
//   capturedById: string | null,
//   usId: string,     // 属于哪一个 US（用来区分回合）
//   roundId: number   // 属于哪一轮 match
// }

let matchActive = false;
let matchFusionUSId = null;
let matchDots = [];

// ---------------------------
// 工具
// ---------------------------
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function getPlayerRadiusRel() {
  if (usPoints.length === 0) return 0.05;
  const rUS = usPoints[0].radiusRel;
  const factor = Math.sqrt(1 / 6);
  return rUS * factor;
}

function getPlayersInsideUS(us) {
  const inside = [];
  players.forEach((p, id) => {
    const dx = p.x - us.x;
    const dy = p.y - us.y;
    const distRel = Math.sqrt(dx * dx + dy * dy);
    if (distRel < us.radiusRel) inside.push(id);
  });
  return inside;
}

function sortIds(arr) {
  return arr.slice().sort();
}

function arraysEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// 某 US 是否已经有一组玩家 EXACT 完成过
function hasCompletedExactGroup(us, sortedIds) {
  if (!Array.isArray(us.completedGroups)) return false;
  return us.completedGroups.some(g => arraysEqual(g.playerIds, sortedIds));
}

// 在某 US 记录一组完成过（用于「同一组不能再次触发」）
function addCompletedGroup(us, groupIds) {
  const sorted = sortIds(groupIds);
  if (sorted.length < 2) return;
  if (hasCompletedExactGroup(us, sorted)) return;
  us.completedGroups.push({ playerIds: sorted });
}

// ---------------------------
// US 状态机：idle → gathering → fusion → lockback → idle
// ---------------------------
function updateUSLogic(now) {
  usPoints.forEach(us => {
    const prevState = us.state;
    const insideIds = getPlayersInsideUS(us);
    const insideSorted = sortIds(insideIds);

    if (us.state === 'idle') {
      // idle：有 ≥2 人在圈内且该组合没有 EXACT 完成过这个 US → 进入 gathering
      if (insideIds.length >= 2) {
        if (!hasCompletedExactGroup(us, insideSorted)) {
          us.state = 'gathering';
          us.gatheringStart = now;
          if (typeof us.gatheringDuration !== 'number') {
            us.gatheringDuration = 5000;
          }
          us.currentGroup = insideIds.slice();
          us.lockbackStart = null;
          us.lockbackDuration = us.lockbackDuration || 5000;
        }
      }
    } else if (us.state === 'gathering') {
      // gathering：圈内玩家可以增加，但不能 <2，否则失败归 idle
      insideIds.forEach(id => {
        if (!us.currentGroup.includes(id)) {
          us.currentGroup.push(id);
        }
      });

      if (insideIds.length < 2) {
        us.state = 'idle';
        us.gatheringStart = null;
        us.currentGroup = [];
      } else {
        const elapsed = now - (us.gatheringStart || now);
        if (elapsed >= us.gatheringDuration) {
          if (us.currentGroup.length >= 2) {
            us.state = 'fusion';
            us.fusionStart = now;
            if (typeof us.fusionDuration !== 'number') {
              us.fusionDuration = 10000;
            }
          } else {
            us.state = 'idle';
            us.gatheringStart = null;
            us.currentGroup = [];
          }
        }
      }
    } else if (us.state === 'fusion') {
      // fusion：match 捕捉阶段，玩家自由移动
      const elapsed = now - (us.fusionStart || now);
      if (elapsed >= us.fusionDuration) {
        // 结束 match → 进入 lockback：结果展示 + 锁回 5 秒
        us.state = 'lockback';
        us.lockbackStart = now;
        if (typeof us.lockbackDuration !== 'number') {
          us.lockbackDuration = 5000;
        }
        // 这一轮的 roundId 记录下来（排行榜 & 总数）
        us.lastRoundId = us.currentRoundId || 0;

        // 把这一轮参与者的位置拉回 US 圆心（锁回）
        const cx = us.x;
        const cy = us.y;
        us.currentGroup.forEach(pid => {
          const p = players.get(pid);
          if (p) {
            p.x = cx;
            p.y = cy;
          }
        });
      }
    } else if (us.state === 'lockback') {
      // lockback：5 秒锁定 & 排行展示
      const elapsed = now - (us.lockbackStart || now);
      if (elapsed >= us.lockbackDuration) {
        // lockback 结束 → 本轮完成，写入 lastGroup & completedGroups，再回 idle
        us.state = 'idle';
        us.gatheringStart = null;
        us.fusionStart = null;
        us.lockbackStart = null;

        us.lastGroup = Array.isArray(us.currentGroup)
          ? us.currentGroup.slice()
          : [];
        if (us.lastGroup.length >= 2) {
          addCompletedGroup(us, us.lastGroup);
        }

        us.currentGroup = [];
      }
    }

    // 状态机更新后，驱动 match 开关
    if (prevState !== 'fusion' && us.state === 'fusion') {
      onUSFusionStart(us);
    }
    if (prevState === 'fusion' && us.state !== 'fusion') {
      onUSFusionEnd(us);
    }
  });
}

// ---------------------------
// match：fusion 开始/结束
// ---------------------------
function onUSFusionStart(us) {
  matchActive = true;
  matchFusionUSId = us.id;

  // 新的一轮
  us.currentRoundId = (us.currentRoundId || 0) + 1;
  const roundId = us.currentRoundId;

  // 保留被捕获的卫星，清除旧的 free 点
  matchDots = matchDots.filter(d => d.state === 'captured');

  spawnMatchDots(us, roundId);
}

function onUSFusionEnd(us) {
  matchActive = false;
  matchFusionUSId = null;

  // 未被捕获的 free 点消失
  matchDots = matchDots.filter(d => d.state === 'captured');
  // lastRoundId 已在 lockback 开始时写入
}

// 生成一批 match 点
function spawnMatchDots(us, roundId) {
  if (!usPoints.length) return;

  const colors = usPoints.map(u => u.color);
  const total = 120; // 初始总量，可调

  for (let i = 0; i < total; i++) {
    matchDots.push({
      id: `m-${Date.now()}-${i}-${Math.floor(Math.random() * 10000)}`,
      xRel: Math.random(),
      yRel: Math.random(),
      vxRel: (Math.random() * 2 - 1) * 0.003,
      vyRel: (Math.random() * 2 - 1) * 0.003,
      colorHex: colors[i % colors.length],
      state: 'free',
      capturedById: null,
      usId: us.id,
      roundId: roundId
    });
  }
}

// ---------------------------
// match 飘动 & 碰撞 + 补充
// ---------------------------
function updateMatchDots(now) {
  if (matchDots.length === 0 && !matchActive) return;

  const playerRadiusRel = getPlayerRadiusRel();
  const captureDistRel = playerRadiusRel;

  let fusionUS = null;
  if (matchActive && matchFusionUSId) {
    fusionUS = usPoints.find(u => u.id === matchFusionUSId && u.state === 'fusion');
  }
  const fusionColor = fusionUS ? fusionUS.color.toLowerCase() : null;
  const fusionUSId = fusionUS ? fusionUS.id : null;
  const currentRoundId = fusionUS ? fusionUS.currentRoundId : null;

  // 飘动 + 捕捉
  matchDots.forEach(d => {
    if (d.state === 'free') {
      // 飘动
      d.xRel += d.vxRel;
      d.yRel += d.vyRel;

      // 边缘反弹
      if (d.xRel < 0) { d.xRel = 0; d.vxRel *= -1; }
      if (d.xRel > 1) { d.xRel = 1; d.vxRel *= -1; }
      if (d.yRel < 0) { d.yRel = 0; d.vyRel *= -1; }
      if (d.yRel > 1) { d.yRel = 1; d.vyRel *= -1; }

      // 只有当前 fusion US 的颜色 + 当前轮次的点才会被捕捉
      if (
        matchActive &&
        fusionColor &&
        fusionUSId &&
        currentRoundId !== null &&
        d.usId === fusionUSId &&
        d.roundId === currentRoundId &&
        (d.colorHex || '').toLowerCase() === fusionColor
      ) {
        players.forEach((p, pid) => {
          if (d.state !== 'free') return;
          const dx = d.xRel - p.x;
          const dy = d.yRel - p.y;
          const distRel = Math.sqrt(dx * dx + dy * dy);
          if (distRel <= captureDistRel) {
            d.state = 'captured';
            d.capturedById = pid;
          }
        });
      }
    }
    // captured 点不再移动，位置交给前端去解释（尾巴）
  });

  // ⭐ 补充逻辑：在 fusion 期间，同色 free match 点如果为 0，就补一个
  if (
    matchActive &&
    fusionColor &&
    fusionUSId &&
    currentRoundId !== null
  ) {
    let freeCount = 0;
    matchDots.forEach(d => {
      if (
        d.state === 'free' &&
        d.usId === fusionUSId &&
        d.roundId === currentRoundId &&
        (d.colorHex || '').toLowerCase() === fusionColor
      ) {
        freeCount++;
      }
    });

    if (freeCount === 0) {
      matchDots.push({
        id: `m-supply-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        xRel: Math.random(),
        yRel: Math.random(),
        vxRel: (Math.random() * 2 - 1) * 0.003,
        vyRel: (Math.random() * 2 - 1) * 0.003,
        colorHex: fusionUS.color,
        state: 'free',
        capturedById: null,
        usId: fusionUSId,
        roundId: currentRoundId
      });
    }
  }
}

// ---------------------------
// 序列化给前端
// ---------------------------
function serializePlayers() {
  const obj = {};
  players.forEach((p, id) => {
    obj[id] = { x: p.x, y: p.y };
  });
  return obj;
}

function serializeMatch() {
  return {
    active: matchActive,
    fusionUSId: matchFusionUSId,
    dots: matchDots.map(d => ({
      id: d.id,
      xRel: d.xRel,
      yRel: d.yRel,
      colorHex: d.colorHex,
      state: d.state,
      capturedById: d.capturedById,
      usId: d.usId,
      roundId: d.roundId
    }))
  };
}

// ---------------------------
// Socket.io
// ---------------------------
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  const startX = Math.random() * 0.6 + 0.2;
  const startY = Math.random() * 0.6 + 0.2;
  players.set(socket.id, { x: startX, y: startY });

  socket.emit('init', {
    id: socket.id,
    players: serializePlayers(),
    usPoints: usPoints
  });

  socket.broadcast.emit('playerJoined', {
    id: socket.id,
    x: startX,
    y: startY
  });

  socket.on('updatePlayer', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    if (typeof data.x === 'number') p.x = clamp01(data.x);
    if (typeof data.y === 'number') p.y = clamp01(data.y);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    players.delete(socket.id);
    io.emit('playerLeft', socket.id);
  });
});

// ---------------------------
// 主循环
// ---------------------------
const TICK_MS = 100;

setInterval(() => {
  const now = Date.now();

  updateUSLogic(now);
  updateMatchDots(now);

  io.emit('state', {
    players: serializePlayers(),
    usPoints: usPoints,
    match: serializeMatch()
  });
}, TICK_MS);

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`US System server running on port ${PORT}`);
});
