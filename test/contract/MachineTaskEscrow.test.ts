import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { MachineTaskEscrow, ReentrantPayee } from "../../typechain-types";

// Mirrors the Solidity enum MachineTaskEscrow.TaskStatus.
enum TaskStatus {
  None = 0,
  Funded = 1,
  Verified = 2,
  Failed = 3,
  Settled = 4,
  Refunded = 5,
}

// Same conventions as the backend: string task id -> keccak256(utf8) bytes32.
const taskIdOf = (id: string): string => ethers.keccak256(ethers.toUtf8Bytes(id));
const hashOf = (s: string): string => ethers.keccak256(ethers.toUtf8Bytes(s));

const TASK_ID = taskIdOf("task_001");
const TASK_ID_2 = taskIdOf("task_002");
const PROOF_HASH = hashOf('{"task_id":"task_001"}');
const PROOF_HASH_2 = hashOf('{"task_id":"task_002"}');
const AMOUNT = ethers.parseEther("1");
const AMOUNT_2 = ethers.parseEther("0.25");
const ZERO_HASH = ethers.ZeroHash;

// secp256k1 curve order, used to build a malleable (high-s) signature.
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

/** Robot signature convention: EIP-191 personal_sign over the 32 raw bytes of the proof hash. */
async function signProof(signer: HardhatEthersSigner, proofHash: string): Promise<string> {
  return signer.signMessage(ethers.getBytes(proofHash));
}

/** Address the contract will recover for `signature` over `proofHash` (EIP-191 over raw bytes). */
function recoverAsContract(proofHash: string, signature: string): string {
  return ethers.verifyMessage(ethers.getBytes(proofHash), signature);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [verifier, requester, robot, payee, stranger] = await ethers.getSigners();
  const escrow: MachineTaskEscrow = await ethers.deployContract("MachineTaskEscrow", [verifier.address]);
  await escrow.waitForDeployment();
  return { escrow, verifier, requester, robot, payee, stranger };
}

async function fundedFixture() {
  const ctx = await deployFixture();
  const { escrow, requester, robot, payee } = ctx;
  await escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT });
  return ctx;
}

async function verifiedFixture() {
  const ctx = await fundedFixture();
  const { escrow, verifier, robot } = ctx;
  const sig = await signProof(robot, PROOF_HASH);
  await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig);
  return ctx;
}

async function failedFixture() {
  const ctx = await fundedFixture();
  const { escrow, verifier, robot } = ctx;
  const sig = await signProof(robot, PROOF_HASH);
  await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, false, sig);
  return ctx;
}

async function settledFixture() {
  const ctx = await verifiedFixture();
  await ctx.escrow.connect(ctx.verifier).settle(TASK_ID);
  return ctx;
}

async function refundedFixture() {
  const ctx = await failedFixture();
  await ctx.escrow.connect(ctx.requester).refund(TASK_ID);
  return ctx;
}

async function reentrantFixture() {
  const ctx = await deployFixture();
  const attacker: ReentrantPayee = await ethers.deployContract("ReentrantPayee", [await ctx.escrow.getAddress()]);
  await attacker.waitForDeployment();
  return { ...ctx, attacker };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MachineTaskEscrow", function () {
  describe("deployment", function () {
    it("sets the verifier", async function () {
      const { escrow, verifier } = await loadFixture(deployFixture);
      expect(await escrow.verifier()).to.equal(verifier.address);
    });

    it("reverts with InvalidAddress for a zero-address verifier", async function () {
      const factory = await ethers.getContractFactory("MachineTaskEscrow");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "InvalidAddress");
    });

    it("starts with no tasks and no used proof hashes", async function () {
      const { escrow } = await loadFixture(deployFixture);
      const task = await escrow.getTask(TASK_ID);
      expect(task.status).to.equal(TaskStatus.None);
      expect(task.requester).to.equal(ethers.ZeroAddress);
      expect(task.amount).to.equal(0n);
      expect(await escrow.proofHashUsed(PROOF_HASH)).to.equal(false);
    });

    it("rejects plain ETH transfers (no receive/fallback), so escrow only holds task funds", async function () {
      const { escrow, stranger } = await loadFixture(deployFixture);
      await expect(stranger.sendTransaction({ to: await escrow.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("fundTask", function () {
    it("funds a task: emits TaskFunded, locks value, stores task data", async function () {
      const { escrow, requester, robot, payee } = await loadFixture(deployFixture);

      const tx = escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT });
      await expect(tx)
        .to.emit(escrow, "TaskFunded")
        .withArgs(TASK_ID, requester.address, robot.address, payee.address, AMOUNT);
      await expect(tx).to.changeEtherBalances([escrow, requester], [AMOUNT, -AMOUNT]);

      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(AMOUNT);

      const task = await escrow.getTask(TASK_ID);
      expect(task.requester).to.equal(requester.address);
      expect(task.robot).to.equal(robot.address);
      expect(task.payee).to.equal(payee.address);
      expect(task.amount).to.equal(AMOUNT);
      expect(task.status).to.equal(TaskStatus.Funded);
      expect(task.proofHash).to.equal(ZERO_HASH);
    });

    it("reverts with ZeroAmount when no value is sent", async function () {
      const { escrow, requester, robot, payee } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: 0 }),
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("reverts with InvalidAddress for a zero robot", async function () {
      const { escrow, requester, payee } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(requester).fundTask(TASK_ID, ethers.ZeroAddress, payee.address, { value: AMOUNT }),
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("reverts with InvalidAddress for a zero payee", async function () {
      const { escrow, requester, robot } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(requester).fundTask(TASK_ID, robot.address, ethers.ZeroAddress, { value: AMOUNT }),
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("reverts with TaskAlreadyExists when the same taskId is funded twice", async function () {
      const { escrow, requester, robot, payee } = await loadFixture(fundedFixture);
      await expect(
        escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT }),
      )
        .to.be.revertedWithCustomError(escrow, "TaskAlreadyExists")
        .withArgs(TASK_ID);
    });

    it("does not allow a settled taskId to be re-funded (ids are never recycled)", async function () {
      const { escrow, requester, robot, payee } = await loadFixture(settledFixture);
      await expect(
        escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT }),
      )
        .to.be.revertedWithCustomError(escrow, "TaskAlreadyExists")
        .withArgs(TASK_ID);
    });

    it("does not allow a refunded taskId to be re-funded", async function () {
      const { escrow, requester, robot, payee } = await loadFixture(refundedFixture);
      await expect(
        escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT }),
      )
        .to.be.revertedWithCustomError(escrow, "TaskAlreadyExists")
        .withArgs(TASK_ID);
    });

    it("(known limitation) anyone can fund a taskId first, blocking the intended requester", async function () {
      // Task ids are deterministic (keccak256 of the backend string id), so a third party can
      // squat an id. Funds are not at risk (the squatter only escrows their own ETH), but the
      // legitimate fundTask reverts. The backend must check getTask() requester/payee/amount.
      const { escrow, requester, robot, payee, stranger } = await loadFixture(deployFixture);
      await escrow.connect(stranger).fundTask(TASK_ID, robot.address, stranger.address, { value: 1n });
      await expect(
        escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT }),
      )
        .to.be.revertedWithCustomError(escrow, "TaskAlreadyExists")
        .withArgs(TASK_ID);
      expect((await escrow.getTask(TASK_ID)).requester).to.equal(stranger.address);
    });
  });

  describe("commitProof", function () {
    it("verifier commits a passing proof -> Verified, proofHash stored and marked used", async function () {
      const { escrow, verifier, robot } = await loadFixture(fundedFixture);
      const sig = await signProof(robot, PROOF_HASH);

      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
        .to.emit(escrow, "ProofCommitted")
        .withArgs(TASK_ID, PROOF_HASH, true);

      const task = await escrow.getTask(TASK_ID);
      expect(task.status).to.equal(TaskStatus.Verified);
      expect(task.proofHash).to.equal(PROOF_HASH);
      expect(task.amount).to.equal(AMOUNT);
      expect(await escrow.proofHashUsed(PROOF_HASH)).to.equal(true);
    });

    it("verifier commits a failing proof -> Failed (hash still recorded and used)", async function () {
      const { escrow, verifier, robot } = await loadFixture(fundedFixture);
      const sig = await signProof(robot, PROOF_HASH);

      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, false, sig))
        .to.emit(escrow, "ProofCommitted")
        .withArgs(TASK_ID, PROOF_HASH, false);

      const task = await escrow.getTask(TASK_ID);
      expect(task.status).to.equal(TaskStatus.Failed);
      expect(task.proofHash).to.equal(PROOF_HASH);
      expect(await escrow.proofHashUsed(PROOF_HASH)).to.equal(true);
    });

    it("committing a proof does not move any funds", async function () {
      const { escrow, verifier, robot, payee, requester } = await loadFixture(fundedFixture);
      const sig = await signProof(robot, PROOF_HASH);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig)).to.changeEtherBalances(
        [escrow, payee, requester],
        [0n, 0n, 0n],
      );
    });

    for (const who of ["requester", "robot", "payee", "stranger"] as const) {
      it(`reverts with NotVerifier when called by the ${who}`, async function () {
        const ctx = await loadFixture(fundedFixture);
        const sig = await signProof(ctx.robot, PROOF_HASH);
        await expect(
          ctx.escrow.connect(ctx[who]).commitProof(TASK_ID, PROOF_HASH, true, sig),
        ).to.be.revertedWithCustomError(ctx.escrow, "NotVerifier");
      });
    }

    it("reverts with InvalidRobotSignature for a signature from the wrong key", async function () {
      const { escrow, verifier, robot, stranger } = await loadFixture(fundedFixture);
      const sig = await signProof(stranger, PROOF_HASH);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidRobotSignature")
        .withArgs(stranger.address, robot.address);
    });

    it("reverts with InvalidRobotSignature when the verifier signs the proof itself", async function () {
      const { escrow, verifier, robot } = await loadFixture(fundedFixture);
      const sig = await signProof(verifier, PROOF_HASH);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidRobotSignature")
        .withArgs(verifier.address, robot.address);
    });

    it("reverts with InvalidRobotSignature for a tampered proof (signature over a different hash)", async function () {
      const { escrow, verifier, robot } = await loadFixture(fundedFixture);
      const tamperedHash = hashOf('{"task_id":"task_001","success":false}');
      // Robot signed the tampered proof; verifier submits the original hash with that signature.
      const sig = await signProof(robot, tamperedHash);
      const recovered = recoverAsContract(PROOF_HASH, sig);
      expect(recovered).to.not.equal(robot.address);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidRobotSignature")
        .withArgs(recovered, robot.address);
    });

    it("reverts with InvalidRobotSignature if the robot signs the hex string instead of the 32 raw bytes", async function () {
      // Guards the backend convention: signMessage(getBytes(hash)), NOT signMessage(hash).
      const { escrow, verifier, robot } = await loadFixture(fundedFixture);
      const wrongConventionSig = await robot.signMessage(PROOF_HASH);
      const recovered = recoverAsContract(PROOF_HASH, wrongConventionSig);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, wrongConventionSig))
        .to.be.revertedWithCustomError(escrow, "InvalidRobotSignature")
        .withArgs(recovered, robot.address);
    });

    it("reverts with InvalidRobotSignature for a raw (non EIP-191 prefixed) signature", async function () {
      const { escrow, verifier, requester, payee } = await loadFixture(deployFixture);
      const robotWallet = ethers.Wallet.createRandom();
      await escrow.connect(requester).fundTask(TASK_ID, robotWallet.address, payee.address, { value: AMOUNT });
      const rawSig = robotWallet.signingKey.sign(PROOF_HASH).serialized;
      const recovered = recoverAsContract(PROOF_HASH, rawSig);
      expect(recovered).to.not.equal(robotWallet.address);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, rawSig))
        .to.be.revertedWithCustomError(escrow, "InvalidRobotSignature")
        .withArgs(recovered, robotWallet.address);
    });

    it("accepts a signature from an off-chain ethers Wallet robot identity", async function () {
      const { escrow, verifier, requester, payee } = await loadFixture(deployFixture);
      const robotWallet = ethers.Wallet.createRandom();
      await escrow.connect(requester).fundTask(TASK_ID, robotWallet.address, payee.address, { value: AMOUNT });
      const sig = await robotWallet.signMessage(ethers.getBytes(PROOF_HASH));
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
        .to.emit(escrow, "ProofCommitted")
        .withArgs(TASK_ID, PROOF_HASH, true);
    });

    it("reverts with InvalidRobotSignature when another task's robot signed the proof", async function () {
      const { escrow, verifier, requester, robot, payee, stranger } = await loadFixture(fundedFixture);
      // task_002 is assigned to a different robot (stranger); task_001's robot signs for it.
      await escrow.connect(requester).fundTask(TASK_ID_2, stranger.address, payee.address, { value: AMOUNT_2 });
      const sig = await signProof(robot, PROOF_HASH_2);
      await expect(escrow.connect(verifier).commitProof(TASK_ID_2, PROOF_HASH_2, true, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidRobotSignature")
        .withArgs(robot.address, stranger.address);
    });

    it("reverts with InvalidStatus on an unfunded (unknown) task", async function () {
      const { escrow, verifier, robot } = await loadFixture(deployFixture);
      const sig = await signProof(robot, PROOF_HASH);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.None, TaskStatus.Funded);
    });

    it("reverts with InvalidStatus on a second commit to a Verified task (duplicate proof)", async function () {
      const { escrow, verifier, robot } = await loadFixture(verifiedFixture);
      // Same proof again.
      const sig = await signProof(robot, PROOF_HASH);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Verified, TaskStatus.Funded);
      // A different, fresh proof cannot overwrite the committed one either.
      const otherHash = hashOf('{"task_id":"task_001","attempt":2}');
      const otherSig = await signProof(robot, otherHash);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, otherHash, false, otherSig))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Verified, TaskStatus.Funded);
      const task = await escrow.getTask(TASK_ID);
      expect(task.status).to.equal(TaskStatus.Verified);
      expect(task.proofHash).to.equal(PROOF_HASH);
    });

    it("reverts with InvalidStatus when trying to flip a Failed task to passing", async function () {
      const { escrow, verifier, robot } = await loadFixture(failedFixture);
      const otherHash = hashOf('{"task_id":"task_001","success":true}');
      const sig = await signProof(robot, otherHash);
      await expect(escrow.connect(verifier).commitProof(TASK_ID, otherHash, true, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Failed, TaskStatus.Funded);
    });

    it("reverts with InvalidStatus on Settled and Refunded tasks", async function () {
      const settled = await loadFixture(settledFixture);
      const h1 = hashOf("late-proof-1");
      await expect(
        settled.escrow.connect(settled.verifier).commitProof(TASK_ID, h1, true, await signProof(settled.robot, h1)),
      )
        .to.be.revertedWithCustomError(settled.escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Settled, TaskStatus.Funded);

      const refunded = await loadFixture(refundedFixture);
      const h2 = hashOf("late-proof-2");
      await expect(
        refunded.escrow
          .connect(refunded.verifier)
          .commitProof(TASK_ID, h2, true, await signProof(refunded.robot, h2)),
      )
        .to.be.revertedWithCustomError(refunded.escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Refunded, TaskStatus.Funded);
    });

    it("reverts with ProofAlreadyUsed when a proof hash is replayed on another funded task", async function () {
      const { escrow, verifier, requester, robot, payee } = await loadFixture(verifiedFixture);
      await escrow.connect(requester).fundTask(TASK_ID_2, robot.address, payee.address, { value: AMOUNT_2 });
      const sig = await signProof(robot, PROOF_HASH);
      await expect(escrow.connect(verifier).commitProof(TASK_ID_2, PROOF_HASH, true, sig))
        .to.be.revertedWithCustomError(escrow, "ProofAlreadyUsed")
        .withArgs(PROOF_HASH);
      expect((await escrow.getTask(TASK_ID_2)).status).to.equal(TaskStatus.Funded);
    });

    it("reverts with ProofAlreadyUsed when a failed proof's hash is replayed on another task", async function () {
      const { escrow, verifier, requester, robot, payee } = await loadFixture(failedFixture);
      await escrow.connect(requester).fundTask(TASK_ID_2, robot.address, payee.address, { value: AMOUNT_2 });
      const sig = await signProof(robot, PROOF_HASH);
      await expect(escrow.connect(verifier).commitProof(TASK_ID_2, PROOF_HASH, true, sig))
        .to.be.revertedWithCustomError(escrow, "ProofAlreadyUsed")
        .withArgs(PROOF_HASH);
    });

    describe("malformed signatures", function () {
      it("reverts for an empty signature", async function () {
        const { escrow, verifier } = await loadFixture(fundedFixture);
        await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, "0x"))
          .to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignatureLength")
          .withArgs(0);
      });

      it("reverts for 64 zero bytes", async function () {
        const { escrow, verifier } = await loadFixture(fundedFixture);
        await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, new Uint8Array(64)))
          .to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignatureLength")
          .withArgs(64);
      });

      it("reverts for 65 zero bytes (ecrecover -> address(0))", async function () {
        const { escrow, verifier } = await loadFixture(fundedFixture);
        await expect(
          escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, new Uint8Array(65)),
        ).to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignature");
      });

      it("reverts for deterministic 65-byte garbage", async function () {
        const { escrow, verifier } = await loadFixture(fundedFixture);
        const garbage = "0x" + "ab".repeat(65);
        await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, garbage)).to.be.reverted;
      });

      it("reverts for random short garbage", async function () {
        const { escrow, verifier } = await loadFixture(fundedFixture);
        await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, ethers.randomBytes(10)))
          .to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignatureLength")
          .withArgs(10);
      });

      it("reverts for a valid signature with an appended extra byte (66 bytes)", async function () {
        const { escrow, verifier, robot } = await loadFixture(fundedFixture);
        const sig = ethers.concat([await signProof(robot, PROOF_HASH), "0x00"]);
        await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig))
          .to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignatureLength")
          .withArgs(66);
      });

      it("rejects an ERC-2098 compact (64-byte) form of a valid robot signature", async function () {
        const { escrow, verifier, robot } = await loadFixture(fundedFixture);
        const compact = ethers.Signature.from(await signProof(robot, PROOF_HASH)).compactSerialized;
        expect(ethers.dataLength(compact)).to.equal(64);
        await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, compact))
          .to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignatureLength")
          .withArgs(64);
      });

      it("rejects a malleated (high-s) version of a valid robot signature", async function () {
        const { escrow, verifier, robot } = await loadFixture(fundedFixture);
        const sig = ethers.Signature.from(await signProof(robot, PROOF_HASH));
        const highS = ethers.toBeHex(SECP256K1_N - BigInt(sig.s), 32);
        const flippedV = sig.v === 27 ? 28 : 27;
        const malleated = ethers.concat([sig.r, highS, ethers.toBeHex(flippedV, 1)]);
        await expect(escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, malleated))
          .to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignatureS")
          .withArgs(highS);
      });

      it("a rejected commit leaves state untouched and a valid commit still succeeds afterwards", async function () {
        const { escrow, verifier, robot, stranger } = await loadFixture(fundedFixture);
        await expect(
          escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(stranger, PROOF_HASH)),
        ).to.be.revertedWithCustomError(escrow, "InvalidRobotSignature");
        await expect(
          escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, new Uint8Array(64)),
        ).to.be.revertedWithCustomError(escrow, "ECDSAInvalidSignatureLength");

        let task = await escrow.getTask(TASK_ID);
        expect(task.status).to.equal(TaskStatus.Funded);
        expect(task.proofHash).to.equal(ZERO_HASH);
        expect(await escrow.proofHashUsed(PROOF_HASH)).to.equal(false);

        await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(robot, PROOF_HASH));
        task = await escrow.getTask(TASK_ID);
        expect(task.status).to.equal(TaskStatus.Verified);
      });
    });
  });

  describe("settle", function () {
    it("valid successful proof allows settlement: payee receives exactly the escrowed amount", async function () {
      const { escrow, verifier, payee, requester } = await loadFixture(verifiedFixture);
      const tx = escrow.connect(verifier).settle(TASK_ID);
      await expect(tx).to.emit(escrow, "TaskSettled").withArgs(TASK_ID, payee.address, AMOUNT);
      await expect(tx).to.changeEtherBalances([escrow, payee, requester], [-AMOUNT, AMOUNT, 0n]);

      const task = await escrow.getTask(TASK_ID);
      expect(task.status).to.equal(TaskStatus.Settled);
      expect(task.proofHash).to.equal(PROOF_HASH);
      expect(task.amount).to.equal(AMOUNT); // amount kept as a historical record
    });

    for (const who of ["requester", "robot", "payee", "stranger"] as const) {
      it(`reverts with NotVerifier when settlement is attempted by the ${who}`, async function () {
        const ctx = await loadFixture(verifiedFixture);
        await expect(ctx.escrow.connect(ctx[who]).settle(TASK_ID)).to.be.revertedWithCustomError(
          ctx.escrow,
          "NotVerifier",
        );
        expect((await ctx.escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Verified);
      });
    }

    it("failed proof cannot settle (InvalidStatus)", async function () {
      const { escrow, verifier } = await loadFixture(failedFixture);
      await expect(escrow.connect(verifier).settle(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Failed, TaskStatus.Verified);
    });

    it("cannot settle a Funded task without any proof (InvalidStatus)", async function () {
      const { escrow, verifier } = await loadFixture(fundedFixture);
      await expect(escrow.connect(verifier).settle(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Funded, TaskStatus.Verified);
    });

    it("cannot settle an unknown task (InvalidStatus)", async function () {
      const { escrow, verifier } = await loadFixture(deployFixture);
      await expect(escrow.connect(verifier).settle(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.None, TaskStatus.Verified);
    });

    it("double settlement reverts (InvalidStatus) and the payee is not paid again", async function () {
      const { escrow, verifier, payee } = await loadFixture(settledFixture);
      const tx = escrow.connect(verifier).settle(TASK_ID);
      await expect(tx)
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Settled, TaskStatus.Verified);

      const payeeBefore = await ethers.provider.getBalance(payee.address);
      await expect(escrow.connect(verifier).settle(TASK_ID)).to.be.reverted;
      expect(await ethers.provider.getBalance(payee.address)).to.equal(payeeBefore);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it("cannot settle after a refund (InvalidStatus)", async function () {
      const { escrow, verifier } = await loadFixture(refundedFixture);
      await expect(escrow.connect(verifier).settle(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Refunded, TaskStatus.Verified);
    });
  });

  describe("refund", function () {
    it("requester can refund after a failed proof and receives exactly the escrowed amount", async function () {
      const { escrow, requester, payee } = await loadFixture(failedFixture);
      const tx = escrow.connect(requester).refund(TASK_ID);
      await expect(tx).to.emit(escrow, "TaskRefunded").withArgs(TASK_ID, requester.address, AMOUNT);
      // changeEtherBalances ignores the gas fee of the tx sender by default.
      await expect(tx).to.changeEtherBalances([escrow, requester, payee], [-AMOUNT, AMOUNT, 0n]);
      expect((await escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Refunded);
    });

    it("verifier can trigger the refund; funds still go to the requester", async function () {
      const { escrow, verifier, requester } = await loadFixture(failedFixture);
      const tx = escrow.connect(verifier).refund(TASK_ID);
      await expect(tx).to.emit(escrow, "TaskRefunded").withArgs(TASK_ID, requester.address, AMOUNT);
      await expect(tx).to.changeEtherBalances([escrow, requester, verifier], [-AMOUNT, AMOUNT, 0n]);
      expect((await escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Refunded);
    });

    for (const who of ["stranger", "payee", "robot"] as const) {
      it(`reverts with NotAuthorized when the ${who} requests a refund`, async function () {
        const ctx = await loadFixture(failedFixture);
        await expect(ctx.escrow.connect(ctx[who]).refund(TASK_ID)).to.be.revertedWithCustomError(
          ctx.escrow,
          "NotAuthorized",
        );
        expect((await ctx.escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Failed);
      });
    }

    it("cannot refund a Funded task (no proof yet)", async function () {
      const { escrow, requester, verifier } = await loadFixture(fundedFixture);
      await expect(escrow.connect(requester).refund(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Funded, TaskStatus.Failed);
      await expect(escrow.connect(verifier).refund(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Funded, TaskStatus.Failed);
    });

    it("cannot refund a Verified task (payment belongs to the payee)", async function () {
      const { escrow, requester } = await loadFixture(verifiedFixture);
      await expect(escrow.connect(requester).refund(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Verified, TaskStatus.Failed);
    });

    it("cannot refund a Settled task", async function () {
      const { escrow, requester } = await loadFixture(settledFixture);
      await expect(escrow.connect(requester).refund(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Settled, TaskStatus.Failed);
    });

    it("double refund reverts (InvalidStatus) and the requester is not paid again", async function () {
      const { escrow, requester, verifier } = await loadFixture(refundedFixture);
      await expect(escrow.connect(requester).refund(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.Refunded, TaskStatus.Failed);
      const requesterBefore = await ethers.provider.getBalance(requester.address);
      await expect(escrow.connect(verifier).refund(TASK_ID)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      expect(await ethers.provider.getBalance(requester.address)).to.equal(requesterBefore);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it("unknown task: stranger gets NotAuthorized, verifier gets InvalidStatus", async function () {
      const { escrow, stranger, verifier } = await loadFixture(deployFixture);
      await expect(escrow.connect(stranger).refund(TASK_ID)).to.be.revertedWithCustomError(escrow, "NotAuthorized");
      await expect(escrow.connect(verifier).refund(TASK_ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID, TaskStatus.None, TaskStatus.Failed);
    });
  });

  describe("exactly-once settlement", function () {
    it("full happy path: fund -> commit -> settle pays the payee exactly once and empties escrow", async function () {
      const { escrow, verifier, requester, robot, payee } = await loadFixture(deployFixture);
      const escrowAddress = await escrow.getAddress();
      const payeeStart = await ethers.provider.getBalance(payee.address);

      await escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT });
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(AMOUNT);

      await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(robot, PROOF_HASH));
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(AMOUNT);

      const receipt = await (await escrow.connect(verifier).settle(TASK_ID)).wait();
      expect(receipt?.status).to.equal(1);
      expect(receipt?.hash).to.match(/^0x[0-9a-f]{64}$/);

      // Every follow-up attempt to move the funds again must fail.
      await expect(escrow.connect(verifier).settle(TASK_ID)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(escrow.connect(requester).refund(TASK_ID)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(escrow.connect(verifier).refund(TASK_ID)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(
        escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(robot, PROOF_HASH)),
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");

      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(0n);
      // payee never sent a tx, so its delta is exactly the payment, paid once.
      expect((await ethers.provider.getBalance(payee.address)) - payeeStart).to.equal(AMOUNT);

      const settledEvents = await escrow.queryFilter(escrow.filters.TaskSettled(TASK_ID));
      expect(settledEvents).to.have.length(1);
      expect(settledEvents[0].args.amount).to.equal(AMOUNT);

      const task = await escrow.getTask(TASK_ID);
      expect(task.status).to.equal(TaskStatus.Settled);
      expect(task.proofHash).to.equal(PROOF_HASH);
    });

    it("independent tasks don't interfere: settling one leaves the other's escrow intact", async function () {
      const { escrow, verifier, requester, robot, payee, stranger } = await loadFixture(deployFixture);
      const escrowAddress = await escrow.getAddress();

      await escrow.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT });
      await escrow.connect(requester).fundTask(TASK_ID_2, robot.address, stranger.address, { value: AMOUNT_2 });
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(AMOUNT + AMOUNT_2);

      await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(robot, PROOF_HASH));
      await expect(escrow.connect(verifier).settle(TASK_ID)).to.changeEtherBalances(
        [escrow, payee, stranger],
        [-AMOUNT, AMOUNT, 0n],
      );

      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(AMOUNT_2);
      const other = await escrow.getTask(TASK_ID_2);
      expect(other.status).to.equal(TaskStatus.Funded);
      expect(other.amount).to.equal(AMOUNT_2);
      expect(other.payee).to.equal(stranger.address);
      expect(other.proofHash).to.equal(ZERO_HASH);

      // Settling task_001 does not let task_002 be settled.
      await expect(escrow.connect(verifier).settle(TASK_ID_2))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(TASK_ID_2, TaskStatus.Funded, TaskStatus.Verified);

      // task_002 fails and is refunded; escrow is fully drained with no cross-contamination.
      await escrow.connect(verifier).commitProof(TASK_ID_2, PROOF_HASH_2, false, await signProof(robot, PROOF_HASH_2));
      await expect(escrow.connect(requester).refund(TASK_ID_2)).to.changeEtherBalances(
        [escrow, requester, payee, stranger],
        [-AMOUNT_2, AMOUNT_2, 0n, 0n],
      );
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(0n);
      expect((await escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Settled);
      expect((await escrow.getTask(TASK_ID_2)).status).to.equal(TaskStatus.Refunded);
    });
  });

  describe("trust model (documented behaviour)", function () {
    it("proof<->task binding is off-chain: a robot-signed, unused hash is accepted for any task of that robot", async function () {
      // The contract only checks that the task's robot signed `proofHash`; it cannot see that the
      // canonical proof's task_id matches `taskId`. The verifier (backend) is trusted for that check.
      const { escrow, verifier, requester, robot, payee } = await loadFixture(fundedFixture);
      await escrow.connect(requester).fundTask(TASK_ID_2, robot.address, payee.address, { value: AMOUNT_2 });
      // PROOF_HASH is the hash of task_001's proof, committed against task_002.
      await expect(
        escrow.connect(verifier).commitProof(TASK_ID_2, PROOF_HASH, true, await signProof(robot, PROOF_HASH)),
      ).to.emit(escrow, "ProofCommitted");
      // ...but it is then burned, so it cannot also be used for task_001.
      await expect(
        escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(robot, PROOF_HASH)),
      ).to.be.revertedWithCustomError(escrow, "ProofAlreadyUsed");
    });

    it("the same robot signature is accepted by a second deployment (no chainId/contract domain binding)", async function () {
      const { escrow, verifier, requester, robot, payee } = await loadFixture(verifiedFixture);
      const other = await ethers.deployContract("MachineTaskEscrow", [verifier.address]);
      await other.connect(requester).fundTask(TASK_ID, robot.address, payee.address, { value: AMOUNT });
      const sig = await signProof(robot, PROOF_HASH);
      expect(await escrow.proofHashUsed(PROOF_HASH)).to.equal(true);
      await expect(other.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, sig)).to.emit(
        other,
        "ProofCommitted",
      );
    });
  });

  describe("reentrancy", function () {
    it("a payee contract that re-enters settle/refund on payment is paid exactly once", async function () {
      const { escrow, verifier, requester, robot, attacker } = await loadFixture(reentrantFixture);
      const attackerAddress = await attacker.getAddress();
      await attacker.setTarget(TASK_ID);

      await escrow.connect(requester).fundTask(TASK_ID, robot.address, attackerAddress, { value: AMOUNT });
      await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(robot, PROOF_HASH));

      await expect(escrow.connect(verifier).settle(TASK_ID)).to.changeEtherBalances(
        [escrow, attacker],
        [-AMOUNT, AMOUNT],
      );
      expect(await attacker.timesPaid()).to.equal(1n);
      expect(await attacker.reentryAttempts()).to.equal(2n);
      expect(await attacker.reentrySuccesses()).to.equal(0n);
      expect((await escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Settled);
    });

    it("a requester contract that re-enters refund on payment is refunded exactly once", async function () {
      const { escrow, verifier, robot, payee, attacker } = await loadFixture(reentrantFixture);
      await attacker.setTarget(TASK_ID);
      // The attacker contract is the requester, so a re-entrant refund passes the auth check and
      // can only be stopped by the status being updated before the external call (CEI).
      await attacker.fund(TASK_ID, robot.address, payee.address, { value: AMOUNT });
      expect((await escrow.getTask(TASK_ID)).requester).to.equal(await attacker.getAddress());

      // Second task funded by the attacker so the escrow holds extra ETH that could be drained.
      await attacker.fund(TASK_ID_2, robot.address, payee.address, { value: AMOUNT });
      await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, false, await signProof(robot, PROOF_HASH));

      await expect(attacker.requestRefund(TASK_ID)).to.changeEtherBalances([escrow, attacker], [-AMOUNT, AMOUNT]);
      expect(await attacker.timesPaid()).to.equal(1n);
      expect(await attacker.reentrySuccesses()).to.equal(0n);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(AMOUNT);
      expect((await escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Refunded);
      expect((await escrow.getTask(TASK_ID_2)).status).to.equal(TaskStatus.Funded);
    });

    it("a payee that rejects ETH makes settle revert with TransferFailed and leaves the task Verified", async function () {
      const { escrow, verifier, requester, robot, attacker } = await loadFixture(reentrantFixture);
      await attacker.setRejectPayments(true);
      await escrow.connect(requester).fundTask(TASK_ID, robot.address, await attacker.getAddress(), { value: AMOUNT });
      await escrow.connect(verifier).commitProof(TASK_ID, PROOF_HASH, true, await signProof(robot, PROOF_HASH));

      await expect(escrow.connect(verifier).settle(TASK_ID)).to.be.revertedWithCustomError(escrow, "TransferFailed");
      expect((await escrow.getTask(TASK_ID)).status).to.equal(TaskStatus.Verified);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(AMOUNT);

      // Once the payee accepts ETH again, settlement goes through exactly once.
      await attacker.setRejectPayments(false);
      await expect(escrow.connect(verifier).settle(TASK_ID)).to.changeEtherBalances(
        [escrow, attacker],
        [-AMOUNT, AMOUNT],
      );
    });
  });
});
