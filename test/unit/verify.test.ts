import { expect } from "chai";
import { Wallet } from "ethers";
import type { Signer } from "ethers";
import { computeProofHash } from "../../src/proof/hash";
import { signProof } from "../../src/proof/signature";
import type { CheckName, ProofVerificationContext, VerificationResult } from "../../src/proof/verify";
import { verifyProofSubmission } from "../../src/proof/verify";

// Development-only key (Hardhat default account #1). Never used for real funds.
const robot = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const impostor = Wallet.createRandom();

const ctx: ProofVerificationContext = {
  task_id: "task_001",
  robot_id: "robot_001",
  robot_address: robot.address,
  start_position: { x: 0, y: 0, z: 0 },
  target_position: { x: 1, y: 0, z: 0 },
  tolerance: 0.05,
};

type AnyProof = Record<string, any>;

function makeProof(overrides: AnyProof = {}): AnyProof {
  return {
    task_id: "task_001",
    robot_id: "robot_001",
    timestamp: "2026-10-07T12:00:00Z",
    start_position: { x: 0, y: 0, z: 0 },
    target_position: { x: 1, y: 0, z: 0 },
    final_object_position: { x: 1.01, y: 0.01, z: 0 },
    success: true,
    ...overrides,
  };
}

async function submit(proof: AnyProof, signer: Signer = robot) {
  const { proof_hash, signature } = await signProof(proof, signer);
  return { proof, signature, proof_hash };
}

function check(result: VerificationResult, name: CheckName) {
  return result.checks.find((c) => c.name === name);
}

function expectRejected(result: VerificationResult, failedCheck: CheckName) {
  expect(result.outcome, JSON.stringify(result.checks)).to.equal("rejected");
  expect(check(result, failedCheck)?.ok, `check ${failedCheck}`).to.equal(false);
  expect(result.reasons.length).to.be.greaterThan(0);
}

describe("verifyProofSubmission", () => {
  describe("accepted proofs", () => {
    it("valid successful proof -> accepted & passed", async () => {
      const sub = await submit(makeProof());
      const res = verifyProofSubmission(sub, ctx);
      if (res.outcome !== "accepted") throw new Error(`expected accepted: ${res.reasons.join("; ")}`);
      expect(res.passed).to.equal(true);
      expect(res.reasons).to.deep.equal([]);
      expect(res.proof_hash).to.equal(sub.proof_hash);
      expect(res.signer).to.equal(robot.address);
      expect(res.signature).to.equal(sub.signature);
      expect(res.placement.within_tolerance).to.equal(true);
      expect(res.proof.task_id).to.equal("task_001");
      expect(res.canonical_proof.startsWith('{"final_object_position"')).to.equal(true);
      expect(res.checks.map((c) => c.name)).to.deep.equal([
        "submission_schema",
        "proof_schema",
        "task_id_match",
        "robot_id_match",
        "proof_hash",
        "signature",
        "task_geometry",
        "physical_placement",
        "success_claim",
      ]);
      expect(res.checks.every((c) => c.ok && c.detail.length > 0)).to.equal(true);
    });

    it("works without the optional claimed proof_hash", async () => {
      const { proof, signature } = await submit(makeProof());
      const res = verifyProofSubmission({ proof, signature }, ctx);
      expect(res.outcome).to.equal("accepted");
      expect(res.outcome === "accepted" && res.passed).to.equal(true);
    });

    it("object outside tolerance with success=false -> accepted & not passed", async () => {
      const res = verifyProofSubmission(
        await submit(makeProof({ final_object_position: { x: 0.5, y: 0, z: 0 }, success: false })),
        ctx,
      );
      if (res.outcome !== "accepted") throw new Error("expected accepted");
      expect(res.passed).to.equal(false);
      expect(res.placement.within_tolerance).to.equal(false);
      expect(check(res, "physical_placement")?.ok).to.equal(false);
      expect(check(res, "success_claim")?.ok).to.equal(true);
      expect(res.reasons.join(" ")).to.contain("robot reported failure (success=false)");
    });

    it("false success flag (claims success, object out of tolerance) -> accepted & not passed", async () => {
      const res = verifyProofSubmission(
        await submit(makeProof({ final_object_position: { x: 1.15, y: 0, z: 0 }, success: true })),
        ctx,
      );
      if (res.outcome !== "accepted") throw new Error("expected accepted");
      expect(res.passed).to.equal(false);
      expect(check(res, "success_claim")?.ok).to.equal(false);
      expect(check(res, "physical_placement")?.ok).to.equal(false);
      expect(res.reasons).to.deep.equal([
        "robot claimed success but final object position is 0.150 m from target (tolerance 0.050 m)",
      ]);
    });

    it("robot reported failure even though placement is within tolerance -> not passed", async () => {
      const res = verifyProofSubmission(await submit(makeProof({ success: false })), ctx);
      if (res.outcome !== "accepted") throw new Error("expected accepted");
      expect(res.passed).to.equal(false);
      expect(res.placement.within_tolerance).to.equal(true);
      expect(check(res, "success_claim")?.ok).to.equal(false);
      expect(res.reasons).to.deep.equal(["robot reported failure (success=false)"]);
    });

    it("measures against the TASK target, not the robot's success flag", async () => {
      const tight = { ...ctx, tolerance: 0.001 };
      const res = verifyProofSubmission(await submit(makeProof()), tight);
      if (res.outcome !== "accepted") throw new Error("expected accepted");
      expect(res.passed).to.equal(false);
    });

    it("accepts extra fields and covers them with the hash", async () => {
      const proof = makeProof({
        trajectory: [{ t_ms: 0, x: 0, y: 0, z: 0, gripper: "open" }],
        events: [{ t_ms: 10, type: "GRASP" }],
        simulator: { name: "isaac", version: "1" },
      });
      const sub = await submit(proof);
      const res = verifyProofSubmission(sub, ctx);
      if (res.outcome !== "accepted") throw new Error("expected accepted");
      expect(res.passed).to.equal(true);
      expect(res.proof_hash).to.not.equal(computeProofHash(makeProof()));
      expect(res.canonical_proof).to.contain('"trajectory"');
      expect((res.proof as AnyProof).simulator).to.deep.equal({ name: "isaac", version: "1" });
      // Extra fields on nested positions are preserved too.
      const nested = await submit(makeProof({ final_object_position: { x: 1, y: 0, z: 0, frame: "world" } }));
      const res2 = verifyProofSubmission(nested, ctx);
      expect(res2.outcome).to.equal("accepted");
      expect(res2.outcome === "accepted" && res2.canonical_proof).to.contain('"frame":"world"');

      // Tampering with an extra field after signing is detected.
      const tampered = { ...sub, proof: { ...proof, events: [] } };
      expectRejected(verifyProofSubmission(tampered, ctx), "signature");
    });

    it("survives a JSON round-trip (HTTP transport)", async () => {
      const sub = await submit(makeProof({ trajectory: [{ t_ms: 0, x: 0.1234, y: -0, z: 1e-7 }] }));
      const res = verifyProofSubmission(JSON.parse(JSON.stringify(sub)), ctx);
      expect(res.outcome).to.equal("accepted");
    });
  });

  describe("rejected proofs", () => {
    it("wrong task_id", async () => {
      const res = verifyProofSubmission(await submit(makeProof({ task_id: "task_999" })), ctx);
      expectRejected(res, "task_id_match");
      expect(res.reasons.join(" ")).to.contain("task_999");
    });

    it("wrong robot_id", async () => {
      expectRejected(verifyProofSubmission(await submit(makeProof({ robot_id: "robot_666" })), ctx), "robot_id_match");
    });

    it("wrong signer", async () => {
      const res = verifyProofSubmission(await submit(makeProof(), impostor), ctx);
      expectRejected(res, "signature");
      expect(check(res, "signature")?.detail).to.contain("signed by an unregistered key");
      expect(res.proof_hash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("proof modified after signing (no claimed hash)", async () => {
      const { proof, signature } = await submit(makeProof({ final_object_position: { x: 0.2, y: 0, z: 0 } }));
      const tampered = { ...proof, final_object_position: { x: 1, y: 0, z: 0 } };
      const res = verifyProofSubmission({ proof: tampered, signature }, ctx);
      expectRejected(res, "signature");
      expect(check(res, "signature")?.detail).to.contain("proof was modified after signing");
    });

    it("proof modified after signing (with original claimed hash)", async () => {
      const sub = await submit(makeProof({ success: false }));
      const res = verifyProofSubmission({ ...sub, proof: { ...sub.proof, success: true } }, ctx);
      expectRejected(res, "proof_hash");
      expect(check(res, "proof_hash")?.detail).to.contain("tampered");
      expect(check(res, "signature")?.ok).to.equal(false);
    });

    it("claimed proof_hash mismatch", async () => {
      const sub = await submit(makeProof());
      const res = verifyProofSubmission({ ...sub, proof_hash: "0x" + "ab".repeat(32) }, ctx);
      expectRejected(res, "proof_hash");
    });

    it("claimed proof_hash comparison is case-insensitive", async () => {
      const sub = await submit(makeProof());
      const res = verifyProofSubmission({ ...sub, proof_hash: "0x" + sub.proof_hash.slice(2).toUpperCase() }, ctx);
      expect(res.outcome).to.equal("accepted");
    });

    it("target_position differs from the task", async () => {
      const res = verifyProofSubmission(
        await submit(makeProof({ target_position: { x: 1.01, y: 0.01, z: 0 } })),
        ctx,
      );
      expectRejected(res, "task_geometry");
      expect(res.reasons.join(" ")).to.contain("target_position");
    });

    it("start_position differs from the task", async () => {
      expectRejected(
        verifyProofSubmission(await submit(makeProof({ start_position: { x: 0.5, y: 0, z: 0 } })), ctx),
        "task_geometry",
      );
    });

    it("reports every integrity failure, not just the first", async () => {
      const res = verifyProofSubmission(await submit(makeProof({ task_id: "task_x" }), impostor), ctx);
      expect(res.outcome).to.equal("rejected");
      expect(check(res, "task_id_match")?.ok).to.equal(false);
      expect(check(res, "signature")?.ok).to.equal(false);
      expect(res.reasons).to.have.length(2);
    });

    it("signature with invalid v (valid hex format) -> rejected, not thrown", async () => {
      const sub = await submit(makeProof());
      const res = verifyProofSubmission({ ...sub, signature: sub.signature.slice(0, -2) + "00" }, ctx);
      expectRejected(res, "signature");
    });

    it("all-zero signature -> rejected, not thrown", async () => {
      const sub = await submit(makeProof());
      expectRejected(verifyProofSubmission({ ...sub, signature: "0x" + "00".repeat(65) }, ctx), "signature");
    });
  });

  describe("malformed input never throws", () => {
    const validSubmissionPromise = submit(makeProof());

    const envelopeCases: Array<[string, (s: AnyProof) => unknown]> = [
      ["null", () => null],
      ["undefined", () => undefined],
      ["string", () => "not json"],
      ["number", () => 42],
      ["array", (s) => [s]],
      ["missing proof", (s) => ({ signature: s.signature })],
      ["proof is an array", (s) => ({ ...s, proof: [s.proof] })],
      ["proof is a string", (s) => ({ ...s, proof: JSON.stringify(s.proof) })],
      ["missing signature", (s) => ({ proof: s.proof })],
      ["signature not hex", (s) => ({ ...s, signature: "hello" })],
      ["signature too short", (s) => ({ ...s, signature: s.signature.slice(0, 100) })],
      ["signature without 0x", (s) => ({ ...s, signature: s.signature.slice(2) + "00" })],
      ["signature wrong type", (s) => ({ ...s, signature: 123 })],
      ["proof_hash malformed", (s) => ({ ...s, proof_hash: "0x1234" })],
    ];
    for (const [label, build] of envelopeCases) {
      it(`submission: ${label}`, async () => {
        const sub = await validSubmissionPromise;
        expectRejected(verifyProofSubmission(build(sub), ctx), "submission_schema");
      });
    }

    const proofCases: Array<[string, (p: AnyProof) => AnyProof]> = [
      ["missing task_id", ({ task_id, ...rest }) => rest],
      ["missing final_object_position", ({ final_object_position, ...rest }) => rest],
      ["missing success", ({ success, ...rest }) => rest],
      ["empty task_id", (p) => ({ ...p, task_id: "" })],
      ["task_id wrong type", (p) => ({ ...p, task_id: 1 })],
      ["success as string", (p) => ({ ...p, success: "true" })],
      ["coordinate as string", (p) => ({ ...p, final_object_position: { x: "1", y: 0, z: 0 } })],
      ["coordinate missing", (p) => ({ ...p, target_position: { x: 1, y: 0 } })],
      ["coordinate null", (p) => ({ ...p, start_position: { x: null, y: 0, z: 0 } })],
      ["position is null", (p) => ({ ...p, final_object_position: null })],
      ["bad timestamp", (p) => ({ ...p, timestamp: "yesterday" })],
      ["timestamp without time", (p) => ({ ...p, timestamp: "2026-10-07" })],
    ];
    for (const [label, mutate] of proofCases) {
      it(`proof: ${label}`, async () => {
        const proof = mutate(makeProof());
        const { signature } = await submit(proof);
        const res = verifyProofSubmission({ proof, signature }, ctx);
        expectRejected(res, "proof_schema");
        expect(check(res, "proof_schema")?.detail).to.contain("proof.");
      });
    }

    it("proof with a non-JSON value in an extra field -> rejected at proof_hash", async () => {
      const { signature } = await submit(makeProof());
      const res = verifyProofSubmission({ proof: makeProof({ extra: new Date(0) }), signature }, ctx);
      expectRejected(res, "proof_hash");
      expect(check(res, "signature")).to.equal(undefined);
    });

    it("throws only for an invalid verifier context (server bug)", async () => {
      const sub = await validSubmissionPromise;
      expect(() => verifyProofSubmission(sub, { ...ctx, tolerance: -1 })).to.throw(RangeError);
    });
  });
});
