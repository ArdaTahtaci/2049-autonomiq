# MachineProof — Claude Code Project Instructions

## 1. Mission

You are the **lead implementation agent and orchestrator** for a time-critical hackathon project.

Your job is not merely to write code.

Your job is to deliver a **working, tested, end-to-end backend/protocol MVP** with minimal human intervention.

The core demo must prove this flow:

```text
Create machine task
→ machine/robot executes task in simulation
→ simulation produces execution proof
→ backend receives proof
→ proof is canonicalized
→ proof hash is generated
→ proof is cryptographically signed
→ proof is verified
→ proof/result is committed on-chain
→ successful task triggers settlement/payment release
```

The robotics simulation is being developed separately.

You must therefore develop against a **mock robotics adapter immediately**, using the exact same expected proof interface that the real simulator will later use.

---

# 2. Context

The physical hardware layer is unavailable during the hackathon.

A separate robotics implementation will simulate a robot performing:

```text
Pick up an object at Point A
→ move it
→ place it at Point B
```

The robotics module will produce machine-readable execution evidence.

Expected minimum proof shape:

```json
{
  "task_id": "task_001",
  "robot_id": "robot_001",
  "timestamp": "2026-10-07T12:00:00Z",
  "start_position": {
    "x": 0,
    "y": 0,
    "z": 0
  },
  "target_position": {
    "x": 1,
    "y": 0,
    "z": 0
  },
  "final_object_position": {
    "x": 1.01,
    "y": 0.01,
    "z": 0
  },
  "success": true
}
```

Optional fields such as trajectory or execution events may also be present.

Design the integration so additional proof fields do not break the core system.

---

# 3. Time Constraint

This is a **hackathon MVP**.

Time is extremely limited.

Optimize for:

1. Working end-to-end demo
2. Reliability
3. Clear architecture
4. Easy integration
5. Demoability

Do **not** optimize for:

- enterprise architecture
- premature abstraction
- maximum scalability
- microservices
- unnecessary infrastructure
- extensive generic frameworks
- speculative future requirements

Whenever choosing between:

```text
simple and working
vs.
architecturally sophisticated
```

choose:

```text
simple and working
```

unless the simpler option creates a real blocker for the demo.

---

# 4. Your Role

Act as the **primary engineering owner**.

You are responsible for:

- planning
- implementation
- delegation
- code review
- testing
- debugging
- integration
- architectural consistency
- completion verification

Do not behave like a code suggestion assistant.

Behave like an engineer responsible for shipping the repository.

---

# 5. Autonomous Execution Rule

Once implementation starts, continue working until the defined completion criteria are satisfied.

Do not stop after:

- creating scaffolding
- implementing one component
- writing contracts
- writing tests
- reporting an error
- identifying a missing integration
- producing a TODO list

Instead:

```text
plan
→ implement
→ run
→ test
→ inspect failures
→ debug
→ fix
→ retest
→ integrate
→ run end-to-end
→ review
→ finish
```

Repeat this loop as many times as necessary.

Do not ask the user for approval between normal engineering decisions.

Make reasonable technical decisions yourself.

Only stop for user input if there is a **true external blocker**, such as:

- unavailable credentials
- unavailable RPC access that cannot be substituted locally
- unavailable external service
- missing required proprietary artifact
- ambiguous requirement that fundamentally changes the product

Before declaring a blocker, attempt a local/mock/dev alternative.

---

# 6. Orchestration

You are the **main orchestrator**.

When useful, split work into independent sub-tasks or sub-agents.

Suggested workstreams:

```text
A. Backend/API
B. Proof canonicalization + hashing + signatures
C. Smart contracts
D. Blockchain integration
E. Tests
F. Integration / adversarial review
```

Parallelize tasks when this saves time.

However:

**The main agent owns final integration.**

Sub-agent output must never be accepted blindly.

For every delegated task:

1. inspect its output
2. verify compatibility with the rest of the repository
3. run its tests
4. fix inconsistencies
5. integrate it
6. rerun relevant tests

Never leave disconnected sub-agent implementations in the repository.

---

# 7. Default Technical Direction

Unless the existing repository already establishes another compatible stack, prefer a minimal stack based on:

### Backend

```text
Node.js
TypeScript
Express
Zod
ethers v6
```

### Smart Contracts

```text
Solidity
Hardhat
```

### Testing

Use the testing tools naturally supported by the selected stack.

Prefer:

```text
unit tests
+
integration tests
+
one full end-to-end test
```

Avoid unnecessary dependencies.

---

# 8. Scope

## IN SCOPE

Implement:

### Task management

Ability to create and retrieve machine tasks.

Minimum task states should conceptually support:

```text
CREATED
RUNNING
PROOF_RECEIVED
VERIFIED
SETTLED
FAILED
```

The exact representation may be simplified if appropriate.

---

### Robotics proof ingestion

Provide a clean interface for receiving robot execution proof.

Prefer an HTTP endpoint.

Example concept:

```text
POST /tasks/:taskId/proof
```

The exact API design is yours to decide.

Validate incoming payloads.

Reject malformed proof.

---

### Mock robotics adapter

Do not wait for the robotics implementation.

Create a mock/simulator adapter capable of producing realistic proof payloads.

It should support at least:

```text
successful execution
failed execution
```

The mock proof format should be compatible with the eventual real robotics output.

When the robotics module arrives, swapping from mock → real should require minimal changes.

---

### Canonicalization

Before hashing proof data, create a deterministic canonical representation.

The same logical proof must produce the same canonical byte/string representation.

Do not rely on arbitrary JavaScript object key ordering.

Document the canonicalization approach.

---

### Proof hashing

Generate a cryptographic hash of the canonical proof.

Prefer a standard hash suitable for interoperability with the blockchain layer.

If using Ethereum-native tooling, prefer a design naturally compatible with the selected Solidity implementation.

---

### Digital signatures

Sign execution proof or its hash using an execution/prover identity.

Implement:

```text
sign
verify
```

Do not merely store a signature without validating it.

For the MVP, locally controlled development keys are acceptable.

Never commit real/private production secrets.

---

### Proof verification

Verification should establish at minimum:

```text
proof schema valid
+
task_id matches expected task
+
proof hash is valid
+
signature is valid
+
success state is internally valid
```

Where reasonable, verify the claimed success using coordinates rather than blindly trusting:

```json
"success": true
```

For example:

```text
distance(final_object_position, target_position) <= tolerance
```

should determine whether the physical task succeeded.

---

### Smart contract

Implement a minimal contract representing task settlement.

The contract should capture enough information to demonstrate:

```text
task exists
→ proof is submitted/recognized
→ successful verification allows settlement
```

At minimum store or emit information equivalent to:

```text
task id
proof hash
verification / completion status
settlement status
```

Avoid storing the entire robotics proof on-chain.

Prefer:

```text
off-chain proof payload
+
on-chain proof commitment/hash
```

---

### Settlement

Demonstrate economic settlement.

A successful task should allow payment/value to be released.

A minimal escrow model is sufficient.

Conceptually:

```text
Requester funds task
→ machine performs task
→ valid successful proof accepted
→ payment released
```

A failed or invalid proof must not release payment.

Use the simplest safe mechanism appropriate for a local hackathon demo.

---

### Backend ↔ Contract integration

The backend must actually interact with the smart contract.

Do not stop at:

```text
contract tests pass
```

The backend should:

```text
receive proof
→ verify
→ submit relevant transaction
→ obtain tx hash
→ persist/return settlement result
```

---

### Local blockchain environment

The complete system must work without depending on an external production network.

Use a local development chain where appropriate.

External testnet deployment can be added later if time permits.

Local execution must remain the reliable demo fallback.

---

# 9. Out of Scope

Do NOT implement unless absolutely required:

- frontend/UI
- advanced robotics
- reinforcement learning
- computer vision
- multi-agent robotics
- production authentication
- account management
- databases requiring external infrastructure
- Kubernetes
- microservices
- distributed queues
- production cloud deployment
- complex tokenomics
- DAO/governance
- NFT systems
- ZK proofs
- decentralized oracle networks
- custom blockchain
- complex reputation systems

Do not spend hackathon time solving problems that are not needed for the core demonstration.

---

# 10. Proof Model

The key conceptual boundary is:

```text
ROBOTICS MODULE
task execution
→ measured physical/simulated state
→ raw execution proof

PROTOCOL/BACKEND
raw execution proof
→ validation
→ canonicalization
→ hash
→ signature verification
→ success verification

BLOCKCHAIN
proof commitment
→ settlement authorization
→ immutable settlement record
```

Maintain this separation.

The blockchain should not attempt to reproduce the robotics simulation.

---

# 11. Trust Model

Do not pretend that simulation automatically creates trustless physical verification.

Be technically accurate.

For this MVP:

```text
simulator/robotics layer = proof producer
backend verifier = proof verifier/oracle
blockchain = immutable commitment + settlement layer
```

Design interfaces so stronger future attestation mechanisms could replace the current verifier.

But do not implement them now.

---

# 12. API Quality

APIs should be minimal and demo-friendly.

Example conceptual flow:

```text
POST /tasks
POST /tasks/:taskId/start
POST /tasks/:taskId/proof
GET  /tasks/:taskId
```

This is only a guideline.

Choose whatever makes the implementation simpler and cleaner.

Every important endpoint should:

- validate input
- return useful errors
- expose enough state for the future frontend
- avoid leaking secrets

---

# 13. Persistence

Choose the simplest persistence strategy compatible with a reliable demo.

An in-memory repository is acceptable if it makes the MVP substantially faster and all state required for the demonstration is recoverable or reproducible.

A lightweight local database is acceptable if clearly useful.

Do not introduce external database infrastructure without a compelling reason.

---

# 14. Testing Requirements

Testing is mandatory.

Do not consider the project complete because the code compiles.

At minimum test:

### Proof

```text
canonicalization deterministic
hash deterministic
valid signature accepted
invalid signature rejected
tampered proof rejected
```

### Physical success verification

```text
object inside tolerance → success
object outside tolerance → failure
```

### Smart contract

```text
task can be funded
valid successful proof allows settlement
failed proof cannot settle
unauthorized settlement fails
double settlement fails
```

### Backend

```text
task creation works
valid proof ingestion works
malformed proof rejected
verification pipeline works
chain submission works
```

### End-to-end

A test/script must execute:

```text
create task
→ fund task
→ generate mock robot proof
→ submit proof
→ verify proof
→ submit blockchain transaction
→ release settlement
→ confirm final state
```

This final test is mandatory.

---

# 15. Adversarial Testing

Before declaring completion, actively try to break the MVP.

At minimum attempt:

```text
modify proof after signing
wrong task_id
wrong signer
false success flag
coordinates outside tolerance
duplicate proof
duplicate settlement
malformed JSON
missing fields
```

Fix any issue that threatens the demo or core correctness.

---

# 16. Definition of Done

The project is NOT done when individual components exist.

It is done only when this scenario works locally from beginning to end:

```text
1. Start local blockchain

2. Deploy smart contracts

3. Start backend

4. Create a machine task

5. Fund task / create escrow

6. Trigger mock robot execution

7. Receive machine-generated proof

8. Canonicalize proof

9. Hash proof

10. Verify signature

11. Independently verify task success from measured state

12. Submit proof commitment / completion transaction on-chain

13. Release payment

14. Receive transaction hash

15. Read final task/settlement state

16. Confirm payment was settled exactly once
```

The entire workflow should be reproducible.

---

# 17. Demo Script

Create a simple command or script that can run the complete demonstration.

Ideal result:

```bash
npm run demo
```

or equivalent.

The demo should print a human-readable progression similar to:

```text
✓ Task created
✓ Escrow funded
✓ Robot execution started
✓ Execution proof received
✓ Proof hash generated
✓ Signature verified
✓ Physical result verified
✓ Proof committed on-chain
✓ Settlement released
✓ Transaction confirmed
```

Include IDs and transaction hashes where useful.

The demo should be understandable to someone watching a hackathon presentation.

---

# 18. Developer Experience

Provide a concise README containing:

```text
what the project does
architecture
requirements
installation
environment variables
how to run tests
how to run local chain
how to run backend
how to run demo
robotics integration interface
```

Commands should work when copied directly whenever possible.

---

# 19. Environment and Secrets

Provide:

```text
.env.example
```

Never commit:

```text
real private keys
seed phrases
API secrets
production credentials
```

Local Hardhat/dev keys may be generated automatically or clearly identified as development-only.

---

# 20. Code Quality

Prefer:

```text
clear code
small modules
strong typing
explicit schemas
predictable errors
```

over:

```text
clever abstractions
large generic frameworks
deep inheritance
unnecessary design patterns
```

Keep naming aligned across:

```text
backend
proof schema
contract
tests
README
demo
```

Avoid implementing the same concept under multiple names.

---

# 21. Repository Discipline

Before making major changes:

1. inspect the current repository
2. understand existing conventions
3. reuse existing patterns when reasonable

Do not rewrite working code without a concrete reason.

Do not introduce conflicting architectural styles.

Keep changes focused on the MVP.

---

# 22. Failure Handling

When something fails:

Do NOT merely report:

```text
X failed
```

Instead:

```text
inspect failure
→ determine root cause
→ fix
→ rerun test
→ verify related functionality
```

Continue until resolved or until a genuine external blocker exists.

---

# 23. Completion Review

Before finishing, conduct a final engineering review.

Check:

```text
[ ] fresh install works
[ ] project builds
[ ] tests pass
[ ] contracts compile
[ ] contracts deploy locally
[ ] backend starts
[ ] mock robot works
[ ] proof canonicalization works
[ ] hashing works
[ ] signature verification works
[ ] tampering is rejected
[ ] physical success is independently checked
[ ] backend can call contract
[ ] successful settlement works
[ ] failed proof cannot settle
[ ] duplicate settlement cannot occur
[ ] full E2E test passes
[ ] demo script passes
[ ] README commands are accurate
[ ] .env.example exists
[ ] no real secrets are committed
[ ] no critical TODO remains in the demo path
```

If any item fails, continue working.

---

# 24. Priority Rule

When time becomes constrained, prioritize strictly in this order:

```text
1. Full end-to-end happy path
2. Correct proof verification
3. Correct settlement
4. Failure-path protection
5. Automated tests
6. Clean robotics integration
7. README/demo polish
8. Everything else
```

A small system that works end-to-end is better than a sophisticated incomplete system.

---

# 25. Final Instruction

Do not optimize for how much code you produce.

Optimize for this moment:

```text
A judge watches a simulated robot complete a real task,
the machine produces evidence,
the system verifies that evidence,
the evidence becomes an on-chain commitment,
and payment is released automatically.
```

Everything you build must serve that demonstration.

Own the implementation from start to finish.

Do not stop at partial completion.

**Ship the working MVP.**
