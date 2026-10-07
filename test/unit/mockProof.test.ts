import { expect } from "chai";
import { Wallet } from "ethers";
import { computeProofHash } from "../../src/proof/hash";
import { distance3d } from "../../src/proof/physical";
import { RobotProofSchema } from "../../src/proof/schema";
import { signProof } from "../../src/proof/signature";
import { verifyProofSubmission } from "../../src/proof/verify";
import type { MockTaskSpec } from "../../src/robot/mockProof";
import { MOCK_OUTCOMES, generateMockProof } from "../../src/robot/mockProof";

/** Small deterministic PRNG (mulberry32) for reproducible mock proofs. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const spec: MockTaskSpec = {
  task_id: "task_001",
  robot_id: "robot_001",
  start_position: { x: 0, y: 0, z: 0 },
  target_position: { x: 1, y: 0, z: 0 },
  tolerance: 0.05,
};
const NOW = new Date("2026-10-07T12:00:00Z");
type AnyProof = Record<string, any>;

describe("generateMockProof", () => {
  it("exposes all outcomes", () => {
    expect([...MOCK_OUTCOMES]).to.deep.equal(["success", "failure", "false_success"]);
  });

  for (const outcome of MOCK_OUTCOMES) {
    it(`${outcome}: produces a schema-valid, realistic proof`, () => {
      const proof = generateMockProof(spec, outcome, { rng: seededRng(1), now: NOW }) as AnyProof;
      expect(RobotProofSchema.safeParse(proof).success).to.equal(true);
      expect(proof.task_id).to.equal(spec.task_id);
      expect(proof.robot_id).to.equal(spec.robot_id);
      expect(proof.timestamp).to.equal("2026-10-07T12:00:00.000Z");
      expect(proof.start_position).to.deep.equal(spec.start_position);
      expect(proof.target_position).to.deep.equal(spec.target_position);
      expect(proof.simulator).to.deep.equal({ name: "mock-sim", version: "0.1.0" });

      expect(proof.trajectory.length).to.be.within(6, 12);
      let lastT = -1;
      for (const wp of proof.trajectory) {
        expect(wp).to.have.all.keys("t_ms", "x", "y", "z", "gripper");
        expect(["open", "closed"]).to.include(wp.gripper);
        expect(wp.t_ms).to.be.at.least(lastT);
        lastT = wp.t_ms;
        for (const c of [wp.x, wp.y, wp.z]) expect(Math.round(c * 1e4) / 1e4).to.equal(c);
      }
      expect(proof.trajectory[0]).to.include({ x: 0, y: 0, z: 0, gripper: "open" });
      expect(Math.max(...proof.trajectory.map((w: AnyProof) => w.z))).to.be.closeTo(0.15, 1e-9);
      expect(proof.duration_ms).to.equal(proof.trajectory[proof.trajectory.length - 1].t_ms);
      expect(proof.events.map((e: AnyProof) => e.type).slice(0, 3)).to.deep.equal(["GRASP", "LIFT", "MOVE"]);
      for (const c of Object.values(proof.final_object_position) as number[]) {
        expect(Math.round(c * 1e4) / 1e4).to.equal(c);
      }
    });
  }

  it("success: object placed within 40% of tolerance, success=true", () => {
    for (let seed = 0; seed < 50; seed++) {
      const proof = generateMockProof(spec, "success", { rng: seededRng(seed), now: NOW }) as AnyProof;
      expect(proof.success).to.equal(true);
      expect(distance3d(proof.final_object_position, spec.target_position)).to.be.at.most(0.4 * spec.tolerance);
      expect(proof.events.map((e: AnyProof) => e.type)).to.deep.equal(["GRASP", "LIFT", "MOVE", "PLACE", "RELEASE"]);
      const last = proof.trajectory[proof.trajectory.length - 1];
      expect(last.gripper).to.equal("open");
    }
  });

  it("failure: object dropped mid-route onto the ground, success=false", () => {
    for (let seed = 0; seed < 50; seed++) {
      const proof = generateMockProof(spec, "failure", { rng: seededRng(seed), now: NOW }) as AnyProof;
      expect(proof.success).to.equal(false);
      expect(proof.final_object_position.z).to.equal(0);
      // start (0,0,0) -> target (1,0,0): progress == x
      expect(proof.final_object_position.x).to.be.within(0.35, 0.65);
      expect(proof.events.map((e: AnyProof) => e.type)).to.include("DROP");
      expect(proof.events.map((e: AnyProof) => e.type)).to.not.include("PLACE");
    }
  });

  it("false_success: object clearly outside tolerance (>= 3x) but success=true", () => {
    for (let seed = 0; seed < 50; seed++) {
      const proof = generateMockProof(spec, "false_success", { rng: seededRng(seed), now: NOW }) as AnyProof;
      expect(proof.success).to.equal(true);
      expect(distance3d(proof.final_object_position, spec.target_position)).to.be.at.least(3 * spec.tolerance);
    }
  });

  it("handles non-origin, elevated and tiny-tolerance task specs", () => {
    const odd: MockTaskSpec = {
      ...spec,
      start_position: { x: -0.33333, y: 2.123456, z: 0.75 },
      target_position: { x: 1.987654, y: -0.5, z: 0.75 },
      tolerance: 0.0001,
    };
    const ok = generateMockProof(odd, "success", { rng: seededRng(7) }) as AnyProof;
    expect(ok.start_position).to.deep.equal(odd.start_position); // echoed verbatim
    expect(distance3d(ok.final_object_position, odd.target_position)).to.be.at.most(0.4 * odd.tolerance);
    const lying = generateMockProof(odd, "false_success", { rng: seededRng(7) }) as AnyProof;
    expect(distance3d(lying.final_object_position, odd.target_position)).to.be.at.least(3 * odd.tolerance);
  });

  it("is deterministic with a seeded rng and fixed clock", () => {
    for (const outcome of MOCK_OUTCOMES) {
      const a = generateMockProof(spec, outcome, { rng: seededRng(42), now: NOW });
      const b = generateMockProof(spec, outcome, { rng: seededRng(42), now: NOW });
      expect(a).to.deep.equal(b);
      expect(computeProofHash(a)).to.equal(computeProofHash(b));
    }
    const c = generateMockProof(spec, "success", { rng: seededRng(43), now: NOW });
    expect(computeProofHash(c)).to.not.equal(computeProofHash(generateMockProof(spec, "success", { rng: seededRng(42), now: NOW })));
  });

  it("rejects unknown outcomes and invalid tolerance", () => {
    expect(() => generateMockProof(spec, "teleport" as never)).to.throw(/unknown mock outcome/);
    expect(() => generateMockProof({ ...spec, tolerance: -1 }, "success")).to.throw(RangeError);
  });

  describe("end-to-end with the verifier (signed by the robot key)", () => {
    const robot = Wallet.createRandom();
    const ctx = { ...spec, robot_address: robot.address };

    async function verify(outcome: (typeof MOCK_OUTCOMES)[number], seed: number) {
      const proof = generateMockProof(spec, outcome, { rng: seededRng(seed), now: NOW });
      const { proof_hash, signature } = await signProof(proof, robot);
      // Simulate HTTP transport.
      const wire = JSON.parse(JSON.stringify({ proof, signature, proof_hash }));
      return verifyProofSubmission(wire, ctx);
    }

    for (const seed of [1, 2, 3, 4, 5]) {
      it(`seed ${seed}: success -> passed, failure -> not passed, false_success -> not passed`, async () => {
        const ok = await verify("success", seed);
        expect(ok.outcome).to.equal("accepted");
        expect(ok.outcome === "accepted" && ok.passed).to.equal(true);

        const fail = await verify("failure", seed);
        expect(fail.outcome).to.equal("accepted");
        expect(fail.outcome === "accepted" && fail.passed).to.equal(false);

        const lie = await verify("false_success", seed);
        expect(lie.outcome).to.equal("accepted");
        if (lie.outcome !== "accepted") return;
        expect(lie.passed).to.equal(false);
        expect(lie.checks.find((c) => c.name === "success_claim")?.ok).to.equal(false);
      });
    }
  });
});
