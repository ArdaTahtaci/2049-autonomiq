// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title MachineTaskEscrow
/// @notice Escrow + proof commitment registry for machine tasks.
///
///   requester funds task ──► verifier commits robot-signed proof hash ──► settle (pay payee)
///                                                        └─ failed ──► refund (to requester)
///
/// @dev Trust model (MVP):
///   - The full execution proof stays off-chain. Only keccak256(canonical proof) is committed.
///   - The robot's EIP-191 signature over that proof hash is checked on-chain, so the verifier
///     cannot commit a proof the registered robot never signed.
///   - The physical pass/fail verdict is computed off-chain by the verifier (backend oracle)
///     and attested here. Only the verifier may commit proofs and release settlement.
contract MachineTaskEscrow {
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

    mapping(bytes32 => Task) private _tasks;
    mapping(bytes32 => bool) public proofHashUsed;

    event TaskFunded(bytes32 indexed taskId, address indexed requester, address robot, address payee, uint256 amount);
    event ProofCommitted(bytes32 indexed taskId, bytes32 indexed proofHash, bool passed);
    event TaskSettled(bytes32 indexed taskId, address indexed payee, uint256 amount);
    event TaskRefunded(bytes32 indexed taskId, address indexed requester, uint256 amount);

    error NotVerifier();
    error NotAuthorized();
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

    /// @notice Requester creates a task and locks the payment in escrow.
    function fundTask(bytes32 taskId, address robot, address payee) external payable {
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

    /// @notice Verifier commits the proof hash and its off-chain verification verdict.
    /// @param robotSignature EIP-191 (personal_sign) signature by the task's robot over `proofHash`.
    function commitProof(bytes32 taskId, bytes32 proofHash, bool passed, bytes calldata robotSignature)
        external
        onlyVerifier
    {
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

    /// @notice Releases the escrowed payment to the payee. Only possible once, after a passing proof.
    function settle(bytes32 taskId) external onlyVerifier {
        Task storage task = _tasks[taskId];
        _requireStatus(taskId, task.status, TaskStatus.Verified);

        task.status = TaskStatus.Settled; // effects before interaction
        uint256 amount = task.amount;
        address payee = task.payee;

        (bool ok, ) = payee.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit TaskSettled(taskId, payee, amount);
    }

    /// @notice Returns the escrow to the requester after a failing proof was committed.
    function refund(bytes32 taskId) external {
        Task storage task = _tasks[taskId];
        if (msg.sender != verifier && msg.sender != task.requester) revert NotAuthorized();
        _requireStatus(taskId, task.status, TaskStatus.Failed);

        task.status = TaskStatus.Refunded;
        uint256 amount = task.amount;
        address requester = task.requester;

        (bool ok, ) = requester.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit TaskRefunded(taskId, requester, amount);
    }

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function _requireStatus(bytes32 taskId, TaskStatus current, TaskStatus expected) private pure {
        if (current != expected) revert InvalidStatus(taskId, current, expected);
    }
}
