// bLEDsport External Server
// Receives binary game state from the local game server via WebSocket,
// re-broadcasts to browser spectators, and relays spectator inputs back.

const spectators = new Set<any>();
let gameServerWs: any = null;
let latestState: Buffer | null = null;

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
      } else {
        spectators.add(ws);
        ws.send(JSON.stringify({ type: "spectating" }));
        // Send latest binary state so they don't see a blank screen
        if (latestState) ws.send(latestState);
        console.log(`Spectator connected (${spectators.size} total)`);
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
      }
    },
  },
});

console.log(`External server running at http://localhost:${server.port}`);
