const test = require("node:test");
const assert = require("node:assert/strict");
const { signBody, verifyBodySignature, deriveSalt, BN128_PRIME } = require("../src/hmac");

const SECRET = "test-secret-please-ignore";
const BODY = Buffer.from(JSON.stringify({ type: "agent-games.preflight.v1" }));

test("sign then verify (hex) roundtrips", () => {
  const sig = signBody(SECRET, BODY);
  assert.equal(sig.length, 64);
  assert.equal(verifyBodySignature(SECRET, BODY, sig), true);
});

test("base64 encoding of the same MAC is accepted", () => {
  const hex = signBody(SECRET, BODY);
  const b64 = Buffer.from(hex, "hex").toString("base64");
  assert.equal(verifyBodySignature(SECRET, BODY, b64), true);
});

test("sha256= prefix is accepted", () => {
  const sig = "sha256=" + signBody(SECRET, BODY);
  assert.equal(verifyBodySignature(SECRET, BODY, sig), true);
});

test("wrong secret is rejected", () => {
  const sig = signBody("another-secret", BODY);
  assert.equal(verifyBodySignature(SECRET, BODY, sig), false);
});

test("tampered body is rejected", () => {
  const sig = signBody(SECRET, BODY);
  const tampered = Buffer.from(JSON.stringify({ type: "agent-games.preflight.v1", x: 1 }));
  assert.equal(verifyBodySignature(SECRET, tampered, sig), false);
});

test("missing header / empty secret is rejected", () => {
  assert.equal(verifyBodySignature(SECRET, BODY, undefined), false);
  assert.equal(verifyBodySignature(SECRET, BODY, ""), false);
  assert.equal(verifyBodySignature("", BODY, signBody(SECRET, BODY)), false);
});

test("garbage header is rejected", () => {
  assert.equal(verifyBodySignature(SECRET, BODY, "not-a-signature"), false);
});

test("deriveSalt is deterministic, secret-bound, and in-field", () => {
  const a = deriveSalt(SECRET, "gk_1");
  const b = deriveSalt(SECRET, "gk_1");
  const c = deriveSalt(SECRET, "gk_2");
  const d = deriveSalt("other-secret", "gk_1");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.ok(a >= 0n && a < BN128_PRIME);
});
