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
        // Spectator sending JSON input — forward to game server
        if (gameServerWs) {
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
        console.log(`Spectator disconnected (${spectators.size} total)`);
        notifySpectatorCount();
      }
    },
  },
});

console.log(`External server running at http://localhost:${server.port}`);
