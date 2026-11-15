const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const snarkjs = require("snarkjs");
const { AgentHandler } = require("../src/handler");
const { signBody } = require("../src/hmac");
const { loadConfig } = require("../src/config");

const SECRET = "handler-test-secret";
const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";

const cfg = loadConfig();
const VK_PATH = path.join(__dirname, "..", "circuits", "verification_key.json");
const hasArtifacts =
  fs.existsSync(path.join(cfg.circuitsDir, "gatekeeper.wasm")) &&
  fs.existsSync(path.join(cfg.circuitsDir, "gatekeeper_final.zkey")) &&
  fs.existsSync(VK_PATH);

function taskEnvelope(taskId, inputOver = {}, envelopeOver = {}) {
  const now = new Date();
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: now.toISOString(),
    deadline_at: new Date(now.getTime() + 60_000).toISOString(),
    input: {
      registered_vk: VK_HASH,
      proof_vk: VK_HASH,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: ADDR_A,
      condition_recipient: ADDR_A,
      amount: "500",
      max_transfer: "1000",
      proof_tx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...inputOver,
    },
    ...envelopeOver,
  };
}

function makeHandler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-seen-"));
  const testCfg = {
    ...loadConfig(),
    hmacSecret: SECRET,
    kurierApiKey: "", // no Kurier in tests — submission skipped
    kurierPollBudgetMs: 1000,
    seenStorePath: path.join(dir, "seen.json"),
  };
  return new AgentHandler(testCfg);
}

async function post(port, rawBody, signature) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/agent", method: "POST" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (signature !== undefined) req.setHeader("x-agent-games-signature", signature);
    req.end(rawBody);
  });
}

async function withServer(handler, fn) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/agent")) {
      const r = handler.health();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
      return;
    }
    if (req.method === "POST" && req.url === "/agent") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const result = await handler.handlePost(Buffer.concat(chunks), req.headers["x-agent-games-signature"]);
        const headers = { "content-type": "application/json" };
        if (result.signature) headers["x-agent-games-signature"] = result.signature;
        res.writeHead(result.status, headers);
        res.end(result.body);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(server.address().port);
  } finally {
    server.close();
  }
}

test("health endpoint answers unsigned", async () => {
  const handler = makeHandler();
  await withServer(handler, async (port) => {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/health" }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }).on("error", reject);
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, protocolVersion: "v1" });
    assert.equal(res.headers["x-agent-games-signature"], undefined);
  });
});

test("preflight with valid signature returns signed {ok:true}", async () => {
  const handler = makeHandler();
  await withServer(handler, async (port) => {
    const body = JSON.stringify({ type: "agent-games.preflight.v1", nonce: "abc123" });
    const res = await post(port, body, signBody(SECRET, body));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, protocolVersion: "v1" });
    assert.equal(res.headers["x-agent-games-signature"], signBody(SECRET, res.body));
  });
});

test("preflight with bad signature is 401 unsigned", async () => {
  const handler = makeHandler();
  await withServer(handler, async (port) => {
    const body = JSON.stringify({ type: "agent-games.preflight.v1" });
    const res = await post(port, body, signBody("wrong-secret", body));
    assert.equal(res.status, 401);
    assert.equal(res.headers["x-agent-games-signature"], undefined);
  });
});

test("missing signature is 401", async () => {
  const handler = makeHandler();
  await withServer(handler, async (port) => {
    const body = JSON.stringify({ type: "agent-games.preflight.v1" });
    const res = await post(port, body);
    assert.equal(res.status, 401);
  });
});

test("valid task approves with a locally verifiable proof", { skip: !hasArtifacts }, async () => {
  const handler = makeHandler();
  const vk = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  await withServer(handler, async (port) => {
    const body = JSON.stringify(taskEnvelope("gk_e2e_valid"));
    const t0 = Date.now();
    const res = await post(port, body, signBody(SECRET, body));
    const ms = Date.now() - t0;
    assert.ok(ms < 60000, `task took ${ms} ms`);
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.decision, "APPROVE");
    assert.equal(parsed.reason_code, "VALID_CONDITION");
    assert.equal(parsed.proof_tx, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(parsed.public_signals.length, 13);
    assert.equal(await snarkjs.groth16.verify(vk, parsed.public_signals, parsed.proof), true);
    assert.equal(res.headers["x-agent-games-signature"], signBody(SECRET, res.body));
  });
});

test("each trap rejects with the right reason_code", { skip: !hasArtifacts }, async () => {
  const handler = makeHandler();
  const vk = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  const cases = [
    ["VK_SUBSTITUTION", { proof_vk: "0x1234" }],
    ["THRESHOLD_MISMATCH", { public_balance: "999" }],
    ["EXPIRED_CONDITION", { current_block: 8430000 }],
    ["RECIPIENT_MISMATCH", { condition_recipient: ADDR_B }],
    ["AMOUNT_OVERFLOW", { amount: "1001" }],
  ];
  await withServer(handler, async (port) => {
    for (const [code, over] of cases) {
      const tx = "0x" + Buffer.from(code).toString("hex").padEnd(64, "0");
      const body = JSON.stringify(taskEnvelope(`gk_trap_${code}`, { ...over, proof_tx: tx }));
      const res = await post(port, body, signBody(SECRET, body));
      assert.equal(res.status, 200, code);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.decision, "REJECT", code);
      assert.equal(parsed.reason_code, code, code);
      assert.equal(await snarkjs.groth16.verify(vk, parsed.public_signals, parsed.proof), true, code);
    }
  });
});

test("reused proof_tx rejects with no proof; redelivery returns the cached response", { skip: !hasArtifacts }, async () => {
  const handler = makeHandler();
  await withServer(handler, async (port) => {
    const tx = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const first = JSON.stringify(taskEnvelope("gk_reuse_1", { proof_tx: tx }));
    const res1 = await post(port, first, signBody(SECRET, first));
    assert.equal(JSON.parse(res1.body).decision, "APPROVE");

    // Same task_id redelivered: identical cached body (not a reuse).
    const res1b = await post(port, first, signBody(SECRET, first));
    assert.equal(res1b.body, res1.body);

    // Different task_id, same proof_tx: PROOF_REUSED, no proof attached.
    const second = JSON.stringify(taskEnvelope("gk_reuse_2", { proof_tx: tx }));
    const res2 = await post(port, second, signBody(SECRET, second));
    const parsed2 = JSON.parse(res2.body);
    assert.equal(parsed2.decision, "REJECT");
    assert.equal(parsed2.reason_code, "PROOF_REUSED");
    assert.equal(parsed2.proof, undefined);
    assert.equal(parsed2.public_signals, undefined);
    assert.equal(parsed2.proof_tx, tx);
  });
});

test("malformed JSON and unknown type are rejected; past deadline fails closed", async () => {
  const handler = makeHandler();
  await withServer(handler, async (port) => {
    const bad = "{not json";
    const resBad = await post(port, bad, signBody(SECRET, bad));
    assert.equal(resBad.status, 400);

    const unknown = JSON.stringify({ type: "agent-games.something-else.v1" });
    const resUnknown = await post(port, unknown, signBody(SECRET, unknown));
    assert.equal(resUnknown.status, 400);

    const past = JSON.stringify(taskEnvelope("gk_past", {}, {
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    const resPast = await post(port, past, signBody(SECRET, past));
    assert.equal(JSON.parse(resPast.body).decision, "REJECT");
    assert.equal(JSON.parse(resPast.body).reason_code, "INVALID_TASK");
  });
});

test("missing HMAC secret is a 500 misconfiguration, not a decision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-seen-"));
  const testCfg = { ...loadConfig(), hmacSecret: "", seenStorePath: path.join(dir, "seen.json") };
  const handler = new AgentHandler(testCfg);
  await withServer(handler, async (port) => {
    const body = JSON.stringify({ type: "agent-games.preflight.v1" });
    const res = await post(port, body, signBody(SECRET, body));
    assert.equal(res.status, 500);
  });
});
