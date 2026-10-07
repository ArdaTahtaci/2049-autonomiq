// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "./cre/IReceiver.sol";

/// @title MachineTaskEscrow
/// @notice Escrow + proof commitment registry for machine tasks, settled by a Chainlink CRE workflow.
///
///   requester funds task (+ task spec hash)
///     ──► CRE workflow verifies the robot-signed proof and writes a report
///     ──► KeystoneForwarder ──► onReport(): commit proof hash + settle (pay payee) | refund (requester)
///
/// Two settlement authorities, same guards:
///   - CRE path (primary): `onReport` from the configured CRE forwarder commits and settles/refunds
///     atomically in one transaction.
///   - Verifier path (local fallback): `commitProof` / `settle` / `refund` called by the verifier key.
///
/// @dev Trust model:
///   - The full execution proof stays off-chain. Only keccak256(canonical proof) is committed.
///   - The robot's EIP-191 signature over that proof hash is checked on-chain on BOTH paths, so
///     neither the workflow nor the verifier can commit a proof the registered robot never signed.
///   - The task spec (target, tolerance, ...) is anchored at funding as `taskSpecHash`, so the
///     workflow can detect an off-chain store that changed the task after it was funded.
///   - The physical pass/fail verdict is computed off-chain (by the CRE workflow or the verifier)
///     and attested here. Each task can be committed once and paid out at most once.
contract MachineTaskEscrow is IReceiver {
    enum TaskStatus {
        None,
        Funded,
        Verified,
        Failed,
        Settled,
        Refunded
    }

    struct Task {
        address requester;
        address robot; // signing identity of the machine that must sign the proof
        address payee; // receives the escrowed payment on settlement
        uint256 amount;
        bytes32 proofHash;
        TaskStatus status;
    }

    address public immutable verifier;
    /// @notice Chainlink forwarder allowed to deliver CRE workflow reports (zero = CRE path disabled).
    address public creForwarder;
    /// @notice Optional pins on the report metadata (zero = not checked). Production hardening:
    /// with the KeystoneForwarder (DON-signature verified) these restrict settlement to one
    /// specific workflow of one owner. The simulator's MockKeystoneForwarder does not populate them.
    bytes32 public expectedWorkflowId;
    address public expectedWorkflowOwner;

    mapping(bytes32 => Task) private _tasks;
    mapping(bytes32 => bool) public proofHashUsed;
    /// @notice keccak256 of the canonical task spec, anchored when the task was funded (optional).
    mapping(bytes32 => bytes32) public taskSpecHash;

    event TaskFunded(bytes32 indexed taskId, address indexed requester, address robot, address payee, uint256 amount);
    event TaskSpecAnchored(bytes32 indexed taskId, bytes32 specHash);
    event ProofCommitted(bytes32 indexed taskId, bytes32 indexed proofHash, bool passed);
    event TaskSettled(bytes32 indexed taskId, address indexed payee, uint256 amount);
    event TaskRefunded(bytes32 indexed taskId, address indexed requester, uint256 amount);
    event CreForwarderUpdated(address indexed forwarder);
    event CreWorkflowPinned(bytes32 workflowId, address workflowOwner);
    /// @notice A CRE workflow report settled this task (workflowId/owner come from the report metadata).
    event CreReportProcessed(
        bytes32 indexed taskId, bytes32 indexed workflowId, address workflowOwner, bytes32 proofHash, bool passed
    );

    error NotVerifier();
    error NotAuthorized();
    error NotCreForwarder();
    error UnexpectedWorkflow(bytes32 workflowId, address workflowOwner);
    error InvalidAddress();
    error ZeroAmount();
    error TaskAlreadyExists(bytes32 taskId);
    error InvalidStatus(bytes32 taskId, TaskStatus current, TaskStatus expected);
    error ProofAlreadyUsed(bytes32 proofHash);
    error InvalidRobotSignature(address recovered, address expected);
    error TransferFailed();

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert NotVerifier();
        _;
    }

    constructor(address verifier_) {
        if (verifier_ == address(0)) revert InvalidAddress();
        verifier = verifier_;
    }

    // ─── Funding ──────────────────────────────────────────────────────────────────────────────

    /// @notice Requester creates a task and locks the payment in escrow.
    function fundTask(bytes32 taskId, address robot, address payee) external payable {
        _fund(taskId, robot, payee);
    }

    /// @notice Like fundTask, and anchors the task spec hash so settlement can check it.
    function fundTaskWithSpec(bytes32 taskId, address robot, address payee, bytes32 specHash) external payable {
        _fund(taskId, robot, payee);
        taskSpecHash[taskId] = specHash;
        emit TaskSpecAnchored(taskId, specHash);
    }

    // ─── CRE path (primary) ───────────────────────────────────────────────────────────────────

    /// @notice Points the escrow at the Chainlink forwarder that delivers CRE workflow reports
    /// (KeystoneForwarder in production, MockKeystoneForwarder for `cre workflow simulate`).
    function setCreForwarder(address forwarder) external onlyVerifier {
        creForwarder = forwarder;
        emit CreForwarderUpdated(forwarder);
    }

    /// @notice Pins which workflow (id and/or owner) may settle through the forwarder; zero disables a check.
    function setCreWorkflow(bytes32 workflowId, address workflowOwner) external onlyVerifier {
        expectedWorkflowId = workflowId;
        expectedWorkflowOwner = workflowOwner;
        emit CreWorkflowPinned(workflowId, workflowOwner);
    }

    /// @notice Receives a CRE workflow report: commits the proof hash, then settles or refunds.
    /// @param report abi.encode(bytes32 taskId, bytes32 proofHash, bool passed, bytes robotSignature)
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != creForwarder || msg.sender == address(0)) revert NotCreForwarder();
        (bytes32 workflowId, address workflowOwner) = _decodeMetadata(metadata);
        if (
            (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) ||
            (expectedWorkflowOwner != address(0) && workflowOwner != expectedWorkflowOwner)
        ) revert UnexpectedWorkflow(workflowId, workflowOwner);

        (bytes32 taskId, bytes32 proofHash, bool passed, bytes memory robotSignature) =
            abi.decode(report, (bytes32, bytes32, bool, bytes));

        _commitProof(taskId, proofHash, passed, robotSignature);
        if (passed) {
            _settle(taskId);
        } else {
            _refund(taskId);
        }

        emit CreReportProcessed(taskId, workflowId, workflowOwner, proofHash, passed);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ─── Verifier path (local fallback) ───────────────────────────────────────────────────────

    /// @notice Verifier commits the proof hash and its off-chain verification verdict.
    /// @param robotSignature EIP-191 (personal_sign) signature by the task's robot over `proofHash`.
    function commitProof(bytes32 taskId, bytes32 proofHash, bool passed, bytes calldata robotSignature)
        external
        onlyVerifier
    {
        _commitProof(taskId, proofHash, passed, robotSignature);
    }

    /// @notice Releases the escrowed payment to the payee. Only possible once, after a passing proof.
    function settle(bytes32 taskId) external onlyVerifier {
        _settle(taskId);
    }

    /// @notice Returns the escrow to the requester after a failing proof was committed.
    function refund(bytes32 taskId) external {
        if (msg.sender != verifier && msg.sender != _tasks[taskId].requester) revert NotAuthorized();
        _refund(taskId);
    }

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    // ─── Internal state machine (shared by both paths) ────────────────────────────────────────

    function _fund(bytes32 taskId, address robot, address payee) private {
        if (msg.value == 0) revert ZeroAmount();
        if (robot == address(0) || payee == address(0)) revert InvalidAddress();
        if (_tasks[taskId].status != TaskStatus.None) revert TaskAlreadyExists(taskId);

        _tasks[taskId] = Task({
            requester: msg.sender,
            robot: robot,
            payee: payee,
            amount: msg.value,
            proofHash: bytes32(0),
            status: TaskStatus.Funded
        });

        emit TaskFunded(taskId, msg.sender, robot, payee, msg.value);
    }

    function _commitProof(bytes32 taskId, bytes32 proofHash, bool passed, bytes memory robotSignature) private {
        Task storage task = _tasks[taskId];
        _requireStatus(taskId, task.status, TaskStatus.Funded);
        if (proofHashUsed[proofHash]) revert ProofAlreadyUsed(proofHash);

        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(proofHash), robotSignature);
        if (recovered != task.robot) revert InvalidRobotSignature(recovered, task.robot);

        proofHashUsed[proofHash] = true;
        task.proofHash = proofHash;
        task.status = passed ? TaskStatus.Verified : TaskStatus.Failed;

        emit ProofCommitted(taskId, proofHash, passed);
    }

    function _settle(bytes32 taskId) private {
        Task storage task = _tasks[taskId];
        _requireStatus(taskId, task.status, TaskStatus.Verified);

        task.status = TaskStatus.Settled; // effects before interaction
        uint256 amount = task.amount;
        address payee = task.payee;

        (bool ok, ) = payee.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit TaskSettled(taskId, payee, amount);
    }

    function _refund(bytes32 taskId) private {
        Task storage task = _tasks[taskId];
        _requireStatus(taskId, task.status, TaskStatus.Failed);

        task.status = TaskStatus.Refunded;
        uint256 amount = task.amount;
        address requester = task.requester;

        (bool ok, ) = requester.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit TaskRefunded(taskId, requester, amount);
    }

    function _requireStatus(bytes32 taskId, TaskStatus current, TaskStatus expected) private pure {
        if (current != expected) revert InvalidStatus(taskId, current, expected);
    }

    /// @dev metadata = workflow_cid (32) | workflow_name (10) | workflow_owner (20) | report_id (2)
    function _decodeMetadata(bytes calldata metadata) private pure returns (bytes32 workflowId, address owner) {
        if (metadata.length < 62) return (bytes32(0), address(0));
        workflowId = bytes32(metadata[0:32]);
        owner = address(bytes20(metadata[42:62]));
    }
}
