// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMachineTaskEscrowForTest {
    function fundTask(bytes32 taskId, address robot, address payee) external payable;
    function settle(bytes32 taskId) external;
    function refund(bytes32 taskId) external;
}

/// @dev TEST-ONLY helper. Acts as requester and/or payee of an escrow task and, whenever it is
///      paid, tries to re-enter `settle` and `refund` for `targetTask`. Can also refuse payments.
contract ReentrantPayee {
    IMachineTaskEscrowForTest public immutable escrow;
    bytes32 public targetTask;
    bool public rejectPayments;
    uint256 public timesPaid;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(address escrow_) {
        escrow = IMachineTaskEscrowForTest(escrow_);
    }

    function setTarget(bytes32 taskId) external {
        targetTask = taskId;
    }

    function setRejectPayments(bool reject) external {
        rejectPayments = reject;
    }

    function fund(bytes32 taskId, address robot, address payee) external payable {
        escrow.fundTask{value: msg.value}(taskId, robot, payee);
    }

    function requestRefund(bytes32 taskId) external {
        escrow.refund(taskId);
    }

    receive() external payable {
        if (rejectPayments) revert("payments rejected");
        timesPaid++;
        reentryAttempts += 2;
        (bool settled, ) = address(escrow).call(abi.encodeCall(IMachineTaskEscrowForTest.settle, (targetTask)));
        (bool refunded, ) = address(escrow).call(abi.encodeCall(IMachineTaskEscrowForTest.refund, (targetTask)));
        if (settled) reentrySuccesses++;
        if (refunded) reentrySuccesses++;
    }
}
