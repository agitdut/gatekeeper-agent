# Gatekeeper Agent — Proof Gatekeeper (zkVerify Agent Games)

An HTTPS agent endpoint for the **Proof Gatekeeper** event in the zkVerify
Agent Games. The platform POSTs signed task envelopes; this service verifies
the HMAC, makes a deterministic APPROVE/REJECT decision, generates a real
Groth16 proof locally with snarkjs against the official gatekeeper circuit,
optionally submits it to zkVerify via Kurier, and returns a signed response —
well inside the 60-second hard deadline (typical end-to-end: ~0.3–2 s).

Part of the MintGuard line of agents (see
[ mintguard-agent](https://github.com/agitdut/mintguard-agent) — the Wildcard
submission). Full protocol research: [`PROTOCOL.md`](PROTOCOL.md).

## How it decides

One deterministic checklist over the task fields — no model anywhere near
the decision; the same input always gives the same output. APPROVE only when
every field agrees:

| Check | Failure → reason_code |
|---|---|
| `proof_vk == registered_vk` | `VK_SUBSTITUTION` |
| `proof_tx` not seen before | `PROOF_REUSED` (no proof to submit) |
| `public_balance >= minimum` | `THRESHOLD_MISMATCH` |
| `current_block < expiry_block` | `EXPIRED_CONDITION` |
| `recipient == condition_recipient` | `RECIPIENT_MISMATCH` |
| `amount <= max_transfer` | `AMOUNT_OVERFLOW` |
| all pass | `APPROVE` / `VALID_CONDITION` |

The gatekeeper circuit asserts `decision == AND(all five field checks)` —
a wrong decision cannot even produce a witness. Fail closed throughout:
malformed envelopes, internal errors, and proof failures all resolve to
REJECT, never to an unproven APPROVE. (Conservative by design: a wrong
rejection costs −3, a wrong approval costs −6.)

## Endpoints

- `POST /agent` — signed task envelopes and preflight. Verifies
  `x-agent-games-signature` (HMAC-SHA256 over the raw body) **before**
  JSON parsing; bad signature → 401. Preflight
  (`type: agent-games.preflight.v1`) → signed
  `{ ok: true, protocolVersion: "v1" }`. Tasks → signed
  `{ decision, reason_code, proof, public_signals, proof_tx }`.
- `GET /health`, `GET /agent` — unsigned health check
  `{ ok: true, protocolVersion: "v1" }`.

## Setup

```bash
npm install
# Download the official circuit artifacts into circuits/
#   https://agentgames.zkverify.io/circuits/gatekeeper.wasm
#   https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
# (circuits/verification_key.json is already included, extracted from the zkey)
cp .env.example .env   # then fill in AGENT_GAMES_HMAC_SECRET
npm start              # listens on :8787 (POST /agent, GET /health)
npm test               # 34 checks: HMAC, policy, proving, end-to-end HTTP
```

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | yes | Platform-generated; dashboard → agent → **Rotate Secret**, copy the one-time plaintext. Never a local placeholder. |
| `KURIER_API_KEY` | no | Mainnet Kurier key (signup at https://kurier.xyz — free). If unset, submission is skipped gracefully and the agent still answers with proof + public_signals. |
| `KURIER_API_URL` | no | Default `https://api.kurier.xyz/api/v1` (mainnet). |
| `GATEKEEPER_VK_HASH` | no | Defaults to the registered gatekeeper vk_hash `0x6b79c6…77b0`. |
| `KURIER_POLL_BUDGET_MS` | no | Default 15000. txHash exists from the Submitted status (~4 s); full finalization takes ~27 s and continues server-side at Kurier after we stop polling. |
| `TASK_SOFT_DEADLINE_MS` | no | Default 50000 (hard platform deadline is 60 s). |
| `SEEN_STORE_PATH` | no | Default `./data/seen.json`. |
| `CIRCUITS_DIR`, `PORT` | no | Artifact location override; local port (default 8787). |

No secrets are hardcoded anywhere; `.env` is gitignored and `.env.example`
ships blank values.

## Registration & preflight flow

1. Deploy (see below) and note the public URL.
2. Register the full handler path — `https://<host>/agent`, not the root —
   in the Agent Games dashboard (track: Proof Gatekeeper).
3. Dashboard → **Rotate Secret** → set the revealed plaintext as
   `AGENT_GAMES_HMAC_SECRET` → redeploy/restart.
4. The platform sends a signed preflight; this agent answers
   `{ ok: true, protocolVersion: "v1" }` signed, and the dashboard marks
   the agent active.
5. Complete at least one practice task before scored rounds.
6. Rounds run daily 17:30–03:30 WIB (10:30–20:30 UTC), 8 tasks per round.

## Deploy

The service is a plain Node.js HTTP server (no framework, no database);
it needs a host with a **public HTTPS URL** and a persistent filesystem
for `data/seen.json` (the PROOF_REUSED seen-set must survive restarts —
a single long-lived instance is safer than serverless for this reason).

Options (none is free of an account step):

- **Vercel / Render / Fly.io (free tier):** deploy from this repo; stable
  HTTPS URL, survives restarts. Needs an account on the platform
  (GitHub login works for Vercel/Render; Fly.io asks for a card).
- **Cloudflare named tunnel:** stable subdomain, needs a Cloudflare
  account + a domain.
- **Quick tunnel (testing only):** `cloudflared tunnel --url
  http://localhost:8787` gives an ephemeral `*.trycloudflare.com` URL —
  changes on every restart, so the registered endpoint must be re-edited
  in the dashboard each time. Note: this was **blocked from the build VM**
  (egress proxy returns 403 for api.trycloudflare.com; localtunnel 403;
  localhost.run SSH reset) — run it from a normal network instead.

## Local test results

`npm test` — **34/34 checks pass** (Node 24, 15 Nov 2026), including:

- HMAC roundtrip (hex + base64 acceptance), tamper/wrong-secret/missing → reject
- Preflight body shape + valid response signature; bad HMAC → 401
- Valid task → APPROVE / VALID_CONDITION, proof **verified locally** with
  `snarkjs groth16 verify` against the extracted verification key
- All six traps → correct REJECT + reason_code, each proof verified
  (PROOF_REUSED correctly carries no proof)
- Idempotent redelivery (cached response, not misread as reuse)
- Response times: ~2 s cold (incl. WASM load), ~0.3–0.7 s warm — far
  under the 60 s deadline even with the 15 s Kurier budget on top

Note: the test runner needs `--test-force-exit` (already in `npm test`):
snarkjs leaves a handle that keeps the test process alive after the
tests finish; the flag only affects test exit, not the server.

## The circuit (recovered from the artifacts)

Input signal names are not published; they were recovered from
`gatekeeper.wasm` with an FNV-1a hash oracle over the WASM's
`getInputSignalSize` export, then confirmed by proving. The circuit
(`GatekeeperEvaluation`) takes 13 inputs — `taskId, registeredVkHash,
proofVkHash, minimum, publicBalance, expiryBlock, currentBlock,
recipient, conditionRecipient, amount, maxTransfer, decision, salt
(private)` — and emits 13 public signals: `[Poseidon(salt, taskId),
registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer,
decision, taskId]`. Field elements are the envelope values reduced mod
the BN128 prime; `task_id` (free-form, e.g. `gk_8d31_…`) is hashed with
SHA-256 into the field; `salt` is derived deterministically as
`HMAC(secret, "gatekeeper-salt:" + task_id) mod p`.

## Spec ambiguities handled defensively

See [`PROTOCOL.md`](PROTOCOL.md) §8. The important ones:

- **HMAC encoding:** /build mandates HMAC over the raw body but never
  names the algorithm/encoding. Outbound signing is HMAC-SHA256 hex;
  inbound verification accepts hex or base64 (and an optional `sha256=`
  prefix), compared in constant time.
- **`proof_tx` in the response** echoes the envelope's reference (the
  documented example). The Kurier txHash of our own proof is logged,
  not substituted.
- **`INVALID_TASK`** is a local fallback reason code for envelope-level
  failures (malformed input, past deadline, internal error). It is
  outside the documented 7-code taxonomy and only reachable off the
  scored paths.
