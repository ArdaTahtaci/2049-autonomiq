/**
 * Local Chainlink CRE plumbing: the MockKeystoneForwarder the CRE simulator writes through, the
 * dedicated local accounts, and the report formats shared by the workflow, contract and tests.
 */
import {
  AbiCoder,
  Contract,
  ContractFactory,
  concat,
  getBytes,
  hexlify,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
  type Signer,
} from "ethers";
import artifact from "./MockKeystoneForwarder.json";

/**
 * Fixed local CRE setup (Hardhat chain 31337). The keys are Hardhat's PUBLIC dev accounts #7-#9.
 * Deployed from fresh accounts at nonce 0, the forwarder and escrow get deterministic addresses,
 * which is what cre/project.yaml (forwarder) and the workflow config (escrow) point at.
 */
export const LOCAL_CRE = {
  /** Official chain-selectors entry for chainId 31337 ("anvil-devnet"). */
  chainSelector: 7759470850252068959n,
  chainSelectorName: "anvil-devnet",
  /** Account #8 deploys the MockKeystoneForwarder. */
  forwarderDeployerKey: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  forwarderAddress: "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A",
  /** Account #7 deploys the CRE-settled escrow. */
  escrowDeployerKey: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  escrowAddress: "0xef11D1c2aA48826D4c41e54ab82D1Ff5Ad8A64Ca",
  /** Account #9 is the CRE simulator's transmitter (CRE_ETH_PRIVATE_KEY): it sends forwarder.report(). */
  transmitterKey: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  transmitterAddress: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
} as const;

export const MOCK_FORWARDER_ABI = artifact.abi;

export function mockForwarderAt(address: string, runner: Signer): Contract {
  return new Contract(address, artifact.abi, runner);
}

export async function deployMockForwarder(deployer: Signer): Promise<Contract> {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy();
  await contract.waitForDeployment();
  return contract as Contract;
}

export interface SettlementReport {
  onchainTaskId: string;
  proofHash: string;
  passed: boolean;
  robotSignature: string;
}

/** The payload MachineTaskEscrow.onReport decodes: abi.encode(bytes32, bytes32, bool, bytes). */
export function encodeSettlementReport(r: SettlementReport): string {
  return AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bool", "bytes"],
    [r.onchainTaskId, r.proofHash, r.passed, r.robotSignature],
  );
}

export interface ReportMetadata {
  executionId?: string;
  workflowId?: string;
  workflowName?: string;
  workflowOwner?: string;
  reportId?: string;
}

/**
 * Raw CRE report as the DON (or the simulator's fake consensus) produces it: a 109-byte metadata
 * header followed by the payload. The forwarder passes header[45:109] to onReport as `metadata`.
 *   version (1) | execution_id (32) | timestamp (4) | don_id (4) | don_config_version (4)
 *   | workflow_cid (32) | workflow_name (10) | workflow_owner (20) | report_id (2)
 */
export function buildRawReport(payload: string, meta: ReportMetadata = {}): string {
  const bytes32 = (v?: string) => zeroPadValue(v ?? "0x00", 32);
  const name = getBytes(toUtf8Bytes((meta.workflowName ?? "").slice(0, 10)));
  return hexlify(
    concat([
      "0x01",
      bytes32(meta.executionId ?? toBeHex(1, 32)),
      toBeHex(Math.floor(Date.now() / 1000), 4),
      toBeHex(1, 4),
      toBeHex(1, 4),
      bytes32(meta.workflowId),
      concat([name, new Uint8Array(10 - name.length)]),
      zeroPadValue(meta.workflowOwner ?? "0x00", 20),
      meta.reportId ?? "0x0001",
      payload,
    ]),
  );
}
