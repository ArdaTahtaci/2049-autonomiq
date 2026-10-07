import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    // `npm run chain` starts this network on http://127.0.0.1:8545 (chainId 31337).
    localhost: { url: process.env.RPC_URL ?? "http://127.0.0.1:8545" },
  },
  typechain: { outDir: "typechain-types", target: "ethers-v6" },
  mocha: { timeout: 60_000 },
};

export default config;
