# MachineProof

**Verifiable machine work, settled on-chain by Chainlink CRE.**

A requester locks payment in an escrow contract. A robot (simulated) picks an object up at point A and places it at point B, and signs an execution proof. A **Chainlink CRE workflow** turns that machine event into on-chain settlement. It pulls the evidence and reads the escrow on-chain. It then re-verifies everything itself: the proof's integrity, the robot's signature against the robot registered *on-chain*, the task spec anchored at funding, and the measured placement. Finally it writes a signed report that commits the proof hash and pays the robot's operator, or refunds the requester, in one transaction.

> **Chainlink CRE is the orchestration layer connecting verified machine execution to autonomous on-chain settlement.**

```text
Create task → fund escrow (+ anchor task spec) → robot executes → signed proof → backend pre-screen
→ CRE workflow: fetch evidence · read escrow on-chain · re-verify · decide · DON-signed report
→ KeystoneForwarder → MachineTaskEscrow.onReport → commit proof + pay | refund → CRE confirms on-chain
```

## Chainlink CRE sponsor track: what CRE does in MachineProof

The workflow lives in [`cre/machineproof-settlement/`](cre/machineproof-settlement). It is built with the official CRE TypeScript SDK `@chainlink/cre-sdk` 1.23, compiled to WASM, and run by the official CRE CLI (`cre workflow simulate`). It owns everything between "a robot says it finished" and "money moved":

| Step | CRE capability | What the workflow does |
|---|---|---|
| 1 | **HTTP trigger** | Receives `{task_id, proof_hash}` when a machine event is ready. In production the robot's or backend's key is an `authorizedKeys` signer. |
| 2 | **HTTP client** (node mode + identical consensus) | Fetches the evidence from the backend: the task spec and the robot-signed raw proof. |
| 3 | **EVM read** | Reads `MachineTaskEscrow.getTask` and `taskSpecHash`: status, locked amount, **the robot address registered on-chain**, and the task-spec anchor. Duplicates (already Settled or Refunded) stop here. Before writing it also checks `proofHashUsed`, so a robot signature replayed onto another task is rejected. |
| 4 | Deterministic compute | Independent verification in [`policy.ts`](cre/machineproof-settlement/policy.ts), 11 checks. The proof hash is recomputed (RFC 8785 JCS + keccak256, using the same canonicalizer as the backend) and must match the trigger. Task and robot binding is checked. The **task spec must hash to the on-chain anchor**. The EIP-191 signature must recover to the **on-chain robot**. Start and target geometry, freshness, the **measured placement versus tolerance**, and the robot's success claim are all checked. |
| 5 | Policy decision | Invalid evidence is REJECTED and **nothing is written**. Authentic evidence is ACCEPTED with `passed = success_claim && within_tolerance`. |
| 6 | **Report + EVM write** | `runtime.report(abi.encode(taskId, proofHash, passed, robotSig))` is DON-signed in production. `writeReport` sends it through the Chainlink forwarder to `MachineTaskEscrow.onReport`, which commits and settles or refunds atomically. |
| 7 | **EVM read** | Reads the escrow back. The forwarder swallows receiver reverts, so the workflow only claims success once the chain shows `Settled` or `Refunded` with its proof hash. |
| 8 | **HTTP client** | Reports its decision and checks to the backend. The callback is unauthenticated and strictly informational: it never changes settlement state, which the backend takes from the chain only. |

**Why CRE is essential here, not decorative:**

- **The backend does not settle.** In CRE mode the backend never signs a commit or settlement. The escrow's `onReport` accepts reports only from the configured Chainlink forwarder, and the CRE demo verifies the settling transaction came from the CRE transmitter, not from the backend key.

  The escrow's admin/verifier key still exists. It powers the local fallback path and can re-point the forwarder and the pins. A real deployment must separate it from the backend, for example with a multisig, or retire it (see the trust model).
- **CRE does not trust the backend either.** Robot identity and the task spec come from the chain. The workflow recomputes every hash and the verdict from the raw evidence. A backend that serves a tampered proof, a different target, or a different robot gets REJECTED, and no money moves.
- **One oracle becomes a DON.** In the local fallback a single verifier key decides payouts. Under CRE, a deployed workflow's report is produced by a Decentralized Oracle Network: each node runs the same deterministic policy, results go through consensus, and the KeystoneForwarder verifies the DON signatures.
- **Autonomous and portable.** The same workflow settles on any chain CRE supports by changing `chainSelectorName` and the forwarder. Locally that chain is Hardhat (`anvil-devnet`, chainId 31337).

## Architecture

```text
 ┌──────────────┐ signed proof ┌────────────────────────────┐  HTTP trigger {task_id, proof_hash}  ┌────────────────────────────────────┐
 │ Robot / sim  │ ───────────► │ Backend (src/)             │ ───────────────────────────────────► │ Chainlink CRE workflow             │
 │ executes A→B │  POST /proof │  task API, pre-screen,     │ ◄─────────── GET evidence ────────── │ cre/machineproof-settlement        │
 │ signs proof  │              │  evidence store            │ ◄─────────── POST result ─────────── │  verify · decide · report          │
 └──────────────┘              └─────────────▲──────────────┘                                      └───────┬───────────────▲────────┘
                                             │ adopts outcome from escrow events                           │ writeReport   │ getTask /
                                             │ (TaskSettled / TaskRefunded / CreReportProcessed)           ▼ (signed)      │ taskSpecHash
                               ┌─────────────┴──────────────────────────────────────────────┐   ┌──────────────────┐   │
                               │ MachineTaskEscrow (contracts/)                             │ ◄─│ KeystoneForwarder │   │
                               │ escrow · taskSpecHash anchor · onReport: commit proof hash │   │ (MockKeystone-   │   │
                               │ (robot sig re-checked on-chain) → pay payee | refund       │ ──┤  Forwarder local)│───┘
                               └────────────────────────────────────────────────────────────┘   └──────────────────┘
```

| Layer | Code | Responsibility |
|---|---|---|
| Robot / simulator | `src/robot/`, `scripts/robot-submit.ts` | Produces execution evidence. A mock adapter is used until the real simulator is connected. |
| Backend | `src/` (Express) | Creates and funds tasks (anchoring the spec hash on-chain), pre-screens and stores proofs, serves CRE's evidence endpoint, triggers the workflow, and exposes demo-facing state that it **reads from the chain**. |
| **CRE workflow** | `cre/machineproof-settlement/` | Orchestrates verified machine event → independent verification → policy → on-chain settlement → confirmation. |
| Smart contract | `contracts/MachineTaskEscrow.sol` | Escrow, proof commitment, settlement authorization (`onReport` from the forwarder only), exactly-once payout, and double-settlement protection. |

**Local fallback.** With `SETTLEMENT_MODE=direct` (the default for `npm run dev`, `npm test` and `npm run demo`), the backend's verifier key does steps 6–7 itself, through `commitProof` and `settle`/`refund` on the same contract and state machine. It needs no CRE account and is kept as the reliable development path.

## Quick start

### CRE demo (sponsor path)

Prerequisites (one-time):

1. Node.js ≥ 20 and npm. Tested on Node 24.15.
2. [bun](https://bun.sh) ≥ 1.2.21. CRE compiles TypeScript workflows with it.
3. The CRE CLI ≥ 1.37: `curl -sSL https://app.chain.link/cre/install.sh | bash`. See the [install guide](https://docs.chain.link/cre/getting-started/cli-installation).
4. A free CRE account. `cre workflow simulate` requires a session: run `cre login` once (it opens a browser), or set `CRE_API_KEY`.

```bash
npm install
npm run cre:install        # bun install for the workflow (also sets up the CRE WASM toolchain)
cre login                  # once
npm run demo:cre
```

`npm run demo:cre` runs everything locally:

- It starts a Hardhat chain if none is running.
- It deploys the CRE stack: MockKeystoneForwarder and the escrow with `creForwarder` set.
- It starts the backend in CRE mode.
- It launches the **real** `cre workflow simulate --listen --broadcast` and streams the workflow's own logs, tagged `⬡ CRE`.
- It runs three scenarios:
  - **Robot succeeds.** CRE verifies the proof and settles on-chain.
  - **Robot lies** (`success=true`, part misplaced). CRE measures the misplacement and refunds the requester.
  - **Duplicate trigger.** CRE reads `Settled` on-chain and writes nothing.

For every settlement the demo checks on-chain that the transaction went CRE transmitter → MockKeystoneForwarder → `MachineTaskEscrow.onReport`, that `ReportProcessed(result=true)` and `CreReportProcessed(workflowId)` were emitted, that commit and payout happened in one transaction, and that the payee was paid exactly once. It exits non-zero if any check fails.

Excerpt of a real run. The `⬡ CRE` lines are the workflow's own logs from `cre workflow simulate`, and the CRE run finishes before the paced demo narration catches up:

```text
━━ Scenario 1 — robot delivers; Chainlink CRE verifies and settles on-chain ━━
✓ Task created                       task_123b79ca: pick (0, 0, 0) → place (1, 0, 0) ±0.05 m
✓ Escrow funded + task spec anchored 0.1 ETH locked, spec_hash 0x5a5034d4…c9531d  tx 0x3b295498…9326c4
✓ Robot execution started            robot_001 via mock simulator (places the part)
   ⬡ CRE │ ▶ workflow run started by HTTP trigger
✓ Execution proof received           11 trajectory points, signed by 0x3C44CdDd…4293BC
   ⬡ CRE │ [1/8] Trigger: settle task task_123b79ca with proof 0x06780f37…89b259
   ⬡ CRE │ [2/8] Evidence fetched from backend (HTTP 200, 1736 bytes): task spec + robot-signed proof
   ⬡ CRE │ [3/8] Escrow 0xef11D1c2…8A64Ca on anvil-devnet: status Funded, 0.1 ETH locked, robot 0x3C44CdDd…4293BC, spec anchor 0x5a5034d4…c9531d
   ⬡ CRE │ [4/8] Independent verification — 11/11 checks passed:
   ⬡ CRE │ ✓ trigger_binding    proof hash 0x06780f37…89b259 matches the trigger and the backend's record
   ⬡ CRE │ ✓ spec_anchor        task spec hash 0x5a5034d4…c9531d matches the on-chain anchor
   ⬡ CRE │ ✓ signature          EIP-191 signature recovers to 0x3C44CdDd…4293BC, the robot registered on-chain
   ⬡ CRE │ ✓ physical_placement object placed 0.015 m from target (1, 0, 0) (tolerance 0.050 m)
   ⬡ CRE │ [5/8] Verdict: ACCEPT — task PASSED (0.015 m from target) → settle: pay 0.1 ETH to 0x90F79bf6…93b906
   ⬡ CRE │ [6/8] DON-signed report (taskId, proofHash, passed=true, robotSig) delivered via forwarder: tx 0x0aa68c15…801a3d
   ⬡ CRE │ [7/8] Confirmed on-chain: task Settled, proof 0x06780f37…89b259 committed, 0.1 ETH released to 0x90F79bf6…93b906
   ⬡ CRE │ [8/8] Backend notified of SETTLED: HTTP 200
✓ Backend pre-screen passed          keccak256(RFC 8785 proof) = 0x06780f37…89b259, robot signature valid
✓ Handed to Chainlink CRE            HTTP trigger http://127.0.0.1:2000/trigger {task_id, proof_hash} — the backend does not settle
   … CRE workflow running: the lines tagged ⬡ CRE are streamed live from `cre workflow simulate`
✓ Backend adopted CRE settlement     task SETTLED (read from the escrow, not trusted from CRE's callback)
✓ CRE report written on-chain        tx 0x0aa68c15…801a3d: CRE transmitter 0xa0Ee7A14…a79720 → MockKeystoneForwarder 0x95bD8D42…f9a87A
✓ Escrow accepted it (IReceiver.onReport) ReportProcessed(result=true), CreReportProcessed(workflowId 0x11111111…111111)
✓ Proof committed + paid atomically  commit and payout in the same CRE transaction
✓ Final on-chain state confirmed     escrow status Settled, on-chain proofHash == keccak256(canonical off-chain proof)
✓ Settled by CRE, not the backend key backend verifier 0xf39Fd6e5…b92266 sent no settlement transaction
✓ CRE workflow reported back         decision SETTLED, 11/11 checks ok
✓ Payment settled exactly once       payee +0.1 ETH, 1 TaskSettled event
…
━━ Summary ━━
  task_123b79ca: SETTLED — CRE re-verified the robot proof and settled via its signed report
  task_3004b581: FAILED  — CRE measured the misplacement and refunded the requester
  duplicate trigger: SKIPPED — CRE checked the chain first; the escrow pays at most once

All checks passed ✓
```

### Fallback demo (no CRE account needed)

```bash
npm install
npm run demo               # same flow, settled by the backend's verifier key; also runs attack scenarios
```

### Real robot simulator demo (PyBullet)

```bash
(cd robotics && ./setup.sh)   # once: Python 3.11 venv + PyBullet (builds a wheel on Apple Silicon)
npm run demo:sim              # real simulator → backend → direct settlement (success + dropped-cube refund)
npm run demo:sim:cre          # same, settled through the Chainlink CRE workflow simulator
```

## Running the CRE path step by step

```bash
# terminal 1 — local chain (chainId 31337 = CRE chain-selector "anvil-devnet")
npm run chain

# terminal 2 — deploy MockKeystoneForwarder + MachineTaskEscrow (creForwarder set). This writes
#              deployments/localhost.json (backend) and cre/machineproof-settlement/config.local.json (workflow)
npm run cre:deploy

# terminal 3 — the CRE workflow, running in the official simulator as a long-lived HTTP trigger
npm run cre:simulate
#   = cd cre && cre workflow simulate ./machineproof-settlement --target local-simulation \
#              --listen --broadcast --limits none

# terminal 4 — backend in CRE settlement mode (hands proofs to http://127.0.0.1:2000/trigger)
npm run dev:cre
```

Then drive a task. Watch terminal 3 log the workflow steps `[1/8] … [8/8]`:

```bash
API=http://127.0.0.1:3000
curl -s -X POST $API/tasks -H 'content-type: application/json' -d '{"task_id":"task_cre_1"}'
curl -s -X POST $API/tasks/task_cre_1/fund         # also anchors the task spec hash on-chain
curl -s -X POST $API/tasks/task_cre_1/start -H 'content-type: application/json' -d '{"mock_outcome":"success"}'
sleep 5
curl -s $API/tasks/task_cre_1                       # status SETTLED, cre.report_tx, cre.forwarder, cre.workflow_result
```

The flags matter:

- `--broadcast` sends real transactions. Without it, `writeReport` is only an `eth_call` and the workflow reports `DRY_RUN`.
- `--listen` serves `POST http://localhost:2000/trigger` with body `{"input": {...}}`.
- `--limits none` lifts the production trigger rate limit of one HTTP trigger per 30 s, which would otherwise drop the extra triggers.

To compile the workflow to WASM without running it, use `npm run cre:build`, which runs `cre workflow build ./machineproof-settlement -T local-simulation` and needs no login. `npm run cre -- <args>` runs any CRE CLI command from `cre/`.

### How the official simulator reaches the local chain

`cre/project.yaml` declares the local chain as a CRE **experimental chain** (`experimental-chains:` with `chain-selector`, `rpc-url` and `forwarder`). CLI v1.37 supports this:

```yaml
local-simulation:
  experimental-chains:
    - chain-type: evm
      chain-selector: 7759470850252068959      # chain-selectors entry for chainId 31337 ("anvil-devnet")
      rpc-url: "http://127.0.0.1:8545"
      forwarder: "0x95bD8D42f30351685e96C62EDdc0d0613bf9a87A"
```

With `--broadcast`, the simulator's EVM capability calls `report(receiver, rawReport, reportContext, signatures)` on that forwarder, signed by `CRE_ETH_PRIVATE_KEY`. The forwarder is the **MockKeystoneForwarder**, deployed from its exact bytecode: [`src/cre/MockKeystoneForwarder.json`](src/cre/MockKeystoneForwarder.json), taken from the Go binding the CRE CLI's simulator uses, with provenance recorded in the file. It hands `rawReport[45:109]` (the metadata) and `rawReport[109:]` (the report) to `MachineTaskEscrow.onReport`, exactly as on public testnets.

`npm run cre:deploy` deploys the forwarder and the escrow from dedicated Hardhat dev accounts (#8 and #7, at nonce 0), so their addresses are deterministic and match the committed config. The simulator's transmitter is dev account #9. `npm run cre:simulate` passes its key; `cre/.env.example` holds the same value for running the CLI by hand. All are **public Hardhat keys, local only**.

### Workflow interfaces

| | Format |
|---|---|
| Trigger input | `{"task_id": "task_ab12cd34", "proof_hash": "0x…"}` |
| Evidence (`GET {backendUrl}/cre/tasks/:id/evidence`) | `{ task: {task_id, onchain_task_id, robot_id, start_position, target_position, tolerance, created_at, spec_hash}, submission: {proof, signature, proof_hash} }` |
| Task spec anchor | `keccak256(RFC8785({task_id, robot_id, start_position, target_position, tolerance, created_at}))`, stored by `fundTaskWithSpec` |
| Report → `onReport` | `abi.encode(bytes32 taskId, bytes32 proofHash, bool passed, bytes robotSignature)` |
| Result callback (`POST {backendUrl}/cre/tasks/:id/result`) | `{decision: SETTLED \| REFUNDED \| REJECTED \| SKIPPED, proof_hash, passed, reasons, checks, tx_hash, onchain_status, workflow}` |

The workflow config is `cre/machineproof-settlement/config.local.json`: `backendUrl`, `chainSelectorName`, `escrowAddress`, `gasLimit`, `proofClockSkewSeconds`, `requireSpecAnchor` and `authorizedTriggerKeys`. The last one may be empty only in simulation; deployed workflows must list their trigger signers.

### Task lifecycle

```text
CREATED ─fund─► FUNDED ─start─► RUNNING ─proof─► PROOF_RECEIVED ─┬─ passed ─► (VERIFIED) ─► SETTLED
                                                                 └─ failed ─► FAILED (escrow refunded)
```

In CRE mode, `PROOF_RECEIVED` means the backend pre-screen passed and the workflow has been triggered. The backend moves to `SETTLED` or `FAILED` when the **escrow** shows `Settled` or `Refunded`, via a 1 s chain watcher and on every `GET /tasks/:id`. It never moves on CRE's callback alone. `VERIFIED` only appears in direct mode, where commit and settle are separate transactions. The task's `cre` field records the trigger state, the workflow's result, the report transaction, the forwarder, the transmitter and the workflow id.

A *rejected* proof (malformed, tampered, wrong signer, wrong task) never reaches the chain or CRE. A failed submission restores the task exactly as it was, including any settlement already pending with CRE, so garbage submissions cannot DoS a task. A *failed* proof is authentic and correctly signed, but shows that the task did not succeed physically. It is committed on-chain as failed and the escrow is refunded.

While a CRE settlement is pending, the robot may submit a **replacement** proof in three cases:

- The trigger failed.
- The settlement timed out (`CRE_SETTLEMENT_TIMEOUT_MS`).
- The workflow reported rejecting that exact proof.

`POST /tasks/:id/settle` re-triggers the pending proof. A replacement still needs a valid robot signature, and the escrow pays at most once.

On-chain escrow status: `None → Funded → (Verified) → Settled`, or `Funded → (Failed) → Refunded`. A CRE report passes through the parenthesised states inside one transaction.

## Requirements

- Node.js ≥ 20 and npm (tested on Node 24.15 / npm 11).
- For the CRE path: bun ≥ 1.2.21, CRE CLI ≥ 1.37 (tested with v1.37.0), and a CRE account (`cre login`).
- Nothing else. The chain is a local Hardhat node, and state is in memory.

## Installation

```bash
npm install
npm run cre:install    # workflow dependencies (bun)
npm run compile        # contract + typechain types (also done by test/demo/deploy)
```

## Environment variables

Copy `.env.example` to `.env` if you need to change anything. **Every variable has a working local default**, and blank values mean "use the default".

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Backend HTTP port (Render injects it) |
| `HOST` | `0.0.0.0` | Bind address |
| `RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `ESCROW_ADDRESS` | from `deployments/localhost.json` | Escrow contract address |
| `ESCROW_DEPLOY_BLOCK` | `0` | Block the escrow was deployed at; event lookups start there. Public RPCs cap `eth_getLogs` ranges. |
| `SETTLEMENT_MODE` | `direct` | `cre` = the Chainlink CRE workflow settles (`npm run dev:cre`). `direct` = the backend's verifier key settles (local fallback). |
| `CRE_TRIGGER_URL` | `http://127.0.0.1:2000/trigger` | The workflow's HTTP trigger (served by `cre workflow simulate --listen`) |
| `CRE_SETTLEMENT_TIMEOUT_MS` | `120000` | After this, a pending CRE settlement is marked `TIMEOUT`; retry with `POST /tasks/:id/settle` |
| `CRE_BACKEND_URL` | `http://127.0.0.1:$PORT` | Backend URL that `npm run cre:deploy` writes into the workflow config |
| `CRE_ETH_PRIVATE_KEY` | Hardhat account #9 | CRE simulator transmitter. Only read by the CRE CLI; see `cre/.env.example`. |
| `CRE_CLI` | `cre` on PATH, else `~/.cre/bin/cre` | CRE CLI binary used by the scripts |
| `VERIFIER_PRIVATE_KEY` | Hardhat account #0 | Owns the escrow config (`setCreForwarder`). Commits and settles in direct mode. |
| `REQUESTER_PRIVATE_KEY` | Hardhat account #1 | Funds escrows (stand-in for the requester's wallet until a frontend exists) |
| `ROBOT_PRIVATE_KEY` | Hardhat account #2 | Robot signing key, used by the mock robot and `robot:submit` |
| `ROBOT_ID` / `ROBOT_ADDRESS` | `robot_001` / address of `ROBOT_PRIVATE_KEY` | Robot registry: proofs for `ROBOT_ID` must be signed by `ROBOT_ADDRESS` |
| `PAYEE_ADDRESS` | Hardhat account #3 | Receives payment on settlement |
| `ROBOT_ADAPTER` | `mock` | `mock` = backend simulates the robot on `/start`. `external` = real simulator POSTs proofs. |
| `MOCK_ROBOT_DELAY_MS` | `1500` | Simulated execution time |
| `POSITION_TOLERANCE_M` | `0.05` | Default success tolerance in meters |
| `DEFAULT_REWARD_ETH` | `0.1` | Default task reward |
| `MAX_REWARD_ETH` | unset (no cap) | Per-task reward cap. Recommended on public deployments, where anyone can create and fund tasks with the requester key. |

The default keys are Hardhat's **public** development accounts. The backend and deploy scripts refuse to use them on any chain other than 31337. No real secrets are stored in this repository.

## Tests

```bash
npm test                 # contracts, proof library, backend (direct + CRE mode), E2E, adversarial — Hardhat in-process
npm run test:workflow    # CRE workflow: policy + handler via the CRE SDK test runtime (bun, offline, no login)
npm run test:cre-live    # CRE workflow handler against a real backend process + Hardhat chain + MockKeystoneForwarder
npm run test:all         # npm test + test:workflow
npm run typecheck        # tsc over src, scripts, tests   (workflow: cd cre/machineproof-settlement && bun run typecheck)
```

| Suite | Covers |
|---|---|
| `test/unit/` | Canonicalization determinism (incl. RFC 8785 vectors), hash determinism, valid/invalid/wrong-signer/tampered signatures, placement inside/outside/at tolerance, the full verification pipeline, mock proof generator |
| `test/contract/` | Funding, commit (robot signature checked on-chain), settle/refund, unauthorized settlement, failed proof cannot settle, double settlement/refund, proof-hash reuse, malformed/high-s signatures, reentrancy, exactly-once accounting. **CRE receiver**, run through the real MockKeystoneForwarder bytecode: IReceiver/ERC165, `onReport` only from the forwarder, passing report → atomic commit + payout, failing → refund, wrong-key/tampered signatures, replayed reports, unfunded tasks, malformed payloads, rotated forwarder, workflow id/owner pinning, CRE and verifier paths sharing one state machine |
| `test/backend/` | HTTP API in direct mode, plus **CRE mode**: spec anchoring, 202 hand-off without backend settlement, exact evidence served, adoption of CRE settlement and refund from the chain (tx hashes, forwarder, transmitter, workflow id), watcher, trigger failure and retry, CRE rejection then resubmission, callback validation, spoofed callbacks ignored for money state |
| `test/e2e/` | The complete direct-mode flow (create → fund → mock robot → proof → verify → commit → settle → confirm on-chain state, exactly once) |
| `test/adversarial/` | 170+ attack scenarios from CLAUDE.md §15 against the running system |
| `cre/machineproof-settlement/*.test.ts` | Policy unit tests, a **parity test against the backend verifier** (same hashes and verdicts), and the handler driven through the official SDK test runtime (`@chainlink/cre-sdk/test`): settle, refund, tampered evidence, forged trigger hash, impostor robot key, altered task spec, duplicate trigger, receiver revert swallowed by the forwarder |
| `cre/machineproof-settlement/live.integration.test.ts` | Opt-in. The real handler with every capability bridged to live I/O: the backend process over HTTP, `eth_call` on Hardhat, and `MockKeystoneForwarder.report` sent from the transmitter. Covers settle, refund, duplicate trigger and forged trigger, with the backend adopting results from the chain. |

## API

All bodies are JSON with snake_case fields. Errors are `{ "error": string, "details"?: … }`.

| Method & path | Body | Result |
|---|---|---|
| `GET /health` | | chain id, escrow, verifier, robot adapter, robot registry, `settlement_mode`, and `cre.{trigger_url, forwarder}` in CRE mode |
| `POST /tasks` | optional: `task_id`, `description`, `robot_id`, `start_position`, `target_position` (`{x,y,z}` in m), `tolerance` (m), `reward_eth` (string), `payee` | `201` Task (`CREATED`) |
| `GET /tasks` | | all tasks |
| `GET /tasks/:taskId` | | Task + `onchain` (live escrow state, incl. `spec_hash`). In CRE mode this also syncs the settlement from the chain. |
| `POST /tasks/:taskId/fund` | | Locks `reward` in escrow and anchors the task spec hash → `FUNDED` |
| `POST /tasks/:taskId/start` | optional `mock_outcome` | `202` → `RUNNING`; the robot adapter executes |
| `POST /tasks/:taskId/proof` | `{ proof, signature, proof_hash? }` | Direct: verifies → commits → `SETTLED` or `FAILED` (`200`). CRE: pre-screens → triggers the workflow → `202 PROOF_RECEIVED`. Both: `422` rejected, `409` wrong state or duplicate, `502` chain or trigger unavailable. |
| `POST /tasks/:taskId/settle` | | Direct: retries settlement of a `VERIFIED` task. CRE: re-triggers the workflow (it skips tasks no longer Funded). `409` if already settled. |
| `GET /cre/tasks/:taskId/evidence` | | **For the CRE workflow:** task spec + raw robot-signed proof (`404` if there is no proof yet) |
| `POST /cre/tasks/:taskId/result` | workflow decision | **For the CRE workflow:** records its decision and checks (informational). A `REJECTED` decision lets the robot resubmit. |

A Task contains:

- `status`, plus `settlement_mode` and `spec_hash`.
- `events[]`, a timeline for a future frontend.
- `proof`: the raw proof, its canonical form, `proof_hash`, the signature and the recovered signer.
- `verification`: the backend's checks.
- `transactions`: `fund`, `commit`, and `settle`/`refund` tx hashes.
- `cre` (CRE mode): trigger status, `workflow_result`, `report_tx`, `forwarder`, `transmitter` and `workflow_id`.
- `onchain`, on `GET /tasks/:id`.

## Fallback: running the direct path manually

```bash
# terminal 1 — local chain (chainId 31337, http://127.0.0.1:8545)
npm run chain

# terminal 2 — deploy the escrow (writes deployments/localhost.json), then start the backend
npm run deploy
npm run dev            # http://127.0.0.1:3000 (use ROBOT_ADAPTER=external for a real simulator)
```

Restarting the chain wipes the contracts. The backend detects this on startup and tells you to redeploy, with `npm run deploy` or `npm run cre:deploy`.

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

## Deploying to Render

The backend deploys as a Render **Web Service** against a public testnet (Ethereum Sepolia by default; any EVM RPC works). [`render.yaml`](render.yaml) is a ready Blueprint.

| | |
|---|---|
| Build | `npm ci --include=dev && npm run build`: Hardhat compiles the contract types, then `tsc -p tsconfig.build.json` writes `dist/` |
| Start | `npm start` = `node dist/src/server.js`. Plain Node, no `tsx` at runtime. Binds `HOST=0.0.0.0` on Render's `PORT`. |
| Health check | `GET /health`: `200` when the chain is reachable, `503` otherwise |
| Node | `.node-version` (24); `engines.node >= 20` |

Local development is unchanged: `npm run dev` still runs the TypeScript sources with `tsx`, and the Hardhat and CRE demos don't use `dist/`.

**1. Put testnet keys in `.env.sepolia` and fund them.** Use fresh, testnet-only keys, never Hardhat's public dev keys; the backend refuses those off the local chain.

```bash
cp .env.example .env.sepolia   # gitignored, like every .env* file except .env.example
```

In `.env.sepolia`, set these:

- `RPC_URL`, e.g. `https://ethereum-sepolia-rpc.publicnode.com`.
- `VERIFIER_PRIVATE_KEY`. Needs Sepolia ETH, for deployment and settlement gas.
- `REQUESTER_PRIVATE_KEY`. Needs Sepolia ETH, for rewards and gas.
- `ROBOT_PRIVATE_KEY`. It only signs, so it needs no funds.
- `PAYEE_ADDRESS`, which can be any address you control.

Don't put testnet keys in `.env`. The local Hardhat demo and `npm run dev` read `.env` and need the dev accounts. Don't pass keys on the command line either, where they end up in shell history.

**2. Deploy the escrow to the testnet** from your machine:

```bash
npm run deploy:sepolia   # loads .env.sepolia only; refuses an unfunded verifier
#   → prints ESCROW_ADDRESS=0x…  and  ESCROW_DEPLOY_BLOCK=…   (for the Render dashboard and .env.sepolia)
# optional: CRE_FORWARDER_ADDRESS=0x… npm run deploy:sepolia  also points the escrow at a Chainlink forwarder
```

`npm run dev:sepolia` runs the backend locally against the testnet, using the same file.

**3. Create the service.** In the Render dashboard, choose **New → Blueprint** and pick this repository. Then fill in the `sync: false` values. They are entered only in the dashboard (**Service → Environment**), never in `render.yaml`:

- `RPC_URL`
- `ESCROW_ADDRESS` and `ESCROW_DEPLOY_BLOCK`
- `VERIFIER_PRIVATE_KEY`, `REQUESTER_PRIVATE_KEY` and `ROBOT_PRIVATE_KEY`
- `PAYEE_ADDRESS`

Without the Blueprint, create a Web Service with the build and start commands above, health check path `/health`, and the same environment variables.

**4. Check it:**

```bash
curl https://<your-service>.onrender.com/health        # {"ok":true,"chain_id":"11155111",…}
API=https://<your-service>.onrender.com
curl -s -X POST $API/tasks -H 'content-type: application/json' -d '{"task_id":"render_1"}'
curl -s -X POST $API/tasks/render_1/fund
curl -s -X POST $API/tasks/render_1/start -H 'content-type: application/json' -d '{"mock_outcome":"success"}'
sleep 30 && curl -s $API/tasks/render_1                  # SETTLED (testnet blocks take ~12 s each)
```

Notes:

- **Logging.** `/health` and the startup log show only the RPC **origin**, so API keys in `RPC_URL` aren't logged.
- **In-memory state.** Tasks live in memory, so a restart or free-plan sleep clears the task list. Escrows and payments stay on-chain.
- **CRE on Render.** The Render service runs `SETTLEMENT_MODE=direct`. CRE settlement needs a workflow trigger the service can reach (`CRE_TRIGGER_URL`): a deployed CRE workflow, or `cre workflow simulate --listen` exposed from another host. The workflow also needs `backendUrl` set to the Render URL, and the escrow's `creForwarder` set to that network's Chainlink forwarder.

## Robotics integration interface

The PyBullet robot simulator in [`robotics/`](robotics/README.md) implements this interface end to end. With the backend running as `ROBOT_ADAPTER=external` (direct or `SETTLEMENT_MODE=cre`), create and fund a task, then:

```bash
npm run robot:sim -- <task_id>                         # start → simulate A→B → write robotics/results/<task_id>.json → robot:submit
npm run robot:sim -- <task_id> --fault drop_in_transit # failure demo: measured miss → refund
```

The simulator writes an unsigned proof (Option A below); `robot:submit` signs and submits it. Proofs stay under the 16 kB limit for CRE settlement (trajectory sampled every 0.5 s).

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

The backend pre-screen (`src/proof/verify.ts`) and the CRE workflow (`cre/machineproof-settlement/policy.ts`) implement the same policy. A parity test asserts identical hashes and verdicts. The workflow adds the trigger binding, the on-chain task-spec anchor, and robot identity taken from the chain. `src/proof/verify.ts` runs these checks in order and reports every check, with a reason, in `verification.checks`:

1. **submission_schema / proof_schema**: the payload is valid against the zod schemas. Malformed input gets `422`.
2. **task_id_match / robot_id_match**: the proof is bound to this task and its assigned robot. This blocks cross-task replay.
3. **proof_hash**: RFC 8785 canonical JSON of the proof *exactly as received*, then keccak256. Keys are sorted by UTF-16 code units, there is no whitespace, numbers use ECMAScript formatting, and it never depends on JS key order. A claimed `proof_hash` that differs means tampering.
4. **signature**: the EIP-191 signer recovered from the hash must be the registered robot address. Any edit after signing changes the hash, so the recovered signer changes too. Recovery is as strict as OpenZeppelin's (65 bytes, v ∈ {27, 28}, low-s), so off-chain acceptance always matches on-chain acceptance.
5. **task_geometry**: the proof's start/target must equal the task's, so a robot cannot move the goalposts.
6. **timestamp**: the proof must not predate the task (5 min skew allowance). This blocks replaying an old robot-signed proof onto a re-created task with the same id.
7. **physical_placement**: `distance(final_object_position, task.target_position) ≤ tolerance`. The boundary is inclusive, with a 1 nm epsilon for float noise. This is computed by the verifier and **never taken from `success`**.
8. **success_claim**: the robot's `success` flag must agree with the measurement. The task passes only if `success === true` **and** the placement is within tolerance.

Failures in steps 1–6 reject the proof: nothing goes on-chain and the state is unchanged. Rejections are bounded in what they store, so junk submissions can't grow memory without limit. Failures in steps 7–8 mean the task failed: the proof is committed as failed and the escrow is refunded.

**Chain reconciliation.** A transaction can be mined while its receipt is lost, for example on an RPC timeout. In that case the backend looks up the escrow event that transaction would have emitted (`TaskFunded`, `ProofCommitted`, `TaskSettled`, `TaskRefunded` or `CreReportProcessed`, matched against the task's exact parameters) and adopts the on-chain result, so in-memory state never diverges from the chain.

In direct mode this also lets a backend restart re-adopt a still-funded escrow when the same task is re-created. In CRE mode re-adoption additionally requires the re-created task's spec to match the on-chain anchor. It normally won't, because `created_at` differs, so the backend refuses with `409` rather than adopt a task the workflow would reject forever. When the backend adopts an on-chain settlement that contradicts its own verdict or the proof it handed to CRE, it records an `ERROR` event.

Payees must be externally owned accounts, because a contract payee that rejects ETH would lock settlement. In CRE mode, proofs larger than 16 kB are rejected at pre-screen so the evidence fits CRE's consensus limit.

## Smart contract: `MachineTaskEscrow`

| Function | Caller | Effect |
|---|---|---|
| `fundTaskWithSpec(taskId, robot, payee, specHash)` payable | requester | Locks `msg.value` and anchors the task spec hash. `taskId = keccak256(utf8(task_id))`. `fundTask(taskId, robot, payee)` is the same without a spec anchor. |
| `onReport(metadata, report)` | **CRE forwarder only** | `IReceiver`: decodes `(taskId, proofHash, passed, robotSignature)` and runs `commitProof` then `settle` (passed) or `refund` (failed) **in one transaction**. Emits `CreReportProcessed(taskId, workflowId, workflowOwner, proofHash, passed)`. |
| `setCreForwarder(forwarder)` | verifier | The Chainlink forwarder allowed to deliver reports: the MockKeystoneForwarder locally, the KeystoneForwarder in production |
| `setCreWorkflow(workflowId, owner)` | verifier | Pins on the report metadata (zero = off). They are optional locally, where the simulator's metadata is fixed, but **required in production**, where they ensure only this workflow of this owner may settle. Re-pin after every redeploy, since the workflow id changes. |
| `commitProof(taskId, proofHash, passed, robotSignature)` | verifier | Fallback path. Requires `Funded`, an unused `proofHash`, and `ecrecover(EIP-191(proofHash)) == robot`. |
| `settle(taskId)` / `refund(taskId)` | verifier / verifier or requester | Fallback path. `Verified → Settled` pays the payee; `Failed → Refunded` repays the requester. The status changes **before** the transfer. |
| `getTask(taskId)`, `taskSpecHash(taskId)`, `supportsInterface` | anyone | Escrow state, spec anchor, ERC-165 (`IReceiver`) |

Both paths share one internal state machine. Every commit re-checks the robot's signature on-chain, every proof hash can be used once, and every task pays out at most once, whichever path settles it. Only the 32-byte proof hash is stored on-chain; the full proof stays off-chain (`GET /tasks/:id` → `proof.raw`), and anyone can recompute `keccak256(canonicalize(proof))` and compare.

## Trust model (what this MVP does and does not prove)

| Role | Who | Trusted for |
|---|---|---|
| Proof producer | robot / simulator (robot key) | Reporting the measured final state honestly. The coordinates are self-reported by the same key that signs, so verification catches an *inconsistent* or failing robot, not one that fabricates perfect coordinates. A simulation cannot prove physical reality. |
| Evidence store / pre-screen | backend | Serving the evidence it received. CRE does **not** trust it for robot identity, the task spec, hashes or the verdict, so a backend that alters any of these is rejected. It can still *withhold* evidence (liveness). |
| Verifier / settlement orchestrator | **Chainlink CRE workflow** (fallback: backend verifier key) | Running the policy and writing the report. In production that is a DON: every node runs the same deterministic policy, results go through consensus, and the report carries DON signatures. |
| Commitment + settlement | `MachineTaskEscrow` | Accepting reports only from the configured forwarder. It re-checks the robot signature on-chain, commits once and pays at most once. |

What the contract enforces on its own:

- No proof the registered robot never signed can be committed.
- Each proof hash is used once.
- Money moves at most once per task.
- Only the forwarder (CRE) or the verifier (fallback) can settle.

What it does **not** enforce, and who is trusted for it:

- **The pass/fail verdict** is attested by the settling party. The contract does not re-measure placement.
- **The task binding inside the proof.** The robot signs only the proof hash, with no escrow address or chain id. `task_id`, geometry and timestamp live inside the signed JSON, and the workflow and backend check them.
- **Local simulation forwarder is permissionless.** The MockKeystoneForwarder (Chainlink's simulation forwarder) checks no DON signatures. Its `report()` and `route()` are open to anyone, with arbitrary metadata, which defeats the `setCreWorkflow` pins locally.

  The escrow still requires a genuine robot signature over the committed hash. But robot signatures become public as soon as a proof is submitted (`GET /tasks/:id`, evidence endpoint). Locally, anyone can therefore do any of the following:

  - Settle a *failing* proof as `passed=true`.
  - Force a refund of a passing one.
  - Replay task A's proof onto task B of the same robot. The workflow then rejects A's proof as `proof_reuse`, and A needs a fresh robot proof.

- **In production** the **KeystoneForwarder verifies the DON's signatures**. With `setCreWorkflow(workflowId, owner)` pinned, only reports produced by this workflow reach `onReport`. Unpinned, any workflow on the same DON could write to the escrow. The escrow itself also accepts tasks funded without a spec anchor; the workflow is what insists on one (`requireSpecAnchor`).
- **The admin/verifier key keeps full authority.** In CRE mode the backend's verifier key can still commit, settle and refund through the fallback functions, and can re-point the forwarder and pins at any time. Separate or retire it for real deployments.
- **Workflow callbacks are unauthenticated.** They are recorded as information only and capped. A REJECTED callback for the pending proof merely allows a replacement proof. Production should authenticate them, for example with a CRE Vault secret.

In the local demo setup, one machine holds every key: verifier/admin, requester, robot (mock) and CRE transmitter. They are separate roles but one operator. In a real deployment the robot key lives on the robot, the requester funds from their own wallet, and the workflow runs on a CRE DON.

Known MVP limits:

- **No timeout or cancel path.** Escrow stays locked if a proof never arrives. The adversarial suite has a pending test for this.
- **In-memory state.** The task store and the off-chain proofs live in memory. After a restart the on-chain hashes and money are intact, but the proof payloads they commit to are gone unless saved elsewhere. A task re-created after a restart gets a new `created_at`, so its spec no longer matches the on-chain anchor. In CRE mode the backend therefore refuses to re-adopt it (`409`), and that escrow can only be resolved through the admin key.
- **Single robot.** There is one registered robot.
- **Stale-proof replay window.** Replaying a stale proof is still possible within the 5-minute clock-skew window after a task id is re-created on a fresh deployment.
- **Evidence size.** Under the CRE default limits, evidence must stay below the consensus observation limit (25 kB). `--limits none` lifts this locally; very large trajectories should be summarized or stored by hash.
- **Simulated environment.** CRE runs in the official simulator (`cre workflow simulate`), not on a deployed DON. Production deployment needs `cre workflow deploy`, a public backend URL, non-empty `authorizedTriggerKeys`, and the production KeystoneForwarder.

## Project layout

```text
contracts/MachineTaskEscrow.sol      escrow + proof commitment + CRE IReceiver (onReport)
contracts/cre/IReceiver.sol          Chainlink CRE consumer interface
cre/                                 Chainlink CRE project (project.yaml: local-simulation target)
cre/machineproof-settlement/         the workflow: workflow.ts (handler), policy.ts (verification), abi.ts, tests
src/config.ts                        env config (zod), dev-key safety check
src/proof/                           schema, canonicalize (shared with the workflow), hash, signature, physical, taskSpec, verify
src/robot/                           adapter interface, mock adapter, mock proof generator
src/tasks/                           task types + TaskService (state machine; direct and CRE settlement)
src/chain/                           EscrowClient, provider, deployment record
src/cre/                             CRE trigger client, MockKeystoneForwarder artifact + deploy, simulator launcher
src/api/app.ts                       Express routes (incl. /cre/tasks/:id/evidence and /result)
src/bootstrap.ts, src/server.ts      wiring + entry point (npm run dev / dev:cre; production: npm run build && npm start)
render.yaml, tsconfig.build.json     Render Blueprint + production build (dist/)
scripts/demo-cre.ts                  npm run demo:cre (CRE sponsor demo)
scripts/demo.ts                      npm run demo (fallback demo)
scripts/demo-sim.ts                  npm run demo:sim[:cre] (real PyBullet simulator, robotics/)
robotics/                            PyBullet pick-and-place simulator + backend_bridge.py (npm run robot:sim)
scripts/cre-deploy.ts, cre-simulate.ts, deploy.ts, robot-submit.ts
examples/proof.sample.json           sample simulator proof
test/{unit,contract,backend,e2e,adversarial}/
```
