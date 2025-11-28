// sketch.js // 前端：p5.js + socket.io
//
// US 规则：基于你之前最满意的那一版 + match 层：
// - 3 个 US 点（Yellow / Blue / Pink），顺序：Yellow → Blue → Pink
// - 玩家点面积 ≈ US 面积的 1/6
// - 靠近 US：US & 玩家点有光晕
// - 进入 US：玩家点染成该 US 颜色
// - gathering 阶段（5s）：
//   - 顶部倒计时 “Xs left before ${us.name} us stops accepting new players”
//   - 已在圈内的参与者不能离开 US；圈外玩家可以加入
// - fusion 阶段（match 捕捉）：
//   - 大白字倒计时
//   - 玩家可以离开 US 捕捉 match
//   - 所有参与者即使离开 US 也保持当前 US 的颜色
// - lockback 阶段（5s）：
//   - 捕捉结束后，参与者被服务器强制拉回 US 圆，锁在圈内 5 秒
//   - 顶部用 US 颜色显示“这一轮总共捕捉了多少个 match 点”
//   - 右侧显示单个玩家捕捉数量排行榜（Top 1–10）
// - lockback 结束 → idle：这一轮参与者之间生成记忆实线（多颜色并列）
//
// match 尾巴：
// - free：满屏飘的小点（US 颜色轮换）
// - captured：按玩家分组，在玩家移动方向反向形成一条“鞭子/水草尾巴”，点之间保持间距，不重叠，有惯性甩动

let socket;
let myId = null;
let players = {};      // id -> Player
let usPoints = [];     // USPoint[]

// 静止引导组（持久虚线）：每条 { playerIds: [id...], usId, color }
let guideGroups = [];

// 完成任务后的记忆线：每条 { aId, bId, color }
let completedLines = [];

// match 状态 from server
let matchActive = false;
let matchFusionUSId = null;
let matchDots = [];

// 仅前端使用：记录每个 match 点的“惯性位置”，做鞭子/水草效果
let matchVisualPositions = {}; // dotId -> { x, y }

// 用于排行榜/统计的 match 快照：key = `${usId}|${roundId}` -> [dot, ...]
let matchDotsSnapshots = {};

// ---------------------------
// p5 lifecycle
// ---------------------------
function setup() {
  createCanvas(windowWidth, windowHeight);
  socket = io();

  socket.on('init', (data) => {
    myId = data.id;
    usPoints = data.usPoints.map(u => new USPoint(u));

    for (const id in data.players) {
      const p = data.players[id];
      players[id] = new Player(id, p.x, p.y);
    }
  });

  socket.on('playerJoined', (p) => {
    if (!players[p.id]) {
      players[p.id] = new Player(p.id, p.x, p.y);
    }
  });

  socket.on('playerLeft', (id) => {
    delete players[id];
  });

  socket.on('state', (data) => {
    // 更新玩家
    for (const id in data.players) {
      const s = data.players[id];
      if (!players[id]) {
        players[id] = new Player(id, s.x, s.y);
      } else {
        players[id].updateFromServer(s.x, s.y);
      }
    }
    for (const id in players) {
      if (!data.players[id]) delete players[id];
    }

    // 更新 US
    if (data.usPoints && usPoints.length === 0) {
      usPoints = data.usPoints.map(u => new USPoint(u));
    } else if (data.usPoints) {
      data.usPoints.forEach(uData => {
        const found = usPoints.find(u => u.id === uData.id);
        if (found) {
          found.updateFromServer(uData);
        }
      });
    }

    // 更新 match
    if (data.match) {
      matchActive = !!data.match.active;
      matchFusionUSId = data.match.fusionUSId || null;
      matchDots = Array.isArray(data.match.dots) ? data.match.dots : [];
    }
  });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function draw() {
  background(255);

  if (!myId || !players[myId]) {
    drawLoading();
    return;
  }

  const nowGlobal = Date.now();

  // 每帧重置 US halo & 玩家视觉状态
  usPoints.forEach(u => u.resetFrame());
  for (const id in players) {
    players[id].resetFrameFlags();
  }

  // 自己：输入控制 + lock / 禁入逻辑
  players[myId].updateSelfFromInput(usPoints);

  // US <-> 玩家：彩色 halo + 染色
  updateUSAndPlayers();

  // 静止逻辑：生成 guideGroups（虚线）
  computeStillRelations(nowGlobal);

  // 更新指引组：当该组玩家全部进入 US 时删除这组虚线
  updateGuideGroups();

  // 画完成任务后的记忆实线（多颜色并排）——底层
  drawCompletedLines();

  // 画静止引导虚线（A↔B + A→US + B→US）——底层
  drawStillGuides();

  // 画 US 圆
  usPoints.forEach(u => u.drawBase());

  // 画 match 点（free + 尾巴）
  drawMatchDots(nowGlobal);

  // 画玩家点
  for (const id in players) {
    players[id].draw(nowGlobal);
  }

  // 画 fusion 阶段 US 内部倒计时
  drawFusionCountdown(nowGlobal);

  // 画右侧排行榜（lockback 阶段）
  drawLockbackRanking();

  // 顶部文字（gathering / fusion / lockback 总结）
  drawTopMessages(nowGlobal);
}

function drawLoading() {
  background(255);
  fill(0);
  noStroke();
  textAlign(CENTER, CENTER);
  textSize(18);
  text('Connecting to US System…', width / 2, height / 2);
}

// ---------------------------
// 工具：玩家半径 = US 半径 * sqrt(1/6)
// ---------------------------
function getPlayerRadiusPx() {
  if (usPoints.length === 0) return 12;
  const rUS = usPoints[0].radiusPx();
  const factor = Math.sqrt(1 / 6); // ≈0.408，面积≈1/6
  return rUS * factor;
}

// ===========================
// USPoint 类
// ===========================
class USPoint {
  constructor(data) {
    this.id = data.id;
    this.xRel = data.x;
    this.yRel = data.y;
    this.radiusRel = data.radiusRel;
    this.colorHex = data.color;
    this.name = data.name;

    this.state = data.state || 'idle'; // 'idle' | 'gathering' | 'fusion' | 'lockback'
    this.gatheringStart = data.gatheringStart;
    this.gatheringDuration = data.gatheringDuration || 5000;

    this.fusionStart = data.fusionStart;
    this.fusionDuration = data.fusionDuration || 0;

    this.lockbackStart = data.lockbackStart || null;
    this.lockbackDuration = data.lockbackDuration || 0;

    this.currentGroup = data.currentGroup || [];
    this.lastGroup = data.lastGroup || [];

    this.currentRoundId = data.currentRoundId || 0;
    this.lastRoundId = data.lastRoundId || null;

    this.prevState = this.state;
    this.haloActive = false;
  }

  updateFromServer(data) {
    const oldState = this.state;

    this.xRel = typeof data.x === 'number' ? data.x : this.xRel;
    this.yRel = typeof data.y === 'number' ? data.y : this.yRel;
    this.radiusRel = typeof data.radiusRel === 'number' ? data.radiusRel : this.radiusRel;
    this.colorHex = data.color || this.colorHex;
    this.name = data.name || this.name;

    this.state = data.state || 'idle';
    this.gatheringStart = data.gatheringStart || null;
    this.gatheringDuration = typeof data.gatheringDuration === 'number'
      ? data.gatheringDuration
      : (this.gatheringDuration || 5000);

    this.fusionStart = data.fusionStart || null;
    this.fusionDuration = typeof data.fusionDuration === 'number'
      ? data.fusionDuration
      : (this.fusionDuration || 0);

    this.lockbackStart = data.lockbackStart || null;
    this.lockbackDuration = typeof data.lockbackDuration === 'number'
      ? data.lockbackDuration
      : (this.lockbackDuration || 0);

    this.currentGroup = Array.isArray(data.currentGroup) ? data.currentGroup : [];
    this.lastGroup = Array.isArray(data.lastGroup) ? data.lastGroup : (this.lastGroup || []);

    this.currentRoundId = typeof data.currentRoundId === 'number'
      ? data.currentRoundId
      : (this.currentRoundId || 0);
    this.lastRoundId = (typeof data.lastRoundId === 'number' || data.lastRoundId === null)
      ? data.lastRoundId
      : this.lastRoundId;

    // fusion → lockback：在这一刻对 matchDots 做快照，用于排行榜和统计
    if (oldState === 'fusion' && this.state === 'lockback' && this.lastRoundId != null) {
      try {
        snapshotMatchDotsForUS(this.id, this.lastRoundId);
      } catch (e) {
        console.error('Error snapshotting match dots for stats:', e);
      }
    }

    this.prevState = oldState;

    // lockback → idle：用 lastGroup 生成记忆线（完成任务）
    if (oldState === 'lockback' && this.state === 'idle' && this.lastGroup.length >= 2) {
      try {
        onUSTaskCompleted(this.lastGroup, this.colorHex);
      } catch (e) {
        console.error('Error in onUSTaskCompleted:', e);
      }
    }
  }

  screenPos() {
    return createVector(this.xRel * width, this.yRel * height);
  }

  radiusPx() {
    const minSide = min(width, height);
    return this.radiusRel * minSide;
  }

  resetFrame() {
    this.haloActive = false;
  }

  gatheringRemaining(nowGlobal) {
    if (this.state !== 'gathering' || !this.gatheringStart) return 0;
    const elapsed = nowGlobal - this.gatheringStart;
    return max(0, this.gatheringDuration - elapsed);
  }

  fusionRemaining(nowGlobal) {
    if (this.state !== 'fusion' || !this.fusionStart) return 0;
    const elapsed = nowGlobal - this.fusionStart;
    return max(0, this.fusionDuration - elapsed);
  }

  fusionElapsed(nowGlobal) {
    if (this.state !== 'fusion' || !this.fusionStart) return 0;
    return nowGlobal - this.fusionStart;
  }

  lockbackElapsed(nowGlobal) {
    if (this.state !== 'lockback' || !this.lockbackStart) return 0;
    return nowGlobal - this.lockbackStart;
  }

  drawBase() {
    const pos = this.screenPos();
    const r = this.radiusPx();
    const col = color(this.colorHex);

    // 靠近时的 halo（idle / gathering / lockback）
    if (this.haloActive && (this.state === 'idle' || this.state === 'gathering' || this.state === 'lockback')) {
      push();
      noFill();
      const haloCol = color(this.colorHex);
      haloCol.setAlpha(150);
      stroke(haloCol);
      strokeWeight(6);
      ellipse(pos.x, pos.y, r * 2.6, r * 2.6);
      pop();
    }

    // 圆本体：fusion 填满，其它空心
    push();
    strokeWeight(3);
    stroke(col);
    if (this.state === 'fusion') {
      fill(col);
    } else {
      noFill();
    }
    ellipse(pos.x, pos.y, r * 2, r * 2);
    pop();
  }
}

// ===========================
// Player 类
// ===========================
class Player {
  constructor(id, xRel, yRel) {
    this.id = id;
    this.xRel = xRel;
    this.yRel = yRel;

    this.haloActive = false;
    this.haloColorHex = null;
    this.bodyColorHex = '#000000';

    // 运动状态
    this.prevXRel = null;
    this.prevYRel = null;
    this.isStill = false;
    this.stillSince = null;
    this.lastMoveStart = null;
    this.justStartedMoving = false;

    // 屏幕坐标系下的速度（仅供尾巴方向使用）
    this.vx = 0;
    this.vy = 0;
    // 尾巴方向（屏幕坐标）：默认向左
    this.tailDir = { x: -1, y: 0 };

    // 静止 0.5 秒黑白闪烁
    this.stillHighlight = false;
  }

  screenPos() {
    return createVector(this.xRel * width, this.yRel * height);
  }

  resetFrameFlags() {
    this.haloActive = false;
    this.haloColorHex = null;
    this.bodyColorHex = '#000000';
    this.stillHighlight = false;
    this.justStartedMoving = false;
    // 不重置 tailDir/vx/vy，保持跨帧连续
  }

  updateFromServer(xRel, yRel) {
    if (this.id === myId) return; // 自己的位置用本地输入
    this.xRel = xRel;
    this.yRel = yRel;
  }

  updateMotionState(nowGlobal) {
    const dxRel = (this.prevXRel === null) ? 0 : this.xRel - this.prevXRel;
    const dyRel = (this.prevYRel === null) ? 0 : this.yRel - this.prevYRel;
    const distRel = Math.sqrt(dxRel * dxRel + dyRel * dyRel);

    const thresholdRel = 0.0015;
    const movingNow = distRel > thresholdRel;

    // 同时更新屏幕坐标系下速度，用于计算尾巴方向
    const dxScreen = dxRel * width;
    const dyScreen = dyRel * height;

    if (!movingNow) {
      if (!this.isStill) {
        this.isStill = true;
        this.stillSince = nowGlobal;
      }
      this.justStartedMoving = false;
      this.vx = 0;
      this.vy = 0;
      // 不移动时保留上一帧 tailDir，不重置
    } else {
      if (this.isStill) {
        this.isStill = false;
        this.justStartedMoving = true;
        this.lastMoveStart = nowGlobal;
      } else {
        this.justStartedMoving = false;
      }

      this.vx = dxScreen;
      this.vy = dyScreen;

      const speed = Math.sqrt(dxScreen * dxScreen + dyScreen * dyScreen);
      if (speed > 0.5) {
        // 尾巴方向 = 运动方向的反向（拖在身后）
        this.tailDir = {
          x: -dxScreen / speed,
          y: -dyScreen / speed
        };
      }
    }

    this.prevXRel = this.xRel;
    this.prevYRel = this.yRel;
  }

  // 自己：输入 + gathering/lockback 锁定 + 其他 US 锁死
  updateSelfFromInput(usArray) {
    if (this.id !== myId) return;

    let targetX = this.xRel;
    let targetY = this.yRel;

    if (touches && touches.length > 0) {
      targetX = constrain(touches[0].x / width, 0, 1);
      targetY = constrain(touches[0].y / height, 0, 1);
    } else {
      targetX = constrain(mouseX / width, 0, 1);
      targetY = constrain(mouseY / height, 0, 1);
    }

    let targetPos = createVector(targetX * width, targetY * height);
    const currentPos = this.screenPos();

    // 当前是否有一个正在进行的 US：gathering / fusion / lockback 任一
    const activeUS = usArray.find(u =>
      u.state === 'gathering' || u.state === 'fusion' || u.state === 'lockback'
    );

    usArray.forEach(us => {
      const usPos = us.screenPos();
      const r = us.radiusPx();
      const dCurrent = p5.Vector.dist(currentPos, usPos);
      const dTarget = p5.Vector.dist(targetPos, usPos);
      const isParticipant = (us.currentGroup || []).includes(this.id);

      // gathering：参与者不能离开圈
      if (us.state === 'gathering') {
        if (isParticipant && dCurrent < r && dTarget > r) {
          const dir = p5.Vector.sub(targetPos, usPos);
          if (dir.magSq() > 0) {
            dir.normalize().mult(r - 1);
            targetPos = p5.Vector.add(usPos, dir);
          }
        }
      }

      // lockback：参与者锁在圈内，非参与者不能进入
      if (us.state === 'lockback') {
        if (isParticipant) {
          if (dCurrent < r && dTarget > r) {
            const dir = p5.Vector.sub(targetPos, usPos);
            if (dir.magSq() > 0) {
              dir.normalize().mult(r - 1);
              targetPos = p5.Vector.add(usPos, dir);
            }
          }
        } else {
          if (dTarget < r) {
            const dir = p5.Vector.sub(targetPos, usPos);
            if (dir.magSq() > 0) {
              dir.normalize().mult(r + 1);
              targetPos = p5.Vector.add(usPos, dir);
            }
          }
        }
      }

      // fusion：参与者可以自由捕捉 match，不加锁定

      // 其他 US 锁死：当存在 activeUS 时，所有 idle 的其它 US 不允许进入
      if (
        activeUS &&
        activeUS.id !== us.id &&
        us.state === 'idle' &&
        dTarget < r
      ) {
        const dir = p5.Vector.sub(targetPos, usPos);
        if (dir.magSq() > 0) {
          dir.normalize().mult(r + 1);
          targetPos = p5.Vector.add(usPos, dir);
        }
      }
    });

    this.xRel = constrain(targetPos.x / width, 0, 1);
    this.yRel = constrain(targetPos.y / height, 0, 1);

    if (socket && socket.connected) {
      socket.emit('updatePlayer', { x: this.xRel, y: this.yRel });
    }
  }

  setHalo(colorHex) {
    this.haloActive = true;
    this.haloColorHex = colorHex;
  }

  draw(nowGlobal) {
    const pos = this.screenPos();
    const rPlayer = getPlayerRadiusPx();

    // 彩色 halo
    if (this.haloActive && this.haloColorHex) {
      push();
      const c = color(this.haloColorHex);
      c.setAlpha(60);
      noStroke();
      fill(c);
      ellipse(pos.x, pos.y, rPlayer * 3, rPlayer * 3);
      pop();
    }

    // 静止 0.5 秒黑白闪烁
    if (this.stillHighlight) {
      push();
      const phase = Math.floor(nowGlobal / 250) % 2;
      const colVal = phase === 0 ? 0 : 255;
      noFill();
      stroke(colVal);
      strokeWeight(3);
      ellipse(pos.x, pos.y, rPlayer * 3.6, rPlayer * 3.6);
      pop();
    }

    // 点本体
    push();
    noStroke();
    const bodyCol = color(this.bodyColorHex);
    fill(bodyCol);
    ellipse(pos.x, pos.y, rPlayer * 2, rPlayer * 2);
    pop();
  }
}

// ===========================
// US <-> 玩家：靠近 / 进入（光晕 + 染色）
// ===========================
function updateUSAndPlayers() {
  for (const id in players) {
    const p = players[id];
    const pos = p.screenPos();

    usPoints.forEach(us => {
      const usPos = us.screenPos();
      const rUS = us.radiusPx();
      const d = p5.Vector.dist(pos, usPos);

      const inside = d < rUS;
      const nearOuter = d >= rUS && d < rUS * 2;
      const isParticipant = (us.currentGroup || []).includes(id);

      if (us.state === 'idle' || us.state === 'gathering' || us.state === 'lockback') {
        if (nearOuter || inside) {
          us.haloActive = true;
          p.setHalo(us.colorHex);
        }
        if (inside) {
          p.bodyColorHex = us.colorHex;
        }
      } else if (us.state === 'fusion') {
        // 捕捉期间：参与者即使离开 US 也保持该 US 颜色
        if (isParticipant) {
          p.bodyColorHex = us.colorHex;
          if (nearOuter || inside) {
            us.haloActive = true;
            p.setHalo(us.colorHex);
          }
        }
      }
    });
  }
}

// ===========================
// 静止 0.5 秒 → 黑白闪烁 + 指引组创建
// ===========================
function computeStillRelations(nowGlobal) {
  const stillCandidatesRaw = [];

  for (const id in players) {
    const p = players[id];
    p.updateMotionState(nowGlobal);

    if (p.isStill && p.stillSince && nowGlobal - p.stillSince >= 500) {
      stillCandidatesRaw.push(p);
    }
  }

  // 排除 US 内部静止
  const stillCandidates = stillCandidatesRaw.filter(p => !isInsideAnyUS(p));

  if (stillCandidates.length >= 2 && usPoints.length > 0) {
    const ids = stillCandidates.map(p => p.id).sort();

    // 已经完成全部 3 个 US 的组 → 不再闪烁、不指引
    if (hasGroupCompletedAllUS(ids)) {
      return;
    }

    // 选择该组下一步要去的 US：Yellow → Blue → Pink
    const us = chooseGuideUSForGroup(ids);
    if (!us) return;

    // 只有有目标 US 时才闪烁
    stillCandidates.forEach(p => {
      p.stillHighlight = true;
    });

    tryCreateGuideGroup(ids, us);
  }
}

// 判断玩家是否在任意 US 内
function isInsideAnyUS(player) {
  const pos = player.screenPos();
  for (const us of usPoints) {
    const usPos = us.screenPos();
    const r = us.radiusPx();
    const d = p5.Vector.dist(pos, usPos);
    if (d < r) return true;
  }
  return false;
}

// ===========================
// US 顺序：Yellow → Blue → Pink
// ===========================
function getUSPriority(us) {
  const name = (us.name || '').toLowerCase();
  if (name.includes('yellow')) return 0;
  if (name.includes('blue')) return 1;
  if (name.includes('pink')) return 2;
  return 3; // 其他放后面
}

function getOrderedUS() {
  return usPoints.slice().sort((a, b) => {
    const pa = getUSPriority(a);
    const pb = getUSPriority(b);
    if (pa !== pb) return pa - pb;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

// 某组是否已经一起完成某个 US（依据记忆线颜色）
function hasGroupCompletedUSTask(groupIds, colorHex) {
  if (groupIds.length < 2) return false;
  for (let i = 0; i < groupIds.length; i++) {
    for (let j = i + 1; j < groupIds.length; j++) {
      const a = groupIds[i];
      const b = groupIds[j];
      if (!hasCompletedLine(a, b, colorHex)) {
        return false;
      }
    }
  }
  return true;
}

// 某组是否已经完成全部 US（对每一个 US 都为 true）
function hasGroupCompletedAllUS(groupIds) {
  if (usPoints.length === 0) return false;
  const ordered = getOrderedUS();
  for (const us of ordered) {
    if (!hasGroupCompletedUSTask(groupIds, us.colorHex)) {
      return false;
    }
  }
  return true;
}

// 为一组玩家选择下一步要去的 US：顺序固定 Yellow → Blue → Pink
function chooseGuideUSForGroup(groupIds) {
  const ordered = getOrderedUS();
  for (const us of ordered) {
    if (!hasGroupCompletedUSTask(groupIds, us.colorHex)) {
      return us;
    }
  }
  return null;
}

// ===========================
// Guide group 管理（静止指引虚线）
// ===========================
function arraysEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function tryCreateGuideGroup(ids, us) {
  if (!us || !ids || ids.length < 2) return;
  const sorted = ids.slice().sort();

  // 如果这组已经完成过这个 US：不再出现指引
  if (hasGroupCompletedUSTask(sorted, us.colorHex)) return;

  // 同一组玩家在任意时刻只允许指向一个 US
  const existsAnyForGroup = guideGroups.some(g => arraysEqual(g.playerIds, sorted));
  if (existsAnyForGroup) return;

  // 避免重复创建同一组对同一个 US 的指引
  const existsSameUS = guideGroups.some(g => g.usId === us.id && arraysEqual(g.playerIds, sorted));
  if (existsSameUS) return;

  guideGroups.push({
    playerIds: sorted,
    usId: us.id,
    color: us.colorHex
  });
}

// 每帧更新 guideGroups：当组内所有玩家进入该 US 后，删除这一组指引
function updateGuideGroups() {
  if (guideGroups.length === 0) return;
  const updated = [];

  guideGroups.forEach(g => {
    const us = usPoints.find(u => u.id === g.usId);
    if (!us) return;
    const usPos = us.screenPos();
    const r = us.radiusPx();

    let allInside = true;
    for (const pid of g.playerIds) {
      const p = players[pid];
      if (!p) { allInside = false; break; }
      const pos = p.screenPos();
      const d = p5.Vector.dist(pos, usPos);
      if (d >= r) {
        allInside = false;
        break;
      }
    }

    if (!allInside) {
      updated.push(g);
    }
  });

  guideGroups = updated;
}

// ===========================
// 记忆线（完成任务后生成的实线）
// ===========================
function onUSTaskCompleted(groupIds, colorHex) {
  const sorted = groupIds.slice().sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      addCompletedLine(sorted[i], sorted[j], colorHex);
    }
  }
}

function addCompletedLine(aId, bId, colorHex) {
  const a = aId < bId ? aId : bId;
  const b = aId < bId ? bId : aId;

  const exists = completedLines.some(
    seg => seg.aId === a && seg.bId === b && seg.color === colorHex
  );
  if (!exists) {
    completedLines.push({ aId: a, bId: b, color: colorHex });
  }
}

function hasCompletedLine(aId, bId, colorHex) {
  const a = aId < bId ? aId : bId;
  const b = aId < bId ? bId : aId;
  return completedLines.some(
    seg => seg.aId === a && seg.bId === b && seg.color === colorHex
  );
}

// 把同一 pair 的多条线分组，在视觉上并排画出来
function drawCompletedLines() {
  const pairMap = {}; // pairKey -> { aId, bId, colors[] }

  completedLines.forEach(seg => {
    const a = seg.aId < seg.bId ? seg.aId : seg.bId;
    const b = seg.aId < seg.bId ? seg.bId : seg.aId;
    const key = a + '|' + b;
    if (!pairMap[key]) {
      pairMap[key] = { aId: a, bId: b, colors: [] };
    }
    if (!pairMap[key].colors.includes(seg.color)) {
      pairMap[key].colors.push(seg.color);
    }
  });

  for (const key in pairMap) {
    const info = pairMap[key];
    const pA = players[info.aId];
    const pB = players[info.bId];
    if (!pA || !pB) continue;

    const posA = pA.screenPos();
    const posB = pB.screenPos();
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const distAB = Math.sqrt(dx * dx + dy * dy);
    if (distAB === 0) continue;

    // 垂直方向单位向量，用于把多条线错开
    const nx = -dy / distAB;
    const ny = dx / distAB;

    const strokeW = 3.5;
    const offsetStep = strokeW * 3;

    const colors = info.colors;
    const n = colors.length;
    for (let i = 0; i < n; i++) {
      const offset = (i - (n - 1) / 2) * offsetStep;
      const offx = nx * offset;
      const offy = ny * offset;

      push();
      const c = color(colors[i]);
      stroke(c);
      strokeWeight(strokeW);
      line(posA.x + offx, posA.y + offy, posB.x + offx, posB.y + offy);
      pop();
    }
  }
}

// ===========================
// 虚线绘制工具
// ===========================
function drawDashedLine(x1, y1, x2, y2, dashLen, gapLen, col, alpha, weight) {
  push();
  let c = color(col);
  if (alpha !== undefined) c.setAlpha(alpha);
  stroke(c);
  strokeWeight(weight || 3);
  noFill();

  const dx = x2 - x1;
  const dy = y2 - y1;
  const distAll = Math.sqrt(dx * dx + dy * dy);
  if (distAll === 0) {
    pop();
    return;
  }
  const vx = dx / distAll;
  const vy = dy / distAll;

  let drawn = 0;
  while (drawn < distAll) {
    const xStart = x1 + vx * drawn;
    const yStart = y1 + vy * drawn;
    const segLen = min(dashLen, distAll - drawn);
    const xEnd = x1 + vx * (drawn + segLen);
    const yEnd = y1 + vy * (drawn + segLen);
    line(xStart, yStart, xEnd, yEnd);
    drawn += dashLen + gapLen;
  }

  pop();
}

// ===========================
// 静止指引虚线：玩家 ↔ 玩家 + 玩家 → US
// ===========================
function drawStillGuides() {
  guideGroups.forEach(g => {
    const us = usPoints.find(u => u.id === g.usId);
    if (!us) return;
    const uPos = us.screenPos();
    const colorHex = g.color;

    // 玩家 → US
    g.playerIds.forEach(pid => {
      const p = players[pid];
      if (!p) return;
      const pos = p.screenPos();
      drawDashedLine(
        pos.x, pos.y,
        uPos.x, uPos.y,
        10, 6,
        colorHex,
        180,
        3
      );
    });

    // 玩家 ↔ 玩家
    for (let i = 0; i < g.playerIds.length; i++) {
      for (let j = i + 1; j < g.playerIds.length; j++) {
        const p1 = players[g.playerIds[i]];
        const p2 = players[g.playerIds[j]];
        if (!p1 || !p2) continue;
        const pos1 = p1.screenPos();
        const pos2 = p2.screenPos();
        drawDashedLine(
          pos1.x, pos1.y,
          pos2.x, pos2.y,
          10, 6,
          colorHex,
          180,
          3
        );
      }
    }
  });
}

// ===========================
// US 内部任务倒计时（fusion）：白色整数
// ===========================
function drawFusionCountdown(nowGlobal) {
  usPoints.forEach(us => {
    if (us.state !== 'fusion') return;
    const remainMs = us.fusionRemaining(nowGlobal);
    if (remainMs <= 0) return;

    const remainSec = Math.ceil(remainMs / 1000);
    const pos = us.screenPos();
    const r = us.radiusPx();

    push();
    fill(255);
    noStroke();
    textAlign(CENTER, CENTER);
    textSize(r);
    text(remainSec, pos.x, pos.y);
    pop();
  });
}

// ===========================
// 顶部提示：gathering / fusion / lockback 文案
// ===========================
function drawTopMessages(nowGlobal) {
  if (usPoints.length === 0) return;

  const maxR = usPoints.reduce((acc, u) => max(acc, u.radiusPx()), 0);
  const baseSize = maxR * 0.5;
  const lineHeight = baseSize * 1.2;

  const messages = [];

  usPoints.forEach(us => {
    if (us.state === 'gathering') {
      const remainMs = us.gatheringRemaining(nowGlobal);
      let remainSec = Math.ceil(remainMs / 1000);
      if (remainSec > 5) remainSec = 5;
      if (remainSec > 0) {
        messages.push(`${remainSec}s left before ${us.name} us stops accepting new players`);
      }
    }

    if (us.state === 'fusion') {
      const elapsedSec = us.fusionElapsed(nowGlobal) / 1000;
      if (elapsedSec >= 1) {
        messages.push('Try to collect them together');
      }
    }

    if (us.state === 'lockback' && us.lastRoundId != null) {
      const stats = computeLockbackStats(us);
      // 🔴 改动：只要有至少 1 个玩家有数据就显示
      if (stats && stats.total > 0 && stats.numPlayers >= 1) {
        const col = color(us.colorHex);
        push();
        textAlign(CENTER, TOP);
        textSize(baseSize);
        fill(col);
        noStroke();
        const txt = `At ${us.name} us, you captured ${stats.total} match dots together`;
        text(txt, width / 2, 10);
        pop();
        return; // 已经画了主标题，就不叠加其他 message
      }
    }
  });

  if (messages.length === 0) return;

  push();
  fill(0);
  noStroke();
  textAlign(CENTER, TOP);
  textSize(baseSize);
  const startY = 10;
  messages.forEach((msg, i) => {
    text(msg, width / 2, startY + i * lineHeight);
  });
  pop();
}

// ================
// match 快照 & 统计
// ================
function snapshotMatchDotsForUS(usId, roundId) {
  if (!matchDots || matchDots.length === 0) return;
  const key = `${usId}|${roundId}`;
  if (matchDotsSnapshots[key]) return; // 已经有快照就不重复

  const snapshot = matchDots
    .filter(d =>
      d.state === 'captured' &&
      d.usId === usId &&
      d.roundId === roundId &&
      d.capturedById
    )
    .map(d => ({ ...d })); // 浅拷贝一份

  matchDotsSnapshots[key] = snapshot;
}

// 统计某个 US 最近一轮 lockback 的总数 & per-player 数量
function computeLockbackStats(us) {
  if (us.lastRoundId == null) return null;
  const roundId = us.lastRoundId;

  // 优先使用快照，如果没有快照，再退回当前 matchDots
  const key = `${us.id}|${roundId}`;
  let sourceDots = matchDotsSnapshots[key];
  if (!sourceDots || sourceDots.length === 0) {
    sourceDots = matchDots;
  }

  if (!sourceDots || sourceDots.length === 0) return null;

  const counts = {};
  let total = 0;

  sourceDots.forEach(d => {
    if (
      d.state === 'captured' &&
      d.usId === us.id &&
      d.roundId === roundId &&
      d.capturedById
    ) {
      counts[d.capturedById] = (counts[d.capturedById] || 0) + 1;
      total++;
    }
  });

  const entries = Object.keys(counts).map(pid => ({
    playerId: pid,
    count: counts[pid]
  }));

  entries.sort((a, b) => b.count - a.count);

  return {
    total,
    entries,
    numPlayers: entries.length
  };
}

// 右侧排行榜（单个玩家捕捉数量排行）
function drawLockbackRanking() {
  const us = usPoints.find(u => u.state === 'lockback' && u.lastRoundId != null);
  if (!us) return;

  const stats = computeLockbackStats(us);
  // 🔴 改动：只要有至少 1 条记录就显示 Top 1
  if (!stats || stats.total <= 0 || stats.entries.length < 1) return;

  const col = color(us.colorHex);
  const maxEntries = 10;
  const list = stats.entries.slice(0, maxEntries);

  const marginRight = 20;
  const marginTop = 80;
  const lineH = 22;
  const boxWidth = 220;
  const boxHeight = lineH * (list.length + 2);

  const x = width - marginRight - boxWidth;
  const y = marginTop;

  push();
  rectMode(CORNER);
  noStroke();
  fill(255, 240);
  rect(x, y, boxWidth, boxHeight, 10);

  fill(col);
  textAlign(LEFT, TOP);
  textSize(16);
  text(`Top collectors @ ${us.name}`, x + 12, y + 8);

  fill(0);
  textSize(14);
  list.forEach((e, i) => {
    const pidShort = e.playerId.slice(0, 4).toUpperCase();
    const rank = i + 1;
    const line = `${rank}. Player ${pidShort} - ${e.count}`;
    text(line, x + 12, y + 8 + (i + 1) * lineH);
  });

  pop();
}

// ===========================
// match 绘制：free + 鞭子/水草尾巴
// ===========================
function drawMatchDots(nowGlobal) {
  if (!matchDots || matchDots.length === 0) return;

  const rPlayer = getPlayerRadiusPx();
  const rDot = rPlayer / 3; // match 点大小 ≈ 之前的 1/3

  // 当前 fusion US 的颜色
  let fusionColor = null;
  if (matchActive && matchFusionUSId && usPoints.length > 0) {
    const u = usPoints.find(u => u.id === matchFusionUSId);
    if (u) {
      fusionColor = (u.colorHex || u.color || '').toLowerCase();
    }
  }

  // 当前帧存在的 dotId，用于清理旧的可视缓存
  const currentDotIds = new Set();
  matchDots.forEach(d => currentDotIds.add(d.id));
  for (const dotId in matchVisualPositions) {
    if (!currentDotIds.has(dotId)) {
      delete matchVisualPositions[dotId];
    }
  }

  // -------- free dots：飘在屏幕上的小点 --------
  matchDots.forEach(d => {
    if (d.state !== 'free') return;

    const x = d.xRel * width;
    const y = d.yRel * height;

    const isActiveColor =
      fusionColor &&
      (d.colorHex || '').toLowerCase() === fusionColor;

    // 高亮当前 US 颜色的 free 点
    if (isActiveColor) {
      push();
      const haloCol = color(d.colorHex);
      haloCol.setAlpha(70);
      noStroke();
      fill(haloCol);
      ellipse(x, y, rDot * 3, rDot * 3);
      pop();
    }

    push();
    const c = color(d.colorHex);
    noStroke();
    fill(c);
    ellipse(x, y, rDot * 2, rDot * 2);
    pop();
  });

  // -------- captured dots：按玩家分组，做“鞭子”尾巴 --------
  const dotsByPlayer = {};
  matchDots.forEach(d => {
    if (d.state === 'captured' && d.capturedById) {
      if (!dotsByPlayer[d.capturedById]) dotsByPlayer[d.capturedById] = [];
      dotsByPlayer[d.capturedById].push(d);
    }
  });

  for (const pid in dotsByPlayer) {
    const owner = players[pid];
    if (!owner) continue;

    let list = dotsByPlayer[pid];
    // 为了每个 match 点在鞭子中的顺序稳定，按 id 排一下
    list = list.slice().sort((a, b) => (a.id < b.id ? -1 : 1));

    const n = list.length;
    if (n === 0) continue;

    const center = owner.screenPos();

    // 使用玩家当前记录的尾巴方向（屏幕坐标）
    let tailDirVec;
    if (owner.tailDir && (owner.tailDir.x !== 0 || owner.tailDir.y !== 0)) {
      tailDirVec = createVector(owner.tailDir.x, owner.tailDir.y);
    } else {
      // 默认一个方向，避免零向量
      tailDirVec = createVector(-1, 0);
    }
    if (tailDirVec.magSq() === 0) {
      tailDirVec.set(-1, 0);
    }
    tailDirVec.normalize();

    // 鞭子的参数：距离 & 间距 & 惯性
    const startDist = rPlayer * 0.9;   // 第一个 match 点离玩家的距离
    const spacing = rDot * 1.8;        // 每个 match 点之间的距离（避免重叠）
    const followSpeed = 0.25;          // 越小越“粘稠”、越有惯性

    // 第一个 segment 的目标位置：从玩家位置沿 tailDir 拉开
    let targetX = center.x + tailDirVec.x * startDist;
    let targetY = center.y + tailDirVec.y * startDist;

    for (let i = 0; i < n; i++) {
      const d = list[i];

      // 从缓存里拿上一帧的位置，做插值 → 有惯性，像鞭子一样甩动
      const prevPos = matchVisualPositions[d.id];
      let newX, newY;
      if (!prevPos) {
        newX = targetX;
        newY = targetY;
      } else {
        newX = lerp(prevPos.x, targetX, followSpeed);
        newY = lerp(prevPos.y, targetY, followSpeed);
      }

      matchVisualPositions[d.id] = { x: newX, y: newY };

      const isActiveColor =
        fusionColor &&
        (d.colorHex || '').toLowerCase() === fusionColor;

      if (isActiveColor) {
        push();
        const haloCol = color(d.colorHex);
        haloCol.setAlpha(60);
        noStroke();
        fill(haloCol);
        ellipse(newX, newY, rDot * 3, rDot * 3);
        pop();
      }

      push();
      const c = color(d.colorHex);
      noStroke();
      fill(c);
      ellipse(newX, newY, rDot * 2, rDot * 2);
      pop();

      // 下一段的目标位置：在当前 segment 的基础上继续沿 tailDir 延伸
      targetX = newX + tailDirVec.x * spacing;
      targetY = newY + tailDirVec.y * spacing;
    }
  }
}
