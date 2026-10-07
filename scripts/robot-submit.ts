/**
 * Robot gateway CLI: signs a raw simulator proof with the robot's key and submits it.
 *
 *   npm run robot:submit -- <proof.json | -> [--api http://127.0.0.1:3000] [--print] [--now]
 *
 * The simulator only has to write the proof JSON (see examples/proof.sample.json); this
 * script canonicalizes it (RFC 8785), hashes it (keccak256), signs the hash (EIP-191) with
 * ROBOT_PRIVATE_KEY and POSTs { proof, signature, proof_hash } to /tasks/<task_id>/proof.
 * --print outputs the signed submission instead of sending it.
 * --now   re-stamps `timestamp` with the current time before signing (for replaying sample files:
 *         the backend rejects proofs timestamped before their task was created).
 */
import fs from "node:fs";
import { Wallet } from "ethers";
import { loadConfig } from "../src/config";
import { signProof } from "../src/proof";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apiIndex = args.indexOf("--api");
  const file = args.find((a, i) => !a.startsWith("--") && (apiIndex < 0 || i !== apiIndex + 1));
  const config = loadConfig();
  const api = apiIndex >= 0 ? args[apiIndex + 1] : `http://127.0.0.1:${config.port || 3000}`;
  if (!file) {
    console.error("Usage: npm run robot:submit -- <proof.json | -> [--api http://127.0.0.1:3000] [--print] [--now]");
    process.exit(2);
  }

  const proof = JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8")) as { task_id?: unknown; timestamp?: unknown };
  if (typeof proof.task_id !== "string") throw new Error("proof.task_id must be a string");
  if (args.includes("--now")) proof.timestamp = new Date().toISOString();

  const robot = new Wallet(config.robotPrivateKey);
  const { proof_hash, signature } = await signProof(proof, robot);
  const submission = { proof, signature, proof_hash };

  if (args.includes("--print")) {
    console.log(JSON.stringify(submission, null, 2));
    return;
  }

  console.log(`proof_hash : ${proof_hash}`);
  console.log(`signed by  : ${robot.address}`);
  const res = await fetch(`${api}/tasks/${encodeURIComponent(proof.task_id)}/proof`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.ok ? { status: body.status, transactions: body.transactions, verification: body.verification } : body, null, 2));
  if (!res.ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
