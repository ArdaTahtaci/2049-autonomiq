// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Chainlink CRE consumer interface: the KeystoneForwarder (MockKeystoneForwarder in
/// `cre workflow simulate`) calls onReport with the DON-signed report a workflow produced via
/// `runtime.report()` + `evmClient.writeReport()`. Mirrors chainlink-evm contracts/cre IReceiver.
interface IReceiver is IERC165 {
    /// @param metadata workflow_cid (32) | workflow_name (10) | workflow_owner (20) | report_id (2)
    /// @param report   the workflow's ABI-encoded payload
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
