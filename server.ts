// bLEDsport External Server
// Receives binary game state from the local game server via WebSocket,
// re-broadcasts to browser spectators, and relays spectator inputs back.

const spectators = new Set<any>();
let gameServerWs: any = null;
let latestState: Buffer | null = null;

// --- Orb simulation state (relay-authoritative, normalized 0..1 coords) ---
const ORB = {
  TICK_MS: 33,           // ~30 Hz sim + broadcast
  SPAWN_MIN_MS: 5000,
  SPAWN_MAX_MS: 8000,
  MAX_COUNT: 3,
  LIFETIME_MS: 12000,
  DRIFT_SPEED: 0.0004,   // normalized units per tick
  CENTER_PULL: 0.0006,
  FLING_K: 0.10,         // launch vel = pull(normalized) * FLING_K
  MAX_SPEED: 0.035,      // normalized units per tick
  FRICTION: 0.992,
  STALL_SPEED: 0.002,
  MIN_PULL: 0.02,        // normalized pull below this = mis-grab
  GLOW_RADIUS_FRAC: 0.25,
  GLOW_THROTTLE_MS: 100,
};

type Orb = {
  id: number; x: number; y: number; vx: number; vy: number;
  state: 'drifting' | 'held' | 'flying';
  bornAt: number; heldBy: number | null; lastGlowAt: number;
  anchorX: number; anchorY: number; pullX: number; pullY: number;
};

const orbs: Orb[] = [];
let nextOrbId = 1;
let nextSpectatorId = 1;
let orbTimer: any = null;
let nextSpawnAt = 0;

function notifySpectatorCount() {
  if (gameServerWs) {
    gameServerWs.send(JSON.stringify({ type: "spectators", count: spectators.size }));
  }
}

const NUM_LEDS = 192;
// Map a normalized edge-exit point to an arch LED index. -1 = bottom (wasted).
function edgeToLed(x: number, y: number): number {
  const overLeft = -x, overRight = x - 1, overTop = -y, overBottom = y - 1;
  const m = Math.max(overLeft, overRight, overTop, overBottom);
  if (m === overBottom) return -1;
  if (m === overLeft) {
    const t = Math.min(1, Math.max(0, y));
    return Math.round((1 - t) * 57);
  }
  if (m === overTop) {
    const t = Math.min(1, Math.max(0, x));
    return 58 + Math.round(t * (134 - 58));
  }
  const t = Math.min(1, Math.max(0, y));
  return 135 + Math.round(t * (191 - 135));
}

function spawnOrb() {
  const j = () => (Math.random() - 0.5);
  orbs.push({
    id: nextOrbId++,
    x: 0.5 + j() * 0.2, y: 0.5 + j() * 0.2,
    vx: j() * ORB.DRIFT_SPEED, vy: j() * ORB.DRIFT_SPEED,
    state: 'drifting', bornAt: Date.now(), heldBy: null, lastGlowAt: 0,
    anchorX: 0, anchorY: 0, pullX: 0, pullY: 0,
  });
}

function sendToGame(msg: any) {
  if (gameServerWs) gameServerWs.send(JSON.stringify(msg));
}

function orbTick() {
  const now = Date.now();
  if (now >= nextSpawnAt && orbs.length < ORB.MAX_COUNT) {
    spawnOrb();
    nextSpawnAt = now + ORB.SPAWN_MIN_MS + Math.random() * (ORB.SPAWN_MAX_MS - ORB.SPAWN_MIN_MS);
  }
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    if (o.state === 'drifting') {
      o.vx += (0.5 - o.x) * ORB.CENTER_PULL;
      o.vy += (0.5 - o.y) * ORB.CENTER_PULL;
      o.x += o.vx; o.y += o.vy;
      if (now - o.bornAt > ORB.LIFETIME_MS) orbs.splice(i, 1);
    } else if (o.state === 'flying') {
      o.x += o.vx; o.y += o.vy;
      o.vx *= ORB.FRICTION; o.vy *= ORB.FRICTION;
      if (o.x < 0 || o.x > 1 || o.y < 0 || o.y > 1) {
        const led = edgeToLed(o.x, o.y);
        if (led >= 0) sendToGame({ type: 'god_bomb', pos: led });
        orbs.splice(i, 1);
        continue;
      }
      if (Math.hypot(o.vx, o.vy) < ORB.STALL_SPEED) {
        o.state = 'drifting'; o.bornAt = now; continue;
      }
      const edgeDist = Math.min(o.x, 1 - o.x, o.y); // nearest non-bottom edge
      if (edgeDist <= ORB.GLOW_RADIUS_FRAC && now - o.lastGlowAt >= ORB.GLOW_THROTTLE_MS) {
        // predict the LED for the nearest non-bottom edge by clamping toward it
        let ex = o.x, ey = o.y;
        if (edgeDist === o.x) ex = 0; else if (edgeDist === 1 - o.x) ex = 1; else ey = 0;
        const led = edgeToLed(ex, ey);
        if (led >= 0) {
          const intensity = 1 - edgeDist / ORB.GLOW_RADIUS_FRAC;
          sendToGame({ type: 'orb_glow', pos: led, intensity });
          o.lastGlowAt = now;
        }
      }
    }
  }
  broadcastOrbs();
}

function broadcastOrbs() {
  const payload = JSON.stringify({
    type: 'orb_state',
    orbs: orbs.map(o => ({
      id: o.id, x: o.x, y: o.y, state: o.state, heldBy: o.heldBy,
      anchorX: o.anchorX, anchorY: o.anchorY, pullX: o.pullX, pullY: o.pullY,
    })),
  });
  for (const s of spectators) s.send(payload);
}

function startOrbSim() {
  if (orbTimer) return;
  nextSpawnAt = Date.now() + 1000;
  orbTimer = setInterval(orbTick, ORB.TICK_MS);
}

function stopOrbSim() {
  if (orbTimer) { clearInterval(orbTimer); orbTimer = null; }
  orbs.length = 0;
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  fetch(req, server) {
    const url = new URL(req.url);

    // Game server upstream connection
    if (url.pathname === "/ws/game") {
      const auth = url.searchParams.get("key");
      if (auth !== (process.env.GAME_SERVER_KEY || "bledsport")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (server.upgrade(req, { data: { role: "game" } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Browser spectator connection
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { role: "spectator" } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        gameServerConnected: gameServerWs !== null,
        spectators: spectators.size,
      });
    }

    // Serve the spectator page
    return new Response(Bun.file(new URL("./index.html", import.meta.url).pathname));
  },
  websocket: {
    open(ws) {
      const role = (ws.data as any).role;
      if (role === "game") {
        gameServerWs = ws;
        console.log("Game server connected");
        notifySpectatorCount();
      } else {
        (ws.data as any).id = nextSpectatorId++;
        spectators.add(ws);
        ws.send(JSON.stringify({ type: "spectating" }));
        if (latestState) ws.send(latestState);
        console.log(`Spectator connected (${spectators.size} total)`);
        notifySpectatorCount();
        startOrbSim();
      }
    },
    message(ws, message) {
      const role = (ws.data as any).role;
      if (role === "game") {
        // Game server sending binary state — pass through to all spectators
        const buf = typeof message === "string" ? Buffer.from(message) : Buffer.from(message);
        latestState = buf;
        for (const s of spectators) {
          s.send(buf);
        }
      } else {
        let input: any = null;
        try { input = JSON.parse(typeof message === "string" ? message : message.toString()); } catch {}
        const sid = (ws.data as any).id;
        if (input && input.type === 'orb_claim') {
          const o = orbs.find(o => o.id === input.id);
          if (o && o.heldBy == null && o.state !== 'flying') {
            o.heldBy = sid; o.state = 'held';
            o.anchorX = o.x; o.anchorY = o.y; o.pullX = o.x; o.pullY = o.y;
            o.vx = 0; o.vy = 0;
          }
        } else if (input && input.type === 'orb_drag') {
          const o = orbs.find(o => o.id === input.id);
          if (o && o.heldBy === sid) {
            o.pullX = input.x; o.pullY = input.y; o.x = input.x; o.y = input.y;
          }
        } else if (input && input.type === 'orb_release') {
          const o = orbs.find(o => o.id === input.id);
          if (o && o.heldBy === sid) {
            o.heldBy = null;
            const dx = o.pullX - o.anchorX, dy = o.pullY - o.anchorY;
            const pullLen = Math.hypot(dx, dy);
            o.x = o.anchorX; o.y = o.anchorY;
            if (pullLen < ORB.MIN_PULL) { o.state = 'drifting'; o.bornAt = Date.now(); }
            else {
              let vx = -dx * ORB.FLING_K, vy = -dy * ORB.FLING_K;
              const sp = Math.hypot(vx, vy);
              if (sp > ORB.MAX_SPEED) { vx = vx / sp * ORB.MAX_SPEED; vy = vy / sp * ORB.MAX_SPEED; }
              o.vx = vx; o.vy = vy; o.state = 'flying';
            }
          }
        } else if (gameServerWs) {
          gameServerWs.send(message);
        }
      }
    },
    close(ws) {
      const role = (ws.data as any).role;
      if (role === "game") {
        gameServerWs = null;
        console.log("Game server disconnected");
      } else {
        spectators.delete(ws);
        const id = (ws.data as any).id;
        for (const o of orbs) if (o.heldBy === id) { o.heldBy = null; o.state = 'drifting'; o.bornAt = Date.now(); }
        console.log(`Spectator disconnected (${spectators.size} total)`);
        notifySpectatorCount();
        if (spectators.size === 0) stopOrbSim();
      }
    },
  },
});

console.log(`External server running at http://localhost:${server.port}`);
