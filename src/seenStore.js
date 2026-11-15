const fs = require("node:fs");
const path = require("node:path");

/**
 * proof_tx seen-set + task_id response cache, JSON-file backed.
 *
 * Durability matters: PROOF_REUSED detection depends on this surviving
 * across restarts, so a single long-lived instance (not serverless) is
 * the safer host. Writes are atomic-ish (tmp file + rename).
 */
class SeenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.seenTx = new Set();
    this.responses = new Map();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.seenTx)) this.seenTx = new Set(data.seenTx);
      if (data.responses && typeof data.responses === "object") {
        this.responses = new Map(Object.entries(data.responses));
      }
    } catch {
      // No file yet, or corrupt — start empty (a corrupt file is renamed
      // aside rather than silently dropped, for forensics).
      try {
        if (fs.existsSync(this.filePath)) {
          fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        }
      } catch { /* ignore */ }
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ seenTx: [...this.seenTx], responses: Object.fromEntries(this.responses) }),
      );
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[seen] save failed:", err.message);
    }
  }

  hasProofTx(proofTx) {
    return this.seenTx.has(String(proofTx).trim().toLowerCase());
  }

  recordProofTx(proofTx) {
    this.seenTx.add(String(proofTx).trim().toLowerCase());
    this.save();
  }

  getResponse(taskId) {
    return this.responses.get(String(taskId)) ?? null;
  }

  recordResponse(taskId, body) {
    this.responses.set(String(taskId), body);
    this.save();
  }
}

module.exports = { SeenStore };
