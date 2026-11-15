const http = require("node:http");
const { loadConfig } = require("./config");
const { AgentHandler } = require("./handler");

const cfg = loadConfig();
const handler = new AgentHandler(cfg);

const MAX_BODY_BYTES = 1024 * 1024;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // Health checks (unsigned): GET /health and GET /agent.
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/agent")) {
    const result = handler.health();
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent") {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (tooLarge) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body_too_large" }));
        return;
      }
      const rawBody = Buffer.concat(chunks);
      try {
        const result = await handler.handlePost(rawBody, req.headers["x-agent-games-signature"]);
        const headers = { "content-type": "application/json" };
        if (result.signature) headers["x-agent-games-signature"] = result.signature;
        res.writeHead(result.status, headers);
        res.end(result.body);
      } catch (err) {
        console.error("[server] unhandled error:", err.message);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
    req.on("error", (err) => {
      console.error("[server] request error:", err.message);
      try {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request" }));
      } catch { /* socket already gone */ }
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(cfg.port, () => {
  console.log(`[gatekeeper] listening on :${cfg.port} (POST /agent, GET /health)`);
  console.log(`[gatekeeper] kurier: ${cfg.kurierApiKey ? "configured" : "not configured (submission skipped)"}`);
  console.log(`[gatekeeper] hmac secret: ${cfg.hmacSecret ? "set" : "MISSING — set AGENT_GAMES_HMAC_SECRET"}`);
});
