// Download the official gatekeeper circuit artifacts into circuits/ if missing
// or incomplete. Runs before the server starts so a fresh deploy (e.g. Render,
// whose filesystem is ephemeral) self-heals. The .wasm/.zkey are gitignored
// (large binary blobs); only verification_key.json is committed.
// Uses only Node built-ins. Exits non-zero if a download fails verification.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const circuitsDir = path.join(__dirname, "..", "circuits");

const FILES = [
  {
    name: "gatekeeper.wasm",
    url: "https://agentgames.zkverify.io/circuits/gatekeeper.wasm",
    size: 1755820,
    sha256:
      "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f",
  },
  {
    name: "gatekeeper_final.zkey",
    url: "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey",
    size: 309750,
    sha256:
      "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d",
  },
];

function verify(file, expected) {
  if (!fs.existsSync(file)) return false;
  const buf = fs.readFileSync(file);
  if (buf.length !== expected.size) return false;
  const hash = createHash("sha256").update(buf).digest("hex");
  return hash === expected.sha256;
}

async function download(spec, dest) {
  const res = await fetch(spec.url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${spec.url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

fs.mkdirSync(circuitsDir, { recursive: true });
for (const spec of FILES) {
  const dest = path.join(circuitsDir, spec.name);
  if (verify(dest, spec)) {
    console.log(`[circuits] ${spec.name} OK (cached, verified)`);
    continue;
  }
  console.log(`[circuits] downloading ${spec.name} ...`);
  await download(spec, dest);
  if (!verify(dest, spec)) {
    fs.rmSync(dest, { force: true });
    throw new Error(
      `${spec.name} failed verification (size/sha256 mismatch) after download`
    );
  }
  console.log(`[circuits] ${spec.name} OK (downloaded, verified)`);
}
console.log("[circuits] all artifacts present");
