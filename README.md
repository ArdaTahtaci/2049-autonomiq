# MachineProof

**Verifiable machine work, settled on-chain.**

A requester locks payment in an escrow contract. A robot (simulated) picks an object up at point A and places it at point B, then produces a signed execution proof. The backend verifies the proof's authenticity and integrity. It then decides success itself from the measured final position, never from the robot's `success` flag. It commits the proof hash on-chain, and the contract releases payment only if verification passed. Exactly once.

```text
Create task → fund escrow → robot executes → signed proof → validate → canonicalize (RFC 8785)
→ keccak256 → verify robot signature → measure placement vs tolerance → commit hash on-chain
→ settle (pay robot operator)  |  or: failed → refund requester
```

## Quick start

```bash
npm install
npm run demo
```

`npm run demo` is self-contained. It starts a local Hardhat chain if none is running, deploys a fresh escrow, starts the backend and drives everything over the real HTTP API:

```text
━━ Scenario 1 — robot completes the task, payment is released ━━━━━━━━━━━━━━━━
✓ Task created                       task_2b4d7be7: pick (0, 0, 0) → place (1, 0, 0) ±0.05 m, reward 0.1 ETH
✓ Escrow funded                      0.1 ETH locked in MachineTaskEscrow  tx 0xc808…
✓ Robot execution started            robot_001 via mock simulator adapter
✓ Execution proof received           robot_001, 11 trajectory points, 2026-10-07T08:55:59.316Z
✓ Proof canonicalized                RFC 8785 JSON canonical form, 1123 bytes
✓ Proof hash generated               keccak256 = 0x2286…
✓ Signature verified                 signer 0x3C44…93BC = registered key of robot_001
✓ Physical result verified           object 0.0184 m from target (tolerance 0.05 m), robot claimed success=true
✓ Proof committed on-chain           commitProof(passed=true) tx 0x168b… (block 3)
✓ Settlement released                0.1 ETH → payee 0x90F79bf6…93b906  tx 0x0f27…
✓ Transaction confirmed              on-chain escrow status = Settled
✓ On-chain commitment matches proof  keccak256(canonical(off-chain proof)) == on-chain proofHash
✓ Payment settled exactly once       payee +0.1 ETH, 1 TaskSettled event, escrow balance 0.0 ETH
✓ Double settlement via API rejected HTTP 409 …
✓ Double settle on-chain reverted    settle() → InvalidStatus(Settled)

━━ Scenario 2 — attacks & failures: no valid proof, no payment ━━━━━━━━━━━━━━━
✓ Tampered proof rejected / Wrong signer rejected / Wrong task_id rejected / Missing fields / Malformed JSON
✓ Rejected proofs never hit chain
⛔ Physical check FAILED             object 0.19 m from target, robot claimed success=true
✓ Proof committed on-chain           commitProof(passed=false)
✓ Escrow refunded to requester       0.1 ETH
✓ Duplicate proof rejected / Settlement of failed task rejected / No payment released
All checks passed ✓
```

It exits non-zero if any check fails, so it doubles as a smoke test. For a slower or faster presentation, set `DEMO_STEP_DELAY_MS` (default 250). To see backend logs, set `DEMO_VERBOSE=1`.

## Architecture

```text
┌──────────────────────┐   signed proof    ┌──────────────────────────────────────┐   tx    ┌─────────────────────┐
│ ROBOTICS             │ ────────────────► │ BACKEND (verifier / oracle)          │ ──────► │ BLOCKCHAIN          │
│ simulator / mock     │ POST /tasks/:id/  │ validate → canonicalize → keccak256  │         │ MachineTaskEscrow   │
│ executes A → B,      │      proof        │ → recover signer → check task binding│         │ escrow + proof hash │
│ measures final state,│                   │ → measure placement → commit → settle│         │ commitment + payout │
│ signs proof hash     │                   │ Express API, in-memory task store    │         │ (local Hardhat)     │
└──────────────────────┘                   └──────────────────────────────────────┘         └─────────────────────┘
```

| Layer | Code | Responsibility |
|---|---|---|
| Robotics | `src/robot/` | `RobotAdapter` interface. `MockRobotAdapter` simulates execution and signs proofs. `ExternalRobotAdapter` waits for a real simulator to POST proofs. `mockProof.ts` generates realistic `success` / `failure` / `false_success` proofs. |
| Proof | `src/proof/` | Zod schemas, RFC 8785 canonicalization, keccak256 hash, EIP-191 sign/recover, physical placement check, and the `verifyProofSubmission` pipeline (pure functions) |
| Tasks | `src/tasks/` | `TaskService` state machine, per-task lock, orchestration of verification → chain |
| Chain | `src/chain/` | `EscrowClient` (typed contract wrapper, serialized tx queue, revert decoding), provider + deployment file |
| API | `src/api/app.ts` | Express routes, input validation, error mapping |
| Contract | `contracts/MachineTaskEscrow.sol` | Escrow, on-chain robot-signature check, proof commitment, settle/refund, exactly-once guards |

### Task lifecycle

```text
CREATED ─fund─► FUNDED ─start─► RUNNING ─proof─► PROOF_RECEIVED ─┬─ passed ─► VERIFIED ─► SETTLED
                                                                 └─ failed ─► FAILED (escrow refunded)
```

A *rejected* proof (malformed, tampered, wrong signer, wrong task) never reaches the chain and does not change the task's state. The genuine proof can still be submitted afterwards, so garbage submissions cannot DoS a task. A *failed* proof is authentic and correctly signed, but shows that the task did not succeed physically. It is committed on-chain as failed and the escrow is refunded.

On-chain escrow status: `None → Funded → Verified → Settled`, or `Funded → Failed → Refunded`.

## Requirements

- Node.js ≥ 20 and npm (tested on Node 24.15 / npm 11)
- Nothing else. The chain is a local Hardhat node, and state is in memory.

## Installation

```bash
npm install
npm run compile        # compiles the contract + generates typechain types (also done by test/demo/deploy)
```

## Environment variables

Copy `.env.example` to `.env` if you need to change anything. **Every variable has a working local default**, and blank values mean "use the default".

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Backend HTTP port |
| `RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `ESCROW_ADDRESS` | from `deployments/localhost.json` | Escrow contract address |
| `VERIFIER_PRIVATE_KEY` | Hardhat account #0 | Backend oracle: deploys escrow, commits proofs, settles/refunds |
| `REQUESTER_PRIVATE_KEY` | Hardhat account #1 | Funds escrows (stand-in for the requester's wallet until a frontend exists) |
| `ROBOT_PRIVATE_KEY` | Hardhat account #2 | Robot signing key, used by the mock robot and `robot:submit` |
| `ROBOT_ID` / `ROBOT_ADDRESS` | `robot_001` / address of `ROBOT_PRIVATE_KEY` | Robot registry: proofs for `ROBOT_ID` must be signed by `ROBOT_ADDRESS` |
| `PAYEE_ADDRESS` | Hardhat account #3 | Receives payment on settlement |
| `ROBOT_ADAPTER` | `mock` | `mock` = backend simulates the robot on `/start`. `external` = real simulator POSTs proofs. |
| `MOCK_ROBOT_DELAY_MS` | `1500` | Simulated execution time |
| `POSITION_TOLERANCE_M` | `0.05` | Default success tolerance in meters |
| `DEFAULT_REWARD_ETH` | `0.1` | Default task reward |

The default keys are Hardhat's **public** development accounts. The backend and deploy script refuse to use them on any chain other than 31337. No real secrets are stored in this repository.

## Tests

```bash
npm test               # all suites on Hardhat's in-process network (no running node needed)
npm run typecheck      # tsc --noEmit over src, scripts, tests
```

| Suite | Covers |
|---|---|
| `test/unit/` | Canonicalization determinism (incl. RFC 8785 vectors), hash determinism, valid/invalid/wrong-signer/tampered signatures, placement inside/outside/at tolerance, the full verification pipeline, mock proof generator |
| `test/contract/` | Funding, commit (robot signature checked on-chain), settle/refund, unauthorized settlement, failed proof cannot settle, double settlement/refund, proof-hash reuse, malformed/high-s signatures, reentrancy, exactly-once accounting |
| `test/backend/` | HTTP API: task creation/validation, funding, lifecycle guards, valid proof ingestion → chain submission → settlement, malformed JSON/proofs, tampering, wrong task/robot/signer/target, false success flag, duplicate proof/settlement, concurrent submissions, cross-task replay, mock adapter |
| `test/e2e/` | The complete flow (create → fund → mock robot → proof → verify → commit → settle → confirm on-chain state, exactly once) |
| `test/adversarial/` | 170+ attack scenarios from CLAUDE.md §15 against the running system: tampering in every field and encoding, signature malleability, replay, races, hostile payloads (deep nesting, >1 MB, prototype keys), fault injection (lost receipts), contract-level money invariants |

## Running the pieces manually

```bash
# terminal 1 — local chain (chainId 31337, http://127.0.0.1:8545)
npm run chain

# terminal 2 — deploy the escrow (writes deployments/localhost.json), then start the backend
npm run deploy
npm run dev            # http://127.0.0.1:3000 (use ROBOT_ADAPTER=external for a real simulator)
```

Restarting the chain wipes the contract. The backend detects this on startup and tells you to run `npm run deploy` again.

Drive it with curl:

```bash
API=http://127.0.0.1:3000
curl -s -X POST $API/tasks -H 'content-type: application/json' -d '{"task_id":"task_001"}'
curl -s -X POST $API/tasks/task_001/fund
curl -s -X POST $API/tasks/task_001/start -H 'content-type: application/json' -d '{"mock_outcome":"success"}'
sleep 2
curl -s $API/tasks/task_001        # status SETTLED, tx hashes, verification checks, live on-chain state
```

`mock_outcome` is one of `success`, `failure` (object dropped mid-route) or `false_success` (the robot claims success but the object is misplaced).

## API

All bodies are JSON with snake_case fields. Errors are `{ "error": string, "details"?: … }`.

| Method & path | Body | Result |
|---|---|---|
| `GET /health` | | chain id, escrow address, verifier, robot adapter, robot registry |
| `POST /tasks` | optional: `task_id`, `description`, `robot_id`, `start_position`, `target_position` (`{x,y,z}` in m), `tolerance` (m), `reward_eth` (string), `payee` | `201` Task (`CREATED`) |
| `GET /tasks` | | all tasks |
| `GET /tasks/:taskId` | | Task + `onchain` (live escrow state from the contract) |
| `POST /tasks/:taskId/fund` | | locks `reward` in escrow → `FUNDED` (+ `transactions.fund`) |
| `POST /tasks/:taskId/start` | optional `mock_outcome` | `202` → `RUNNING`; the robot adapter executes |
| `POST /tasks/:taskId/proof` | `{ proof, signature, proof_hash? }` | verifies → commits on-chain → `SETTLED` or `FAILED` (`422` rejected, `409` wrong state/duplicate) |
| `POST /tasks/:taskId/settle` | | retries settlement for a `VERIFIED` task (normally automatic). `409` if already settled. |

A Task contains `status`, `events[]` (a timeline for a future frontend), `proof` (the raw proof, its canonical form, `proof_hash`, signature and recovered signer), `verification` (`passed`, `reasons`, every check with its detail, and the measured placement), `transactions` (`fund`, `commit`, `settle`/`refund` tx hashes), and `onchain` on `GET /tasks/:id`.

## Robotics integration interface

The simulator has to produce this JSON. Extra fields such as `trajectory`, `events` or sensor data are allowed, preserved and covered by the hash:

```json
{
  "task_id": "task_001",
  "robot_id": "robot_001",
  "timestamp": "2026-10-07T12:00:00Z",
  "start_position": { "x": 0, "y": 0, "z": 0 },
  "target_position": { "x": 1, "y": 0, "z": 0 },
  "final_object_position": { "x": 1.01, "y": 0.01, "z": 0 },
  "success": true
}
```

The proof must also meet these rules:

- `task_id` and `robot_id` must match the task.
- `start_position` and `target_position` must equal the task's points.
- Coordinates are in meters.
- `timestamp` must be ISO 8601 with a timezone, e.g. UTC `…Z`.
- `timestamp` must not be earlier than the task's creation, with a 5-minute clock-skew allowance. Stale proofs are rejected.

It is then submitted as `POST /tasks/:task_id/proof` with:

```json
{ "proof": { … }, "signature": "0x<65-byte EIP-191 signature>", "proof_hash": "0x<optional, checked if present>" }
```

where `proof_hash = keccak256(utf8(RFC8785_canonical_json(proof)))` and `signature = personal_sign(proof_hash bytes)` by the robot's registered key.

The simulator can deliver its proof in either of two ways:

**Option A — no crypto in the simulator.** Write the raw proof to a file and let the gateway CLI sign and submit it with `ROBOT_PRIVATE_KEY`:

```bash
ROBOT_ADAPTER=external npm run dev                       # backend waits for external proofs
curl -s -X POST localhost:3000/tasks -H 'content-type: application/json' -d '{"task_id":"task_001"}'
curl -s -X POST localhost:3000/tasks/task_001/fund
npm run robot:submit -- examples/proof.sample.json --now # sign + POST
```

`--now` re-stamps the sample's fixed timestamp with the current time. `--print` only prints the signed submission, and `--api <url>` targets another backend.

**Option B — sign in Python.** Requires `pip install rfc8785 eth-account requests`. This snippet was verified against the running backend:

```python
import rfc8785, requests
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak

# proof["timestamp"] must be current UTC, e.g. datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
proof_hash = keccak(rfc8785.dumps(proof))                                   # RFC 8785 canonical JSON → keccak256
signed = Account.sign_message(encode_defunct(primitive=proof_hash), private_key=ROBOT_PRIVATE_KEY)
requests.post(f"{API}/tasks/{proof['task_id']}/proof", json={
    "proof": proof,
    "signature": "0x" + bytes(signed.signature).hex(),
    "proof_hash": "0x" + proof_hash.hex(),
})
```

To swap mock → real, set `ROBOT_ADAPTER=external` and have the simulator submit as above. Nothing else changes. Our canonical bytes and hashes were cross-checked against Python's `rfc8785` package, including numbers (`1.0`→`1`, `1e21`, `-0`), unicode and key ordering.

## How a proof is verified

`src/proof/verify.ts` runs these checks in order and reports every check, with a reason, in `verification.checks`:

1. **submission_schema / proof_schema**: the payload is valid against the zod schemas. Malformed input gets `422`.
2. **task_id_match / robot_id_match**: the proof is bound to this task and its assigned robot. This blocks cross-task replay.
3. **proof_hash**: RFC 8785 canonical JSON of the proof *exactly as received*, then keccak256. Keys are sorted by UTF-16 code units, there is no whitespace, numbers use ECMAScript formatting, and it never depends on JS key order. A claimed `proof_hash` that differs means tampering.
4. **signature**: the EIP-191 signer recovered from the hash must be the registered robot address. Any edit after signing changes the hash, so the recovered signer changes too. Recovery is as strict as OpenZeppelin's (65 bytes, v ∈ {27, 28}, low-s), so off-chain acceptance always matches on-chain acceptance.
5. **task_geometry**: the proof's start/target must equal the task's, so a robot cannot move the goalposts.
6. **timestamp**: the proof must not predate the task (5 min skew allowance). This blocks replaying an old robot-signed proof onto a re-created task with the same id.
7. **physical_placement**: `distance(final_object_position, task.target_position) ≤ tolerance`. The boundary is inclusive, with a 1 nm epsilon for float noise. This is computed by the verifier and **never taken from `success`**.
8. **success_claim**: the robot's `success` flag must agree with the measurement. The task passes only if `success === true` **and** the placement is within tolerance.

Failures in steps 1–6 reject the proof: nothing goes on-chain and the state is unchanged. Rejections are bounded in what they store, so junk submissions can't grow memory without limit. Failures in steps 7–8 mean the task failed: the proof is committed as failed and the escrow is refunded.

**Chain reconciliation.** A transaction can be mined while its receipt is lost, for example on an RPC timeout. In that case the backend looks up the escrow event that transaction would have emitted (`TaskFunded`, `ProofCommitted`, `TaskSettled` or `TaskRefunded`, matched against the task's exact parameters) and adopts the on-chain result, so in-memory state never diverges from the chain. This also lets a backend restart re-adopt a still-funded escrow when the same task is re-created. Payees must be externally owned accounts, because a contract payee that rejects ETH would lock settlement.

## Smart contract: `MachineTaskEscrow`

| Function | Caller | Effect |
|---|---|---|
| `fundTask(taskId, robot, payee)` payable | requester | Locks `msg.value`. `taskId = keccak256(utf8(task_id))`. |
| `commitProof(taskId, proofHash, passed, robotSignature)` | verifier | Requires `Funded`, an unused `proofHash`, and `ecrecover(EIP-191(proofHash)) == robot`. Stores the hash. Moves to `Verified` or `Failed`. |
| `settle(taskId)` | verifier | Requires `Verified`. Moves to `Settled` **before** paying `amount` to the payee. |
| `refund(taskId)` | verifier or requester | Requires `Failed`. Moves to `Refunded`, then returns the escrow. |
| `getTask(taskId)` | anyone | requester, robot, payee, amount, proofHash, status |

Only the 32-byte proof hash is stored on-chain, and the full proof stays off-chain. Anyone holding the off-chain proof (`GET /tasks/:id` → `proof.raw`) can recompute `keccak256(canonicalize(proof))` and compare it to the on-chain `proofHash`. They can also check that the robot signed it.

## Trust model (what this MVP does and does not prove)

| Role | Who | Trusted for |
|---|---|---|
| Proof producer | robot / simulator (robot key) | Reporting the measured final state honestly. The coordinates are self-reported by the same key that signs, so the verifier catches an *inconsistent* or failing robot, not a robot that fabricates perfect coordinates. A simulation cannot prove physical reality. |
| Verifier / oracle | this backend (verifier key) | Running the checks above. It attests pass/fail on-chain. |
| Commitment + settlement | `MachineTaskEscrow` | Immutable proof commitment. It only pays out after a verifier-attested pass of a proof the registered robot actually signed, and at most once. |

What the contract enforces on its own:

- The verifier cannot commit a proof hash the robot never signed.
- Money moves at most once per task.
- Only the verifier can settle.

What it does **not** enforce, and trusts the verifier for:

- The pass/fail verdict. The contract would pay out on an out-of-tolerance proof if the verifier attested a pass.
- That the proof belongs to this task. The robot signs only the proof hash (no escrow address or chain id). The task binding (`task_id`, geometry, timestamp) lives inside the signed JSON, where the backend checks it.

In the local demo setup, one backend process holds the verifier, requester (funding) and robot (mock) keys, so those roles are a single party. In a real deployment the robot key lives on the robot, and the requester funds from their own wallet.

Known MVP limits:

- There is no timeout or cancel path. Escrow stays locked if a proof never arrives. The adversarial suite has a pending test for this.
- The task store and the off-chain proofs live in memory. After a restart, the on-chain hashes and money are intact, but the proof payloads they commit to are gone unless saved elsewhere.
- There is a single registered robot.
- A replay of a stale proof is still possible within the 5-minute clock-skew window after a task id is re-created on a fresh deployment.

The verifier sits behind clean interfaces (`verifyProofSubmission`, `EscrowClient.commitProof`), so stronger attestation could later replace or augment it. Examples are TEE-signed sensor data, independent measurement such as camera or vision, multiple verifiers, or ZK proofs.

## Project layout

```text
contracts/MachineTaskEscrow.sol      escrow + proof commitment (contracts/test/ = test-only helper)
src/config.ts                        env config (zod), dev-key safety check
src/proof/                           schema, canonicalize, hash, signature, physical, verify
src/robot/                           adapter interface, mock adapter, mock proof generator
src/tasks/                           task types + TaskService (state machine / orchestration)
src/chain/                           EscrowClient, provider, deployment record
src/api/app.ts                       Express routes
src/bootstrap.ts, src/server.ts      wiring + entry point (npm run dev)
scripts/deploy.ts                    npm run deploy
scripts/demo.ts                      npm run demo
scripts/robot-submit.ts              npm run robot:submit (robot gateway CLI)
examples/proof.sample.json           sample simulator proof
test/{unit,contract,backend,e2e,adversarial}/
```
