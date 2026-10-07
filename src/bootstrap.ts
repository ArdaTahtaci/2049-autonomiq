import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet, ZeroAddress, getAddress, type JsonRpcProvider } from "ethers";
import { createApp, type HealthInfo } from "./api/app";
import { EscrowClient } from "./chain/escrow";
import { connectProvider, readDeployment } from "./chain/provider";
import { assertSafeKeys, type AppConfig } from "./config";
import { CreHttpTrigger } from "./cre/trigger";
import { ExternalRobotAdapter, MockRobotAdapter } from "./robot/adapter";
import { TaskService } from "./tasks/service";

export interface RunningServer {
  url: string;
  server: Server;
  service: TaskService;
  escrow: EscrowClient;
  provider: JsonRpcProvider;
  close(): Promise<void>;
}

/** Connects to the chain, checks the escrow deployment, wires the services and starts the HTTP API. */
export async function startServer(config: AppConfig, log: (msg: string) => void = console.log): Promise<RunningServer> {
  const { provider, chainId } = await connectProvider(config.rpcUrl);
  assertSafeKeys(config, chainId);

  const deployment = readDeployment();
  const escrowAddress = config.escrowAddress ?? (deployment?.chain_id === chainId.toString() ? deployment.escrow_address : undefined);
  if (!escrowAddress) {
    throw new Error(`No escrow contract configured for chainId ${chainId}. Run: npm run deploy (or set ESCROW_ADDRESS)`);
  }
  if ((await provider.getCode(escrowAddress)) === "0x") {
    throw new Error(
      `No contract code at ${escrowAddress} on chainId ${chainId} (was the local chain restarted?). Run: npm run deploy`,
    );
  }

  const verifier = new Wallet(config.verifierPrivateKey, provider);
  const requester = new Wallet(config.requesterPrivateKey, provider);
  const escrow = new EscrowClient(escrowAddress, verifier, requester);
  const onchainVerifier = await escrow.verifierAddress();
  if (getAddress(onchainVerifier) !== verifier.address) {
    throw new Error(`VERIFIER_PRIVATE_KEY (${verifier.address}) is not the escrow's verifier (${onchainVerifier})`);
  }

  // Settlement through the Chainlink CRE workflow requires the escrow to trust a CRE forwarder.
  let creForwarder: string | undefined;
  if (config.settlementMode === "cre") {
    creForwarder = await escrow.creForwarder();
    if (creForwarder === ZeroAddress) {
      throw new Error(`Escrow ${escrowAddress} has no CRE forwarder configured. Run: npm run cre:deploy`);
    }
  }

  const robot =
    config.robotAdapter === "mock"
      ? new MockRobotAdapter(new Wallet(config.robotPrivateKey), config.mockRobotDelayMs, log)
      : new ExternalRobotAdapter(log);
  const service = new TaskService({
    config,
    escrow,
    robot,
    log,
    ...(config.settlementMode === "cre"
      ? { cre: { trigger: new CreHttpTrigger(config.creTriggerUrl), settlementTimeoutMs: config.creSettlementTimeoutMs } }
      : {}),
  });
  service.startCreWatcher();

  const health = async (): Promise<HealthInfo> => {
    const base = {
      escrow_address: escrowAddress,
      robot_adapter: robot.name,
      robots: config.robots,
      settlement_mode: config.settlementMode,
      ...(creForwarder ? { cre: { trigger_url: config.creTriggerUrl, forwarder: creForwarder } } : {}),
    };
    try {
      const network = await provider.getNetwork();
      // Origin only: hosted RPC URLs carry API keys in the path/query/credentials.
      const rpc = new URL(config.rpcUrl).origin;
      return { ok: true, chain_id: network.chainId.toString(), rpc_url: rpc, verifier_address: verifier.address, ...base };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...base };
    }
  };

  const app = createApp(service, health);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s));
    s.on("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    service,
    escrow,
    provider,
    close: async () => {
      service.stopCreWatcher();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      provider.destroy();
    },
  };
}
