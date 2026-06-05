import { createSocket } from "node:dgram";

// --- WLED connection (DDP over UDP) ---
const WLED_HOST = "10.100.3.132";
const WLED_DDP_PORT = 4048;
const NUM_LEDS = 192;

const ddpSocket = createSocket("udp4");
ddpSocket.on("error", (err) => console.log("DDP socket error:", err.message));
let ddpSeq = 0;
let ledsOn = false;

function sendToWled(pixels: [number, number, number][]) {
  const dataLen = NUM_LEDS * 3;
  ddpSeq = (ddpSeq % 15) + 1;

  const buf = Buffer.alloc(10 + dataLen);
  buf[0] = 0x41; // VER1 | PUSH
  buf[1] = ddpSeq;
  buf[2] = 0x01; // RGB, 8bpc
  buf[3] = 0x01; // source ID
  buf.writeUInt32BE(0, 4); // offset
  buf.writeUInt16BE(dataLen, 8); // length

  for (let i = 0; i < NUM_LEDS; i++) {
    const off = 10 + i * 3;
    const c = pixels[i] ?? [0, 0, 0];
    buf[off] = Math.max(0, Math.min(255, Math.round(c[0])));
    buf[off + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
    buf[off + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
  }

  ddpSocket.send(buf, WLED_DDP_PORT, WLED_HOST);
}

function setAllPixels(r: number, g: number, b: number) {
  const pixels: [number, number, number][] = Array.from({ length: NUM_LEDS }, () => [r, g, b]);
  sendToWled(pixels);
}

const server = Bun.serve({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) {
        return;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes
    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/api/leds/toggle" && req.method === "POST") {
      ledsOn = !ledsOn;
      if (ledsOn) {
        setAllPixels(255, 105, 180); // pink
      } else {
        setAllPixels(0, 0, 0); // off
      }
      return Response.json({ ledsOn });
    }

    // Serve static HTML page
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>bLEDsport</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    #log { background: #111; color: #0f0; padding: 16px; border-radius: 8px; min-height: 200px; font-family: monospace; white-space: pre-wrap; overflow-y: auto; max-height: 400px; }
    button { margin-top: 12px; padding: 8px 16px; cursor: pointer; }
    #led-btn { font-size: 1.2em; padding: 12px 24px; }
    #led-btn.on { background: hotpink; color: white; }
  </style>
</head>
<body>
  <h1>bLEDsport</h1>
  <p>Server is running.</p>

  <h2>LED Control</h2>
  <button id="led-btn" onclick="toggleLeds()">Turn Pink</button>

  <h2>WebSocket Test</h2>
  <div id="log"></div>
  <button onclick="sendMessage()">Send Message</button>
  <script>
    const log = document.getElementById('log');
    const ledBtn = document.getElementById('led-btn');
    function appendLog(msg) {
      log.textContent += msg + '\\n';
      log.scrollTop = log.scrollHeight;
    }

    const ws = new WebSocket(\`ws\${location.protocol === 'https:' ? 's' : ''}://\${location.host}/ws\`);
    ws.onopen = () => appendLog('Connected');
    ws.onmessage = (e) => appendLog('Received: ' + e.data);
    ws.onclose = () => appendLog('Disconnected');
    ws.onerror = () => appendLog('Error');

    function sendMessage() {
      const msg = 'Hello at ' + new Date().toLocaleTimeString();
      ws.send(msg);
      appendLog('Sent: ' + msg);
    }

    async function toggleLeds() {
      const res = await fetch('/api/leds/toggle', { method: 'POST' });
      const data = await res.json();
      ledBtn.textContent = data.ledsOn ? 'Turn Off' : 'Turn Pink';
      ledBtn.classList.toggle('on', data.ledsOn);
    }
  </script>
</body>
</html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
  websocket: {
    open(ws) {
      console.log("WebSocket client connected");
    },
    message(ws, message) {
      console.log(`Received: ${message}`);
      ws.send(`Echo: ${message}`);
    },
    close(ws) {
      console.log("WebSocket client disconnected");
    },
  },
});

console.log(`Server running at http://localhost:${server.port}`);
