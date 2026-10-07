/**
 * Robot signatures over proof hashes.
 *
 * Scheme: EIP-191 personal_sign over the 32 raw bytes of the proof hash, i.e.
 *   signature = sign(keccak256("\x19Ethereum Signed Message:\n32" || proofHash))
 * which is exactly what MachineTaskEscrow verifies on-chain with
 * ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(bytes32), sig).
 *
 * Recovery here is deliberately as strict as OpenZeppelin's ECDSA (65 bytes, v in {27,28},
 * low-s) so a signature accepted off-chain is never rejected by the contract.
 */
import { Signature, getAddress, getBytes, isHexString, verifyMessage } from "ethers";
import type { Signer } from "ethers";
import { computeProofHash } from "./hash";

// secp256k1n / 2 — upper bound for s enforced by OpenZeppelin ECDSA (EIP-2 malleability rule).
const SECP256K1_HALF_N = BigInt("0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0");

function assertProofHash(proofHash: string): void {
  if (!isHexString(proofHash, 32)) {
    throw new Error(`invalid proof hash: expected 0x-prefixed 32-byte hex, got ${JSON.stringify(proofHash)}`);
  }
}

export async function signProofHash(proofHash: string, signer: Signer): Promise<string> {
  assertProofHash(proofHash);
  return signer.signMessage(getBytes(proofHash));
}

export async function signProof(proof: unknown, signer: Signer): Promise<{ proof_hash: string; signature: string }> {
  const proof_hash = computeProofHash(proof);
  const signature = await signProofHash(proof_hash, signer);
  return { proof_hash, signature };
}

/** Returns the checksummed signer address. Throws on a malformed hash or signature. */
export function recoverProofSigner(proofHash: string, signature: string): string {
  assertProofHash(proofHash);
  if (typeof signature !== "string" || !isHexString(signature, 65)) {
    throw new Error("malformed signature: expected 0x-prefixed 65-byte hex");
  }
  const bytes = getBytes(signature);
  const v = bytes[64];
  if (v !== 27 && v !== 28) {
    throw new Error(`malformed signature: v must be 27 or 28, got ${v}`);
  }
  const sig = Signature.from(signature);
  if (BigInt(sig.s) > SECP256K1_HALF_N) {
    throw new Error("malformed signature: non-canonical (high) s value");
  }
  return getAddress(verifyMessage(getBytes(proofHash), sig));
}

/** True iff `signature` over `proofHash` was produced by `expectedSigner`. Never throws. */
export function isValidProofSignature(proofHash: string, signature: string, expectedSigner: string): boolean {
  try {
    if (typeof expectedSigner !== "string") return false;
    return recoverProofSigner(proofHash, signature).toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}
