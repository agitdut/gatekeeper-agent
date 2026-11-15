# Proof Gatekeeper — Protocol Notes (researched 15 Nov 2026)

Account @jettzzs37 registered; no agent registered yet; no secret rotated;
no Kurier key exists. Sources for each claim are noted inline. Claims marked
**[verified locally]** were reproduced by me against the downloaded artifacts
with snarkjs (see `verify-circuit.mjs` notes in §5); the rest come from the
official docs or from independent participant implementations and are flagged
as such.

## 1. Rounds & scoring

- 8 daily rounds, **10:30–20:30 UTC = 17:30–03:30 WIB**. Round dates
  13–20 Nov 2026; rounds 13–14 closed, **15–20 upcoming** (6 rounds left).
  Source: /events/proof-gatekeeper round schedule (fetched 15 Nov).
- 8 tasks per agent per round; scores cumulative. Correct approvals and
  correct rejections score equally. Source: /events/proof-gatekeeper.
- Scoring (official): **+12 correct, −6 approving a trap, −3 rejecting a
  valid request, −2 timeout/offline, −2 proof fails verification**, plus a
  reliability bonus at round close, pro-rated by the share of provable tasks
  whose Groth16 proof verified against the registered key. A correct
  decision without a valid proof earns no bonus and costs an extra −2.
  PROOF_REUSED tasks have no proof to submit and are excluded.
  Source: /build + /events/proof-gatekeeper.
- Tie-breakers: (1) more correct decisions, then (2) fewer timeouts; if
  still equal, agents share the rank and split the prize.
  Source: /events/proof-gatekeeper.
- Eligibility checklist (dashboard): authenticated account, registered HTTPS
  endpoint with passing health check, completed signed preflight **and at
  least one practice task**, endpoint responds within 60 s under load, one
  agent per owner, entries lock while a round is open.
  Source: /events/proof-gatekeeper.
- "Practice traps pass before entering a scored round" — practice tasks exist
  and should be completed before scored rounds. Source: /build.

## 2. Task envelope (POST to registered endpoint)

Source: https://agentgames.zkverify.io/build §02 (code block, fetched 15 Nov).

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_8d31_...",
  "mode": "competition",
  "issued_at": "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk": "0x7d...91",
    "proof_vk": "0x13...aa",
    "minimum": "1000",
    "public_balance": "1460",
    "expiry_block": 8430000,
    "current_block": 8420000,
    "recipient": "0xDe42...9f01",
    "condition_recipient": "0xDe42...9f01",
    "amount": "500",
    "max_transfer": "1000",
    "proof_tx": "0xa8...2c"
  }
}
```

- The request is HMAC-signed; **verify the signature against the RAW body
  BEFORE parsing or processing**. Header: `x-agent-games-signature`.
  Source: /build §02.
- Hard response deadline: **60 seconds**. HTTPS only, public registered
  endpoint, full handler path (e.g. `/agent`, not the root — a root
  returning 404 fails preflight and every task). Fail closed.
  Source: /build §02/§05.

## 3. Preflight

- After "Rotate Secret" in the dashboard, the platform sends a preflight.
  Envelope type: `agent-games.preflight.v1`.
  Expected response: `{ ok: true, protocolVersion: "v1" }` with a valid
  `x-agent-games-signature` HMAC header. Preflight must pass before the
  platform marks the agent active.
  Source: /build §05 (step 06) + live participant implementation
  (andruu21/proof-gatekeeper-agent README: "Platform preflight: Healthy").
- The secret is shown once on Rotate Secret; store as env var
  `AGENT_GAMES_HMAC_SECRET` in the agent's own hosting env. Never a local
  placeholder. Source: /build §04/§05.
- **HMAC encoding is NOT pinned by /build** (algorithm/encoding unstated).
  The working participant implementation uses **HMAC-SHA256, lowercase hex
  digest** for outbound signing, and accepts hex or base64 (optional
  `sha256=` prefix) inbound, compared in constant time. Its preflight
  passed live, so HMAC-SHA256 hex over the raw body is confirmed working
  for responses; inbound acceptance of both encodings is defensive.
  Source: andruu21 README "Spec ambiguities handled defensively" + /build.
- `GET /agent` also serves as the health check (reference impl.).
  Source: andruu21 README.

## 4. Decision logic — the 7 trap codes

Source: /events/proof-gatekeeper "Trap encyclopedia" (all 7 documented).

| reason_code | Decision | Meaning | ~share |
|---|---|---|---|
| VALID_CONDITION | APPROVE | Proof on-chain, VK matches registered condition, public threshold meets minimum, proof reference not previously submitted | ~50% |
| VK_SUBSTITUTION | REJECT | Proof verifies on-chain but its VK does not match the registered condition VK | ~13% |
| THRESHOLD_MISMATCH | REJECT | Proof + VK valid, but public balance < required minimum | ~8% |
| PROOF_REUSED | REJECT | Proof reference already accepted in a previous task | ~11% |
| EXPIRED_CONDITION | REJECT | Condition's block-height expiry has passed | ~6% |
| RECIPIENT_MISMATCH | REJECT | Recipient in the proof ≠ address on the payment condition | ~6% |
| AMOUNT_OVERFLOW | REJECT | Requested amount exceeds the single-transfer cap | ~6% |

Field checks (from envelope `input`):

- APPROVE only if **all** hold: `proof_vk == registered_vk`,
  `proof_tx` unseen, `public_balance >= minimum`,
  `current_block < expiry_block`, `recipient == condition_recipient`,
  `amount <= max_transfer`.
  Boundaries: balance >= minimum passes; amount <= max passes;
  current_block == expiry_block is EXPIRED (strict `<`).
  Source: /events/proof-gatekeeper + /build §04 + participant impl.
- **Evaluation order when several traps coincide is NOT documented.**
  The live participant implementation checks in this order:
  VK → PROOF_REUSED → THRESHOLD → EXPIRED → RECIPIENT → AMOUNT.
  The trap encyclopedia lists them in a different display order.
  This service follows the participant order; flag as residual uncertainty.
- PROOF_REUSED is **off-chain state** (the circuit does not know it):
  keep a local seen-set of `proof_tx` values; a reused reference has **no
  proof to submit** — the response carries no `proof`/`public_signals`.
  Redelivery of the same `task_id` must return the cached response and
  must NOT be misread as reuse (cache by task_id first).
  Source: /events/proof-gatekeeper + /build step 05.
- The incoming proof itself cannot be independently verified from the
  envelope (no proof bytes, only `proof_tx` + `proof_vk`); the field
  checks above are the scored behaviour. The /build security checklist
  item "verification reached a finalized state before approval" is
  implemented by submitting OUR proof via Kurier (see §7).
  Source: /build §04 + participant README.

## 5. The gatekeeper circuit (recovered from the artifacts)

Artifacts: `gatekeeper.wasm` (1,755,820 B), `gatekeeper_final.zkey`
(309,750 B) — already in `~/workspace/agentgames/circuits/`, SHA-256
verified. vkHash (zkVerify mainnet):
`0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`.
Source: /api/circuit-info.

- Groth16 / BN128, compiled with Circom 2.x. Verification key exported
  with snarkjs: **nPublic = 13**, protocol groth16, curve bn128.
  **[verified locally]**
- Circuit name: `GatekeeperEvaluation`. Input signal names are NOT
  published on /build; they were recovered from `gatekeeper.wasm` with an
  FNV-1a hash oracle over the WASM's `getInputSignalSize` export
  (participant script `probe-signals.js`), and confirmed by proving:
  `taskId, registeredVkHash, proofVkHash, minimum, publicBalance,
  expiryBlock, currentBlock, recipient, conditionRecipient, amount,
  maxTransfer, decision, salt` (13 inputs, `salt` private).
  Source: participant README + Medium (dickycan42).
- **The circuit asserts `decision == (all five field checks)`**: witness
  generation fails for `decision=1` on a trapped statement and for
  `decision=0` on a valid one. A wrong decision is unprovable.
  **[verified locally]** — valid+approve proves in ~930 ms (cold, incl.
  WASM load) and verifies OK; trap+approve and valid+reject both fail
  witness generation (`Assert Failed ... GatekeeperEvaluation_79 line: 102`);
  trap+reject and VK-mismatch+reject prove and verify OK.
- Public signals (13), in order **[verified locally]**:
  `[commitment, registeredVkHash, proofVkHash, minimum, publicBalance,
  expiryBlock, currentBlock, recipient, conditionRecipient, amount,
  maxTransfer, decision, taskId]`
  where `commitment = Poseidon(salt, taskId)` — **salt first**
  (**[verified locally]** with circomlibjs: `Poseidon(salt, taskId)`
  matches publicSignals[0]; `Poseidon(taskId, salt)` does not. The
  participant README's prose says Poseidon(taskId, salt); its code never
  computes the commitment — the circuit does — so the prose order is
  wrong and irrelevant to proving.)
- Field-element encoding: envelope values reduced mod the BN128 prime
  `21888242871839275222246405745257275088548364400416034343698204186575808495617`.
  Hex (addresses, vk hashes) → integer mod p (reduction preserves the
  equality checks). Free-form `task_id` (e.g. `gk_8d31_…`) → SHA-256
  digest mod p; numeric/hex ids used directly.
  Source: participant impl.; **taskId encoding is a judgment call** —
  the circuit accepts any field element, so only the platform's
  public-signal check could distinguish encodings; SHA-256 mod p is
  what two independent participant implementations use.
- `salt` (private input) is the agent's own choice: derive
  deterministically as `HMAC-SHA256(secret, "gatekeeper-salt:" + task_id)
  mod p` so a redelivered task reproduces identical proof inputs.
  Source: participant impl. (their convention; any private salt works
  for proving).
- Proof size ~804 bytes (snarkjs Groth16). Local verify:
  `snarkjs groth16 verify verification_key.json public.json proof.json`.
  Source: Medium (dickycan42) + local test.

## 6. Required response

Source: /build §02 (code block) + step 05; field set confirmed by the
live participant implementation.

```json
{
  "decision": "APPROVE" | "REJECT",
  "reason_code": "VALID_CONDITION" | "VK_SUBSTITUTION" | "PROOF_REUSED"
               | "THRESHOLD_MISMATCH" | "EXPIRED_CONDITION"
               | "RECIPIENT_MISMATCH" | "AMOUNT_OVERFLOW",
  "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...],
             "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<13 field elements>"],
  "proof_tx": "0x…"
}
```

plus header `x-agent-games-signature` = HMAC-SHA256 hex over the raw
response body. For PROOF_REUSED: no `proof`/`public_signals`.

**Judgment call — `proof_tx` in the response:** the ONLY documented
response example echoes the envelope's `proof_tx` ("0xa8...2c"), and
/build calls it "an optional on-chain audit pointer". The participant
implementation instead overwrites it with the Kurier txHash of OUR
proof. This service echoes the envelope's `proof_tx` (matching the
documented example); the Kurier submission still happens server-side
and its txHash is logged. If a live round shows the platform expects
the Kurier txHash here, flip one line in `src/handler.js`.

## 7. Kurier (zkVerify submission)

Source: https://docs.zkverify.io/overview/getting-started/kurier and
/build §03 (code block).

- Mainnet API: `https://api.kurier.xyz/api/v1` (testnet:
  `https://api-testnet.kurier.xyz/api/v1`). Swagger:
  `https://api.kurier.xyz/docs`.
- Signup (self-serve, free API key): https://kurier.xyz — form fields
  **name, email, password, company** (+ terms). No wallet, no payment
  mentioned on the signup page (checked 15 Nov 2026; signup itself was
  NOT performed — needs the user). "Sign up and generate your free API
  key."
- `register-vk`: `POST /register-vk/{API_KEY}` with
  `{proofType:"groth16", proofOptions:{library:"snarkjs",curve:"bn128"},
  vk:<verification key JSON>}` → returns `vkHash`. **Not needed for
  Gatekeeper**: the platform already registered the gatekeeper VK on
  mainnet, so `submit-proof` uses `vkRegistered: true` + the known
  vkHash. (If submit ever fails with "vk not registered", fall back to
  register-vk with the extracted `verification_key.json`.)
- `submit-proof`: `POST /submit-proof/{API_KEY}` with
  ```json
  { "proofType": "groth16", "vkRegistered": true,
    "proofOptions": { "library": "snarkjs", "curve": "bn128" },
    "proofData": { "proof": {...}, "publicSignals": [...],
                   "vk": "<vk_hash>" } }
  ```
  → `{ jobId, optimisticVerify }`.
- `job-status`: `GET /job-status/{API_KEY}/{jobId}` → `{status, txHash,
  ...}`. Lifecycle: Queued → Valid → Submitted → IncludedInBlock →
  Finalized | Failed. Live measurements (participant): txHash exists
  from Submitted (~4 s); full Finalized ~27 s, continues server-side.
- Budget: poll ≤15 s per task, never past the 50 s soft deadline; the
  response must not wait for Finalized. If `KURIER_API_KEY` is unset,
  submission is skipped gracefully and the agent still answers with
  proof + public_signals (the proof itself is the scored evidence).
- Rate limits apply; power users can ask on Discord / via a form to
  raise them (docs). Whether the free tier covers 8 rounds/day of
  Gatekeeper traffic (8 tasks/round × 6 remaining rounds ≈ 48 proofs)
  is unverified — check the Kurier dashboard after signup.
- Alternative (zkVerifyJS): direct chain interaction, needs a funded
  Volta session + tVFY — NOT used (needs a funded wallet).

## 8. What is still unclear / residual risk

1. **HMAC inbound encoding** (hex vs base64) — accepted both; outbound
   hex confirmed working by a live participant's passing preflight.
2. **Evaluation order for multi-trap tasks** — see §4.
3. **`task_id` → field encoding** — SHA-256 mod p is the best available
   convention (two independent implementations); only a live round can
   confirm the platform checks it this way.
4. **`proof_tx` echo vs Kurier txHash** — see §6.
5. **Preflight exact envelope shape** — type `agent-games.preflight.v1`
   per the live implementation; the service also treats a body with no
   `type`/`input` but with `nonce` as preflight (defensive).
6. **Whether the platform re-checks our proof's public signals against
   the task fields** — assumed yes (that's the point of the circuit);
   our signals are built directly from the envelope fields, so they
   match by construction.
7. **Kurier free-tier quota** for ~48 proofs — unverified until signup.
8. **Practice-task flow** — the dashboard presumably offers practice
   tasks once the agent is active; exact trigger unknown until
   registration.
