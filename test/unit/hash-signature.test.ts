import { expect } from "chai";
import { Signature, Wallet, concat, getBytes, hashMessage, keccak256, solidityPackedKeccak256, toBeHex, toUtf8Bytes } from "ethers";
import { computeProofHash, hashCanonicalProof } from "../../src/proof/hash";
import { isValidProofSignature, recoverProofSigner, signProof, signProofHash } from "../../src/proof/signature";

// Development-only key (Hardhat default account #1). Never used for real funds.
const ROBOT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function sampleProof(): Record<string, unknown> {
  return {
    task_id: "task_001",
    robot_id: "robot_001",
    timestamp: "2026-10-07T12:00:00Z",
    start_position: { x: 0, y: 0, z: 0 },
    target_position: { x: 1, y: 0, z: 0 },
    final_object_position: { x: 1.01, y: 0.01, z: 0 },
    success: true,
  };
}

const SAMPLE_CANONICAL =
  '{"final_object_position":{"x":1.01,"y":0.01,"z":0},"robot_id":"robot_001","start_position":{"x":0,"y":0,"z":0},' +
  '"success":true,"target_position":{"x":1,"y":0,"z":0},"task_id":"task_001","timestamp":"2026-10-07T12:00:00Z"}';

describe("proof hash", () => {
  it("is keccak256 of the UTF-8 canonical proof, as 0x + 64 hex", () => {
    const { canonical_proof, proof_hash } = hashCanonicalProof(sampleProof());
    expect(canonical_proof).to.equal(SAMPLE_CANONICAL);
    expect(proof_hash).to.match(/^0x[0-9a-f]{64}$/);
    expect(proof_hash).to.equal(keccak256(toUtf8Bytes(SAMPLE_CANONICAL)));
    expect(computeProofHash(sampleProof())).to.equal(proof_hash);
  });

  it("is deterministic and unchanged by key reordering or JSON round-trips", () => {
    const proof = sampleProof();
    const reordered = Object.fromEntries(Object.entries(proof).reverse());
    expect(computeProofHash(proof)).to.equal(computeProofHash(proof));
    expect(computeProofHash(reordered)).to.equal(computeProofHash(proof));
    expect(computeProofHash(JSON.parse(JSON.stringify(proof)))).to.equal(computeProofHash(proof));
  });

  it("changes when any field changes, including extra fields", () => {
    const base = computeProofHash(sampleProof());
    const mutations: Array<(p: Record<string, any>) => void> = [
      (p) => (p.task_id = "task_002"),
      (p) => (p.success = false),
      (p) => (p.final_object_position.x = 1.0100001),
      (p) => (p.timestamp = "2026-10-07T12:00:01Z"),
      (p) => (p.trajectory = [{ t_ms: 0, x: 0, y: 0, z: 0 }]),
    ];
    for (const mutate of mutations) {
      const p = sampleProof();
      mutate(p);
      expect(computeProofHash(p)).to.not.equal(base);
    }

    const withTrajectory = { ...sampleProof(), trajectory: [{ t_ms: 0, x: 0 }] };
    const changedTrajectory = { ...sampleProof(), trajectory: [{ t_ms: 0, x: 0.0001 }] };
    expect(computeProofHash(withTrajectory)).to.not.equal(computeProofHash(changedTrajectory));
  });

  it("throws for values that cannot be canonicalized", () => {
    expect(() => computeProofHash({ x: NaN })).to.throw();
  });
});

describe("proof signatures (EIP-191 over the 32-byte proof hash)", () => {
  const robot = new Wallet(ROBOT_KEY);
  const other = Wallet.createRandom();

  it("signs the digest the Solidity contract recomputes (toEthSignedMessageHash(bytes32))", async () => {
    const proofHash = computeProofHash(sampleProof());
    const signature = await signProofHash(proofHash, robot);
    const ethSignedDigest = solidityPackedKeccak256(["string", "bytes32"], ["\x19Ethereum Signed Message:\n32", proofHash]);
    expect(hashMessage(getBytes(proofHash))).to.equal(ethSignedDigest);
    expect(Signature.from(signature).serialized).to.equal(signature);
    expect(signature).to.match(/^0x[0-9a-f]{130}$/);
  });

  it("accepts a valid signature and recovers the robot address", async () => {
    const { proof_hash, signature } = await signProof(sampleProof(), robot);
    expect(proof_hash).to.equal(computeProofHash(sampleProof()));
    expect(recoverProofSigner(proof_hash, signature)).to.equal(robot.address);
    expect(isValidProofSignature(proof_hash, signature, robot.address)).to.equal(true);
    expect(isValidProofSignature(proof_hash, signature, robot.address.toLowerCase())).to.equal(true);
  });

  it("rejects a signature from the wrong signer", async () => {
    const { proof_hash, signature } = await signProof(sampleProof(), other);
    expect(isValidProofSignature(proof_hash, signature, robot.address)).to.equal(false);
    expect(recoverProofSigner(proof_hash, signature)).to.equal(other.address);
  });

  it("rejects a proof modified after signing", async () => {
    const proof = sampleProof();
    const { signature } = await signProof(proof, robot);
    (proof.final_object_position as { x: number }).x = 1.0; // tamper
    const tamperedHash = computeProofHash(proof);
    expect(isValidProofSignature(tamperedHash, signature, robot.address)).to.equal(false);
    expect(recoverProofSigner(tamperedHash, signature)).to.not.equal(robot.address);
  });

  it("rejects an invalid (bit-flipped) signature", async () => {
    const { proof_hash, signature } = await signProof(sampleProof(), robot);
    const flipped = signature.slice(0, 10) + (signature[10] === "0" ? "1" : "0") + signature.slice(11);
    expect(isValidProofSignature(proof_hash, flipped, robot.address)).to.equal(false);
  });

  it("treats malformed signatures as invalid (and recoverProofSigner throws)", async () => {
    const proofHash = computeProofHash(sampleProof());
    const malformed = ["0x1234", "not-a-signature", "", "0x" + "zz".repeat(65), "0x" + "00".repeat(65)];
    for (const sig of malformed) {
      expect(isValidProofSignature(proofHash, sig, robot.address), sig).to.equal(false);
      expect(() => recoverProofSigner(proofHash, sig), sig).to.throw();
    }
    expect(isValidProofSignature(proofHash, undefined as unknown as string, robot.address)).to.equal(false);
  });

  it("matches OpenZeppelin ECDSA strictness: rejects v=0/1 and high-s malleated signatures", async () => {
    const proofHash = computeProofHash(sampleProof());
    const sig = Signature.from(await signProofHash(proofHash, robot));

    // ethers alone would accept v=0/1, but the contract (ecrecover) would not.
    const vZero = concat([sig.r, sig.s, new Uint8Array([sig.v - 27])]);
    expect(() => recoverProofSigner(proofHash, vZero)).to.throw(/v must be 27 or 28/);
    expect(isValidProofSignature(proofHash, vZero, robot.address)).to.equal(false);

    const n = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    const highS = concat([sig.r, toBeHex(n - BigInt(sig.s), 32), new Uint8Array([sig.v === 27 ? 28 : 27])]);
    expect(isValidProofSignature(proofHash, highS, robot.address)).to.equal(false);
  });

  it("rejects malformed proof hashes", async () => {
    const { signature } = await signProof(sampleProof(), robot);
    expect(() => recoverProofSigner("0x1234", signature)).to.throw(/invalid proof hash/);
    expect(isValidProofSignature("0x1234", signature, robot.address)).to.equal(false);
    let threw = false;
    try {
      await signProofHash("0xabc", robot);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
