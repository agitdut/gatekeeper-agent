const path = require("node:path");
const snarkjs = require("snarkjs");

/**
 * Local Groth16 proving with snarkjs fullProve against the downloaded
 * gatekeeper artifacts. Measured locally at ~0.9 s cold (incl. WASM load)
 * per proof for this circuit, comfortably inside the 60 s task deadline.
 */
class Prover {
  constructor(circuitsDir) {
    this.wasmPath = path.join(circuitsDir, "gatekeeper.wasm");
    this.zkeyPath = path.join(circuitsDir, "gatekeeper_final.zkey");
  }

  async prove(circuitInputs) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      this.wasmPath,
      this.zkeyPath,
    );
    return { proof, publicSignals };
  }
}

module.exports = { Prover };
