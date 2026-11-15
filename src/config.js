const fs = require("node:fs");
const path = require("node:path");

const PREFLIGHT_TYPE = "agent-games.preflight.v1";
const TASK_TYPE = "agent-games.proof-gatekeeper.v1";
const PROTOCOL_VERSION = "v1";
const GATEKEEPER_VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

/** Resolve the circuits dir: env override, then repo-local circuits/, then the shared agentgames/circuits/. */
function resolveCircuitsDir(env) {
  const candidates = [
    env.CIRCUITS_DIR,
    path.join(__dirname, "..", "circuits"),
    path.join(__dirname, "..", "..", "circuits"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "gatekeeper.wasm"))) return dir;
  }
  return candidates[1];
}

function loadConfig(env = process.env) {
  return {
    hmacSecret: env.AGENT_GAMES_HMAC_SECRET || "",
    kurierApiKey: env.KURIER_API_KEY || "",
    kurierApiUrl: env.KURIER_API_URL || "https://api.kurier.xyz/api/v1",
    gatekeeperVkHash: env.GATEKEEPER_VK_HASH || GATEKEEPER_VK_HASH,
    kurierPollBudgetMs: Number(env.KURIER_POLL_BUDGET_MS || 15000),
    kurierPollIntervalMs: Number(env.KURIER_POLL_INTERVAL_MS || 3000),
    taskSoftDeadlineMs: Number(env.TASK_SOFT_DEADLINE_MS || 50000),
    seenStorePath: env.SEEN_STORE_PATH || path.join(__dirname, "..", "data", "seen.json"),
    circuitsDir: resolveCircuitsDir(env),
    port: Number(env.PORT || 8787),
  };
}

module.exports = { loadConfig, PREFLIGHT_TYPE, TASK_TYPE, PROTOCOL_VERSION, GATEKEEPER_VK_HASH };
