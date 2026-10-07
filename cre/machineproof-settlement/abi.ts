/**
 * MachineTaskEscrow ABI subset used by the workflow, and the CRE report encoding.
 *
 * Report payload (delivered by the Chainlink forwarder to MachineTaskEscrow.onReport):
 *   abi.encode(bytes32 taskId, bytes32 proofHash, bool passed, bytes robotSignature)
 * onReport re-checks the robot signature on-chain, commits the proof hash, then settles (passed)
 * or refunds (failed) atomically.
 */
import { type Hex, decodeAbiParameters, encodeAbiParameters, parseAbiParameters } from "viem";

export const ESCROW_ABI = [
  {
    type: "function",
    name: "proofHashUsed",
    stateMutability: "view",
    inputs: [{ name: "proofHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getTask",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "requester", type: "address" },
          { name: "robot", type: "address" },
          { name: "payee", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "proofHash", type: "bytes32" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "taskSpecHash",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/** MachineTaskEscrow.TaskStatus, by enum index. */
export const TASK_STATUS = ["None", "Funded", "Verified", "Failed", "Settled", "Refunded"] as const;
export type TaskStatusName = (typeof TASK_STATUS)[number];
export const STATUS_FUNDED = 1;
export const STATUS_SETTLED = 4;
export const STATUS_REFUNDED = 5;

export const statusName = (status: number): string => TASK_STATUS[status] ?? `Unknown(${status})`;

const REPORT_PARAMS = parseAbiParameters("bytes32 taskId, bytes32 proofHash, bool passed, bytes robotSignature");

export interface SettlementReport {
  taskId: Hex;
  proofHash: Hex;
  passed: boolean;
  robotSignature: Hex;
}

export const encodeSettlementReport = (r: SettlementReport): Hex =>
  encodeAbiParameters(REPORT_PARAMS, [r.taskId, r.proofHash, r.passed, r.robotSignature]);

export function decodeSettlementReport(data: Hex): SettlementReport {
  const [taskId, proofHash, passed, robotSignature] = decodeAbiParameters(REPORT_PARAMS, data);
  return { taskId, proofHash, passed, robotSignature };
}
