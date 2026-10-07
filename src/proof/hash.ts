/**
 * Proof hash = keccak256(utf8(canonicalize(proof))).
 *
 * keccak256 is used so the hash is a native bytes32 for the Solidity contract,
 * which stores it as the on-chain proof commitment.
 */
import { keccak256, toUtf8Bytes } from "ethers";
import { canonicalize } from "./canonicalize";

/** Returns the 0x-prefixed 32-byte keccak256 hash of the canonical proof. Throws CanonicalizationError. */
export function computeProofHash(proof: unknown): string {
  return hashCanonicalProof(proof).proof_hash;
}

export function hashCanonicalProof(proof: unknown): { canonical_proof: string; proof_hash: string } {
  const canonical_proof = canonicalize(proof);
  return { canonical_proof, proof_hash: keccak256(toUtf8Bytes(canonical_proof)) };
}
