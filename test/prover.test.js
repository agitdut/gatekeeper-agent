const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const snarkjs = require("snarkjs");
const { Prover } = require("../src/prover");
const { toFieldElement } = require("../src/decision");
const { loadConfig } = require("../src/config");

const cfg = loadConfig();
const VK_PATH = path.join(__dirname, "..", "circuits", "verification_key.json");
const hasArtifacts =
  fs.existsSync(path.join(cfg.circuitsDir, "gatekeeper.wasm")) &&
  fs.existsSync(path.join(cfg.circuitsDir, "gatekeeper_final.zkey")) &&
  fs.existsSync(VK_PATH);

const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";

function inputs(over = {}) {
  return {
    taskId: toFieldElement("gk_8d31_test"),
    registeredVkHash: toFieldElement(VK_HASH),
    proofVkHash: toFieldElement(VK_HASH),
    minimum: "1000",
    publicBalance: "1460",
    expiryBlock: "8430000",
    currentBlock: "8420000",
    recipient: toFieldElement(ADDR_A),
    conditionRecipient: toFieldElement(ADDR_A),
    amount: "500",
    maxTransfer: "1000",
    decision: "1",
    salt: "12345",
    ...over,
  };
}

test("valid scenario proves and verifies locally", { skip: !hasArtifacts }, async () => {
  const vk = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  const prover = new Prover(cfg.circuitsDir);
  const t0 = Date.now();
  const { proof, publicSignals } = await prover.prove(inputs());
  const ms = Date.now() - t0;
  assert.ok(ms < 60000, `prove took ${ms} ms, must stay inside the 60 s deadline`);
  assert.equal(publicSignals.length, 13);
  assert.equal(await snarkjs.groth16.verify(vk, publicSignals, proof), true);
  // Public-signal layout: [commitment, registeredVkHash, proofVkHash,
  // minimum, publicBalance, expiryBlock, currentBlock, recipient,
  // conditionRecipient, amount, maxTransfer, decision, taskId]
  const inp = inputs();
  const expected = [
    null, inp.registeredVkHash, inp.proofVkHash, inp.minimum, inp.publicBalance,
    inp.expiryBlock, inp.currentBlock, inp.recipient, inp.conditionRecipient,
    inp.amount, inp.maxTransfer, inp.decision, inp.taskId,
  ];
  for (let i = 1; i < 13; i++) assert.equal(publicSignals[i], expected[i], `publicSignals[${i}]`);
  // Commitment is Poseidon(salt, taskId) — verified with circomlibjs in research.
  assert.ok(/^[0-9]+$/.test(publicSignals[0]));
});

test("trap + approve cannot produce a witness", { skip: !hasArtifacts }, async () => {
  const prover = new Prover(cfg.circuitsDir);
  await assert.rejects(
    prover.prove(inputs({ conditionRecipient: toFieldElement(ADDR_B) })),
    /Assert Failed/,
  );
});

test("valid scenario + reject cannot produce a witness", { skip: !hasArtifacts }, async () => {
  const prover = new Prover(cfg.circuitsDir);
  await assert.rejects(prover.prove(inputs({ decision: "0" })), /Assert Failed/);
});

test("trap + reject proves and verifies", { skip: !hasArtifacts }, async () => {
  const vk = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  const prover = new Prover(cfg.circuitsDir);
  const { proof, publicSignals } = await prover.prove(
    inputs({ decision: "0", conditionRecipient: toFieldElement(ADDR_B) }),
  );
  assert.equal(await snarkjs.groth16.verify(vk, publicSignals, proof), true);
  assert.equal(publicSignals[11], "0");
});

test("VK mismatch + reject proves and verifies", { skip: !hasArtifacts }, async () => {
  const vk = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  const prover = new Prover(cfg.circuitsDir);
  const { proof, publicSignals } = await prover.prove(
    inputs({ decision: "0", proofVkHash: toFieldElement("0x1234") }),
  );
  assert.equal(await snarkjs.groth16.verify(vk, publicSignals, proof), true);
});
