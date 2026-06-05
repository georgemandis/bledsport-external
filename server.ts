// bLEDsport External Server
// Receives game state from the local game server via WebSocket,
// re-broadcasts to browser spectators, and relays spectator inputs back.

const spectators = new Set<any>();
let gameServerWs: any = null;
let latestState: string | null = null;

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
        // Send latest state so they don't see a blank screen
        if (latestState) ws.send(latestState);
        console.log(`Spectator connected (${spectators.size} total)`);
      }
    },
    message(ws, message) {
      const role = (ws.data as any).role;
      if (role === "game") {
        // Game server sending state — broadcast to all spectators
        const data = typeof message === "string" ? message : Buffer.from(message).toString();
        latestState = data;
        for (const s of spectators) {
          s.send(data);
        }
      } else {
        // Spectator sending input — forward to game server
        if (gameServerWs) {
          const data = typeof message === "string" ? message : Buffer.from(message).toString();
          gameServerWs.send(data);
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
