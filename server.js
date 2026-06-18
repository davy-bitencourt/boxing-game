const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css" };

const httpServer = http.createServer((req, res) => {
  const url      = req.url === "/" ? "/index.html" : req.url;
  const ext      = path.extname(url);
  const filePath = path.join(__dirname, url);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

const MAX_PLAYERS = 15;
const TICK_RATE = 60; // ms
const WORLD_W = 1600;
const WORLD_H = 1200;
const PLAYER_RADIUS = 18;
const FIST_RADIUS = 8;
const FIST_REACH = 38;
const FIST_OFFSET = 14; // lateral offset from center
const PUNCH_DAMAGE = 10;
const PUNCH_COOLDOWN = 400; // ms
const MAX_HP = 100;
const MOVE_SPEED = 20;

// Ringue (área central, puramente visual por enquanto — não limita o movimento)
const RING_SIZE = 700;
const RING_X = (WORLD_W - RING_SIZE) / 2;
const RING_Y = (WORLD_H - RING_SIZE) / 2;

// Knockback
const PUNCH_KNOCKBACK = 5; // empurrão leve de um soco normal
const PUSH_KNOCKBACK = 26; // empurrão forte (os dois botões juntos)
const KNOCKBACK_DECAY = 0.85; // o quanto a velocidade decai por tick

// Empurrão de duas mãos (push)
const PUSH_REACH = 30; // alcance frontal do empurrão
const PUSH_RADIUS = 24; // "largura" da hitbox do empurrão
const PUSH_COOLDOWN = 600; // ms
const PUSH_ACTIVE_TIME = 150; // ms

// Colisão entre jogadores
const PUSH_STRENGTH = 0.5; // 0..1, o quanto resolve o overlap por tick
const wss = new WebSocket.Server({ server: httpServer });
const players = new Map(); // id -> player state

let nextId = 1;

function createPlayer(id, name, color) {
  return {
    id,
    name: name.slice(0, 16),
    color,
    x: RING_X + PLAYER_RADIUS + 20 + Math.random() * (RING_SIZE - 2 * PLAYER_RADIUS - 40),
    y: RING_Y + PLAYER_RADIUS + 20 + Math.random() * (RING_SIZE - 2 * PLAYER_RADIUS - 40),
    angle: 0, // radians, direction player is facing
    hp: MAX_HP,
    // knockback velocity (decai a cada tick)
    vx: 0,
    vy: 0,
    // input state
    keys: { up: false, down: false, left: false, right: false },
    // punch animation state
    leftPunch: { active: false, timer: 0, cooldown: 0 },
    rightPunch: { active: false, timer: 0, cooldown: 0 },
    // empurrão de duas mãos (os dois botões pressionados ao mesmo tempo)
    push: { active: false, timer: 0, cooldown: 0, hitThisPush: false },
  };
}

function fistWorldPos(player, side) {
  // side: 'left' | 'right'
  const sign = side === "left" ? -1 : 1;
  const lateralAngle = player.angle + Math.PI / 2;
  const forwardAngle = player.angle;

  const punch = side === "left" ? player.leftPunch : player.rightPunch;
  const extension = punch.active ? FIST_REACH : FIST_REACH * 0.5;

  return {
    x:
      player.x +
      Math.cos(forwardAngle) * extension +
      Math.cos(lateralAngle) * FIST_OFFSET * sign,
    y:
      player.y +
      Math.sin(forwardAngle) * extension +
      Math.sin(lateralAngle) * FIST_OFFSET * sign,
  };
}

function pushWorldPos(player) {
  // Ponto na frente do jogador, na direção que ele está virado
  return {
    x: player.x + Math.cos(player.angle) * PUSH_REACH,
    y: player.y + Math.sin(player.angle) * PUSH_REACH,
  };
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function killPlayer(id) {
  const entry = [...wss.clients].find((ws) => ws.playerId === id);
  players.delete(id);
  broadcast({ type: "player_left", id });
  if (entry) {
    sendTo(entry, { type: "you_died" });
    setTimeout(() => entry.close(), 300);
  }
}

// Game loop
setInterval(() => {
  for (const [id, p] of players) {
    // Movement (input do jogador)
    let dx = 0,
      dy = 0;
    if (p.keys.up) dy -= MOVE_SPEED;
    if (p.keys.down) dy += MOVE_SPEED;
    if (p.keys.left) dx -= MOVE_SPEED;
    if (p.keys.right) dx += MOVE_SPEED;

    if (dx !== 0 && dy !== 0) {
      dx *= 0.707;
      dy *= 0.707;
    }

    // Soma o knockback (velocidade de impacto) ao deslocamento
    dx += p.vx;
    dy += p.vy;

    // Decai a velocidade de knockback pro próximo tick
    p.vx *= KNOCKBACK_DECAY;
    p.vy *= KNOCKBACK_DECAY;
    if (Math.abs(p.vx) < 0.05) p.vx = 0;
    if (Math.abs(p.vy) < 0.05) p.vy = 0;

    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_W - PLAYER_RADIUS, p.x + dx));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_H - PLAYER_RADIUS, p.y + dy));

    // Punch timers
    for (const side of ["left", "right"]) {
      const punch = side === "left" ? p.leftPunch : p.rightPunch;
      if (punch.active) {
        punch.timer -= TICK_RATE;
        if (punch.timer <= 0) {
          punch.active = false;
          punch.cooldown = PUNCH_COOLDOWN;
        }
      } else if (punch.cooldown > 0) {
        punch.cooldown -= TICK_RATE;
      }
    }

    // Push timer (empurrão de duas mãos)
    if (p.push.active) {
      p.push.timer -= TICK_RATE;
      if (p.push.timer <= 0) {
        p.push.active = false;
        p.push.cooldown = PUSH_COOLDOWN;
      }
    } else if (p.push.cooldown > 0) {
      p.push.cooldown -= TICK_RATE;
    }
  }

  // Resolução de colisão entre jogadores (push-apart simples)
  const ids = [...players.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = players.get(ids[i]);
      const b = players.get(ids[j]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const minDist = PLAYER_RADIUS * 2;
      if (d < minDist) {
        const overlap = (minDist - d) * PUSH_STRENGTH;
        const nx = dx / d;
        const ny = dy / d;
        a.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_W - PLAYER_RADIUS, a.x - nx * overlap * 0.5));
        a.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_H - PLAYER_RADIUS, a.y - ny * overlap * 0.5));
        b.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_W - PLAYER_RADIUS, b.x + nx * overlap * 0.5));
        b.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_H - PLAYER_RADIUS, b.y + ny * overlap * 0.5));
      }
    }
  }

  for (const [id, p] of players) {
    // Saiu do ringue = eliminado na hora
    const outOfRing =
      p.x < RING_X || p.x > RING_X + RING_SIZE ||
      p.y < RING_Y || p.y > RING_Y + RING_SIZE;
    if (outOfRing) {
      killPlayer(id);
      continue;
    }

    // Check fists hitting other players
    for (const side of ["left", "right"]) {
      const punch = side === "left" ? p.leftPunch : p.rightPunch;
      if (!punch.active || punch.hitThisPunch) continue;

      const fist = fistWorldPos(p, side);
      for (const [otherId, other] of players) {
        if (otherId === id) continue;
        if (dist(fist.x, fist.y, other.x, other.y) < PLAYER_RADIUS + FIST_RADIUS) {
          punch.hitThisPunch = true;
          other.hp = Math.max(0, other.hp - PUNCH_DAMAGE);

          // Knockback leve: empurra a vítima na direção atacante -> vítima
          const kx = other.x - p.x;
          const ky = other.y - p.y;
          const kd = Math.hypot(kx, ky) || 0.001;
          other.vx += (kx / kd) * PUNCH_KNOCKBACK;
          other.vy += (ky / kd) * PUNCH_KNOCKBACK;

          broadcast({ type: "hit", victim: otherId, attacker: id, hp: other.hp });
          if (other.hp <= 0) killPlayer(otherId);
          break;
        }
      }
    }

    // Check push (empurrão de duas mãos) hitting other players
    if (p.push.active && !p.push.hitThisPush) {
      const shove = pushWorldPos(p);
      for (const [otherId, other] of players) {
        if (otherId === id) continue;
        if (dist(shove.x, shove.y, other.x, other.y) < PLAYER_RADIUS + PUSH_RADIUS) {
          p.push.hitThisPush = true;

          // Knockback forte, sem dano
          const kx = other.x - p.x;
          const ky = other.y - p.y;
          const kd = Math.hypot(kx, ky) || 0.001;
          other.vx += (kx / kd) * PUSH_KNOCKBACK;
          other.vy += (ky / kd) * PUSH_KNOCKBACK;

          broadcast({ type: "pushed", victim: otherId, attacker: id });
          break;
        }
      }
    }
  }

  // Broadcast state
  const state = [];
  for (const [, p] of players) {
    state.push({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      angle: p.angle,
      hp: p.hp,
      leftPunch: p.leftPunch.active,
      rightPunch: p.rightPunch.active,
      pushing: p.push.active,
    });
  }
  if (state.length > 0) broadcast({ type: "state", players: state });
}, TICK_RATE);

wss.on("connection", (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: "error", msg: "Servidor cheio (max 15 jogadores)" }));
    ws.close();
    return;
  }

  // Wait for join message
  ws.once("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.close();
      return;
    }

    if (msg.type !== "join" || !msg.name || !msg.color) {
      ws.close();
      return;
    }

    const id = nextId++;
    ws.playerId = id;
    const player = createPlayer(id, msg.name, msg.color);
    players.set(id, player);

    sendTo(ws, {
      type: "welcome",
      id,
      worldW: WORLD_W,
      worldH: WORLD_H,
      playerRadius: PLAYER_RADIUS,
      fistRadius: FIST_RADIUS,
      ring: { x: RING_X, y: RING_Y, size: RING_SIZE },
    });

    broadcast({ type: "player_joined", id, name: player.name, color: player.color });

    // Input messages
    ws.on("message", (raw2) => {
      let m;
      try {
        m = JSON.parse(raw2);
      } catch {
        return;
      }

      const p = players.get(id);
      if (!p) return;

      if (m.type === "input") {
        if (m.keys) p.keys = m.keys;
        if (typeof m.angle === "number") p.angle = m.angle;

        const bothPressed = !!m.punchLeft && !!m.punchRight;

        if (bothPressed) {
          // Empurrão de duas mãos: dispara push, ignora socos individuais
          if (!p.push.active && p.push.cooldown <= 0) {
            p.push.active = true;
            p.push.timer = PUSH_ACTIVE_TIME;
            p.push.hitThisPush = false;
          }
        } else {
          // Socos individuais (comportamento normal)
          for (const side of ["left", "right"]) {
            const punching = side === "left" ? m.punchLeft : m.punchRight;
            const punch = side === "left" ? p.leftPunch : p.rightPunch;
            if (punching && !punch.active && punch.cooldown <= 0) {
              punch.active = true;
              punch.timer = 150; // ms punch is "extended"
              punch.hitThisPunch = false;
            }
          }
        }
      }
    });

    ws.on("close", () => {
      players.delete(id);
      broadcast({ type: "player_left", id });
    });
  });
});

httpServer.listen(PORT, () => {
  console.log(`server rodando em http://localhost:${PORT}`);
});