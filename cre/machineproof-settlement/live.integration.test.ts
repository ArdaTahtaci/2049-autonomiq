/**
 * LIVE integration (opt-in: MACHINEPROOF_LIVE=1, or `npm run test:cre-live` at the repo root).
 *
 * Runs the real workflow handler (the code compiled into the WASM) through the CRE SDK test
 * runtime, with every capability bridged to the real system instead of a mock:
 *   HTTP  → the real backend process (evidence endpoint, result callback)
 *   EVM   → eth_call on a real Hardhat chain (MachineTaskEscrow.getTask / taskSpecHash)
 *   write → MockKeystoneForwarder.report(receiver, rawReport, reportContext, sigs) sent from the
 *           transmitter account — exactly what `cre workflow simulate --broadcast` does
 *
 * It proves the workflow ↔ backend ↔ contract interfaces end-to-end without a CRE login; the
 * CLI-hosted run is `npm run demo:cre`.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout } from "bun:test";
import type { HTTPPayload } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { Wallet } from "ethers";
import { type Hex, bytesToHex, encodeFunctionData, toHex } from "viem";
import { connectProvider } from "../../src/chain/provider";
import { HARDHAT_DEV_KEYS } from "../../src/config";
import { deployCreStack } from "../../src/cre/deploy";
import { LOCAL_CRE } from "../../src/cre/forwarder";
import forwarderArtifact from "../../src/cre/MockKeystoneForwarder.json";
import { signProof } from "../../src/proof/signature";
import { generateMockProof } from "../../src/robot/mockProof";
import { type Config, type WorkflowResult, onSettlementTrigger } from "./workflow";

const LIVE = Boolean(process.env.MACHINEPROOF_LIVE);
const ROOT = new URL("../../", import.meta.url).pathname;
const CHAIN_PORT = 8549;
const BACKEND_PORT = 3199;
const RPC = `http://127.0.0.1:${CHAIN_PORT}`;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const SELECTOR = 7759470850252068959n;

const toBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : typeof v === "string" ? new Uint8Array(Buffer.from(v, "base64")) : new Uint8Array();
const b64 = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? bytes : bytes).toString("base64");

/** Synchronous HTTP (the CRE handler is synchronous): curl as a subprocess. */
function curl(method: string, url: string, body?: Uint8Array | string): { status: number; text: string } {
  const args = ["-s", "-X", method, "-H", "content-type: application/json", "-w", "\n%{http_code}", url];
  if (body !== undefined) args.push("--data-binary", "@-");
  const out = Bun.spawnSync(["curl", ...args], { stdin: body === undefined ? undefined : Buffer.from(body) });
  const raw = out.stdout.toString();
  const cut = raw.lastIndexOf("\n");
  return { status: Number(raw.slice(cut + 1)), text: raw.slice(0, cut) };
}

function rpc<T>(method: string, params: unknown[]): T {
  const res = JSON.parse(curl("POST", RPC, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })).text) as { result?: T; error?: { message: string } };
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result as T;
}

/** Bridges the workflow's capabilities to the live backend + chain. */
function installLiveBridge(): { writes: string[] } {
  const record = { writes: [] as string[] };
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    const res = curl(req.method, req.url, req.method === "POST" ? toBytes(req.body) : undefined);
    return { statusCode: res.status, body: b64(res.text) };
  };
  const evm = EvmMock.testInstance(SELECTOR);
  evm.callContract = (input) => {
    const call = { to: bytesToHex(toBytes(input.call?.to)), data: bytesToHex(toBytes(input.call?.data)) };
    return { data: b64(Buffer.from(rpc<string>("eth_call", [call, "latest"]).slice(2), "hex")) };
  };
  evm.writeReport = (input) => {
    const data = encodeFunctionData({
      abi: forwarderArtifact.abi,
      functionName: "report",
      args: [
        bytesToHex(toBytes(input.receiver)),
        bytesToHex(toBytes(input.report?.rawReport)),
        bytesToHex(toBytes(input.report?.reportContext)),
        (input.report?.sigs ?? []).map((s: { signature?: unknown }) => bytesToHex(toBytes(s.signature))),
      ],
    });
    const txHash = rpc<string>("eth_sendTransaction", [
      { from: LOCAL_CRE.transmitterAddress, to: LOCAL_CRE.forwarderAddress, data, gas: toHex(1_000_000) },
    ]);
    const receipt = rpc<{ status: string }>("eth_getTransactionReceipt", [txHash]);
    record.writes.push(txHash);
    return {
      txStatus: receipt.status === "0x1" ? "TX_STATUS_SUCCESS" : "TX_STATUS_REVERTED",
      txHash: b64(Buffer.from(txHash.slice(2), "hex")),
    };
  };
  return record;
}

const CONFIG: Config = {
  backendUrl: BACKEND,
  chainSelectorName: "anvil-devnet",
  escrowAddress: LOCAL_CRE.escrowAddress,
  gasLimit: "800000",
  proofClockSkewSeconds: 300,
  requireSpecAnchor: true,
  authorizedTriggerKeys: [],
};

function runWorkflow(trigger: unknown): { result: WorkflowResult; logs: string[]; writes: string[] } {
  const bridge = installLiveBridge();
  const runtime = newTestRuntime<Config>(null, {}, CONFIG);
  const payload = { input: new TextEncoder().encode(JSON.stringify(trigger)) } as unknown as HTTPPayload;
  const result = onSettlementTrigger(runtime, payload);
  return { result, logs: runtime.getLogs(), writes: bridge.writes };
}

async function api(method: string, route: string, body?: unknown) {
  const res = await fetch(BACKEND + route, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

setDefaultTimeout(60_000);

const balance = (address: string) => BigInt(rpc<string>("eth_getBalance", [address, "latest"]));

describe.skipIf(!LIVE)("LIVE: workflow ↔ real backend ↔ real escrow + MockKeystoneForwarder", () => {
  const children: Array<{ kill(): void }> = [];
  const triggers: Array<{ task_id: string; proof_hash: string }> = [];
  let triggerServer: ReturnType<typeof Bun.serve> | undefined;
  const robot = new Wallet(HARDHAT_DEV_KEYS.robot);

  const waitFor = async (check: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(150);
    }
  };

  beforeAll(async () => {
    children.push(Bun.spawn([`${ROOT}node_modules/.bin/hardhat`, "node", "--port", String(CHAIN_PORT)], { cwd: ROOT, stdout: "ignore", stderr: "ignore" }));
    await waitFor(async () => (await fetch(RPC, { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).catch(() => null))?.ok === true, "hardhat node");

    const { provider } = await connectProvider(RPC);
    await deployCreStack(provider, new Wallet(HARDHAT_DEV_KEYS.verifier, provider));
    provider.destroy();

    // Stands in for the CRE gateway / `--listen` endpoint: records what the backend hands to CRE.
    triggerServer = Bun.serve({
      port: 0,
      fetch: async (req: Request) => {
        triggers.push(((await req.json()) as { input: { task_id: string; proof_hash: string } }).input);
        return new Response("ok");
      },
    });
    children.push(
      Bun.spawn([`${ROOT}node_modules/.bin/tsx`, "src/server.ts"], {
        cwd: ROOT,
        stdout: "ignore",
        stderr: "inherit",
        env: {
          ...process.env,
          PORT: String(BACKEND_PORT),
          RPC_URL: RPC,
          ESCROW_ADDRESS: LOCAL_CRE.escrowAddress,
          SETTLEMENT_MODE: "cre",
          CRE_TRIGGER_URL: `http://127.0.0.1:${triggerServer.port}/trigger`,
          ROBOT_ADAPTER: "external",
        },
      }),
    );
    await waitFor(async () => (await fetch(`${BACKEND}/health`).catch(() => null))?.ok === true, "backend");
  }, 120_000);

  afterAll(() => {
    for (const c of children.reverse()) c.kill();
    triggerServer?.stop(true);
  });

  async function handToCre(outcome: "success" | "false_success") {
    const created = await api("POST", "/tasks", {});
    const task = created.body;
    expect((await api("POST", `/tasks/${task.task_id}/fund`)).status).toBe(200);
    const proof = generateMockProof(task as any, outcome);
    const submitted = await api("POST", `/tasks/${task.task_id}/proof`, { proof, ...(await signProof(proof, robot)) });
    expect(submitted.status).toBe(202);
    await waitFor(async () => triggers.some((t) => t.task_id === task.task_id), "backend → CRE trigger");
    return { task, trigger: triggers.find((t) => t.task_id === task.task_id)! };
  }

  test("success: workflow verifies independently, settles via forwarder, backend adopts it from the chain", async () => {
    const { task, trigger } = await handToCre("success");
    const payeeBefore = balance(task.payee);
    const { result, writes, logs } = runWorkflow(trigger);

    expect(result.decision).toBe("SETTLED");
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(writes).toEqual([result.tx_hash]);
    expect(balance(task.payee) - payeeBefore).toBe(BigInt(task.reward_wei));
    expect(logs.some((l) => l.includes("Confirmed on-chain: task Settled"))).toBe(true);

    const view = (await api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.status).toBe("SETTLED");
    expect(view.cre.report_tx).toBe(result.tx_hash);
    expect(view.cre.forwarder).toBe(LOCAL_CRE.forwarderAddress);
    expect(view.cre.transmitter).toBe(LOCAL_CRE.transmitterAddress);
    expect(view.cre.workflow_result.decision).toBe("SETTLED");
    expect(view.onchain.status).toBe("Settled");
  });

  test("lying robot: workflow measures the misplacement and refunds on-chain", async () => {
    const { task, trigger } = await handToCre("false_success");
    const payeeBefore = balance(task.payee);
    const { result } = runWorkflow(trigger);

    expect(result.decision).toBe("REFUNDED");
    expect(result.reasons.join(" ")).toMatch(/claimed success/);
    expect(balance(task.payee)).toBe(payeeBefore);
    const view = (await api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.status).toBe("FAILED");
    expect(view.onchain.status).toBe("Refunded");
  });

  test("duplicate trigger: workflow reads Settled on-chain and writes nothing", async () => {
    const { task, trigger } = await handToCre("success");
    expect(runWorkflow(trigger).result.decision).toBe("SETTLED");
    const payeeAfterFirst = balance(task.payee);

    const dup = runWorkflow(trigger);
    expect(dup.result.decision).toBe("SKIPPED");
    expect(dup.writes).toEqual([]);
    expect(balance(task.payee)).toBe(payeeAfterFirst);
  });

  test("trigger whose proof hash does not match the stored evidence is rejected; nothing on-chain", async () => {
    const { task, trigger } = await handToCre("success");
    const forged = { ...trigger, proof_hash: `0x${"ab".repeat(32)}` as Hex };
    const { result, writes } = runWorkflow(forged);
    expect(result.decision).toBe("REJECTED");
    expect(writes).toEqual([]);
    const view = (await api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.onchain.status).toBe("Funded");
    expect(view.status).toBe("PROOF_RECEIVED"); // a forged hash cannot reject the genuine proof
  });
});
