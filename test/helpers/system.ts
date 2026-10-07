import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEther, type Signer } from "ethers";
import { ethers } from "hardhat";
import { createApp } from "../../src/api/app";
import { EscrowClient, deployEscrow } from "../../src/chain/escrow";
import { ExternalRobotAdapter, MockRobotAdapter } from "../../src/robot/adapter";
import { TaskService, type TaskServiceConfig } from "../../src/tasks/service";
import type { TaskView } from "../../src/tasks/types";

export const REWARD = parseEther("0.1");

/** Full backend (real Express app + escrow contract) on Hardhat's in-process network. */
export async function startTestSystem(opts: { robot?: "mock" | "external"; mockDelayMs?: number } = {}) {
  const [verifier, requester, robot, payee, stranger] = await ethers.getSigners();
  const contract = await deployEscrow(verifier, verifier.address);
  const escrow = new EscrowClient(await contract.getAddress(), verifier, requester);

  const config: TaskServiceConfig = {
    robots: { robot_001: robot.address },
    defaultRobotId: "robot_001",
    payeeAddress: payee.address,
    defaultTolerance: 0.05,
    defaultRewardWei: REWARD,
  };
  const adapter = opts.robot === "mock" ? new MockRobotAdapter(robot, opts.mockDelayMs ?? 50) : new ExternalRobotAdapter();
  const service = new TaskService({ config, escrow, robot: adapter });
  const app = createApp(service, async () => ({
    ok: true,
    escrow_address: escrow.address,
    robot_adapter: adapter.name,
    robots: config.robots,
  }));

  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function api<T = TaskView>(method: string, route: string, body?: unknown, rawBody?: string) {
    const res = await fetch(url + route, {
      method,
      headers: { "content-type": "application/json" },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: (await res.json()) as T & { error?: string; details?: { reasons?: string[] } } };
  }

  async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 10_000): Promise<TaskView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await api("GET", `/tasks/${taskId}`);
      if (statuses.includes(body.status)) return body;
      if (Date.now() > deadline) throw new Error(`task ${taskId} stuck in ${body.status}: ${JSON.stringify(body.events)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Create + fund a task with defaults (A=(0,0,0) → B=(1,0,0), ±0.05 m, 0.1 ETH). */
  async function fundedTask(body: Record<string, unknown> = {}): Promise<TaskView> {
    const created = await api("POST", "/tasks", body);
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    const funded = await api("POST", `/tasks/${created.body.task_id}/fund`);
    if (funded.status !== 200) throw new Error(JSON.stringify(funded.body));
    return funded.body;
  }

  return {
    url,
    api,
    waitForStatus,
    fundedTask,
    service,
    escrow,
    contract,
    signers: { verifier, requester, robot: robot as Signer & { address: string }, payee, stranger },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type TestSystem = Awaited<ReturnType<typeof startTestSystem>>;
