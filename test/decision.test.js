const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { BN128_PRIME } = require("../src/hmac");
const { parseInput, evaluate, toFieldElement, buildCircuitInputs } = require("../src/decision");

const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";

function validInput(over = {}) {
  return {
    registered_vk: VK,
    proof_vk: VK,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: ADDR_A,
    condition_recipient: ADDR_A,
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...over,
  };
}

function evalInput(input, seen = () => false) {
  const parsed = parseInput(input);
  assert.ok(parsed, "input should parse");
  return evaluate(parsed, seen);
}

test("valid condition approves", () => {
  assert.deepEqual(evalInput(validInput()), {
    decision: "APPROVE", reason_code: "VALID_CONDITION", provable: true,
  });
});

test("VK substitution rejects (case-insensitive compare)", () => {
  const r = evalInput(validInput({ proof_vk: "0x1234" }));
  assert.deepEqual(r, { decision: "REJECT", reason_code: "VK_SUBSTITUTION", provable: true });
  // Same VK in different case still approves.
  assert.equal(evalInput(validInput({ proof_vk: VK.toUpperCase() })).decision, "APPROVE");
});

test("reused proof_tx rejects with no proof", () => {
  const r = evalInput(validInput(), () => true);
  assert.deepEqual(r, { decision: "REJECT", reason_code: "PROOF_REUSED", provable: false });
});

test("balance below minimum rejects", () => {
  const r = evalInput(validInput({ public_balance: "999" }));
  assert.equal(r.reason_code, "THRESHOLD_MISMATCH");
});

test("balance equal to minimum passes (boundary)", () => {
  assert.equal(evalInput(validInput({ public_balance: "1000" })).decision, "APPROVE");
});

test("expired condition rejects; equality is expired (strict <)", () => {
  assert.equal(evalInput(validInput({ current_block: 8430001 })).reason_code, "EXPIRED_CONDITION");
  assert.equal(evalInput(validInput({ current_block: 8430000 })).reason_code, "EXPIRED_CONDITION");
  assert.equal(evalInput(validInput({ current_block: 8429999 })).decision, "APPROVE");
});

test("recipient mismatch rejects (case-insensitive compare)", () => {
  const r = evalInput(validInput({ condition_recipient: ADDR_B }));
  assert.equal(r.reason_code, "RECIPIENT_MISMATCH");
  assert.equal(evalInput(validInput({ recipient: ADDR_A.toUpperCase() })).decision, "APPROVE");
});

test("amount over cap rejects; equal to cap passes (boundary)", () => {
  assert.equal(evalInput(validInput({ amount: "1001" })).reason_code, "AMOUNT_OVERFLOW");
  assert.equal(evalInput(validInput({ amount: "1000" })).decision, "APPROVE");
});

test("evaluation order: VK beats threshold", () => {
  // Both traps present; VK_SUBSTITUTION wins (documented order).
  const r = evalInput(validInput({ proof_vk: "0x1234", public_balance: "1" }));
  assert.equal(r.reason_code, "VK_SUBSTITUTION");
});

test("parseInput rejects malformed fields", () => {
  assert.equal(parseInput(null), null);
  assert.equal(parseInput({}), null);
  assert.equal(parseInput(validInput({ minimum: "-5" })), null);
  assert.equal(parseInput(validInput({ minimum: "1.5" })), null);
  assert.equal(parseInput(validInput({ expiry_block: "soon" })), null);
  assert.equal(parseInput(validInput({ proof_tx: "" })), null);
  // Numbers are accepted too.
  assert.ok(parseInput(validInput({ minimum: 1000, expiry_block: 8430000 })));
  // Hex amounts are accepted.
  assert.ok(parseInput(validInput({ minimum: "0x3e8" })));
});

test("toFieldElement: hex mod p, decimal passthrough, free-form SHA-256", () => {
  // 0x6b79... mod p (32-byte hash exceeds the field).
  const h = toFieldElement(VK);
  assert.equal(h, (BigInt(VK) % BN128_PRIME).toString(10));
  assert.equal(toFieldElement("1000"), "1000");
  assert.equal(toFieldElement(ADDR_A), BigInt(ADDR_A).toString(10));
  const free = toFieldElement("gk_8d31_test");
  const expected = (BigInt("0x" + crypto.createHash("sha256").update("gk_8d31_test").digest("hex")) % BN128_PRIME).toString(10);
  assert.equal(free, expected);
});

test("buildCircuitInputs produces the 13 named signals", () => {
  const parsed = parseInput(validInput());
  const inputs = buildCircuitInputs({ task_id: "gk_8d31_test" }, parsed, "APPROVE", 12345n);
  assert.deepEqual(Object.keys(inputs).sort(), [
    "amount", "conditionRecipient", "currentBlock", "decision", "expiryBlock",
    "maxTransfer", "minimum", "proofVkHash", "publicBalance", "recipient",
    "registeredVkHash", "salt", "taskId",
  ].sort());
  assert.equal(inputs.decision, "1");
  assert.equal(inputs.minimum, "1000");
  assert.equal(inputs.salt, "12345");
  const rej = buildCircuitInputs({ task_id: "gk_x" }, parsed, "REJECT", 1n);
  assert.equal(rej.decision, "0");
});
