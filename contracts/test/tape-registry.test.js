import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "../../packages/core/src/keccak.js";
import { buildMerkleTree, verifyMerkleProof } from "../../packages/core/src/merkle.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_JSON = path.resolve(HERE, "..", "src", "build", "WireTapeRegistry.json");

test("WireTapeRegistry compiles cleanly with zero payable/custody/approval functions", () => {
  assert.equal(fs.existsSync(BUILD_JSON), true, "WireTapeRegistry.json artifact exists");
  const artifact = JSON.parse(fs.readFileSync(BUILD_JSON, "utf8"));
  const fns = artifact.abi.filter((x) => x.type === "function");

  for (const fn of fns) {
    assert.notEqual(fn.stateMutability, "payable", `Function ${fn.name} must not accept ETH`);
    assert.equal(/approve|transferFrom|withdraw/i.test(fn.name), false, `Forbidden custody function ${fn.name}`);
  }

  const names = new Set(fns.map((f) => f.name));
  for (const req of ["sealTape", "getTapeSeal", "verifyFindingLeaf", "bindToken", "tierOf", "latestEpoch"]) {
    assert.equal(names.has(req), true, `Missing required contract method ${req}`);
  }

  // Selector sanity checks for worker ABI encoding
  assert.equal(keccak256("balanceOf(address)").slice(0, 10), "0x70a08231");
  assert.equal(keccak256("sealTape(uint64,bytes32,uint32,uint32)").length, 66);
});

test("Sorted-pair Merkle proofs match WireTapeRegistry.verifyFindingLeaf rules and reject tampered copy", () => {
  const leaves = [
    {
      epochHour: 1795082400,
      chainId: 4663,
      findingId: 101,
      dispatchId: 12,
      desk: "equities",
      claim: "TSLA Robinhood stock token trades at $342.18 vs Chainlink oracle $341.95 (+0.067% gap).",
      evidence: "\"token_vs_oracle_pct\":0.067",
      sourceUrl: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
      status: "verified",
    },
    {
      epochHour: 1795082400,
      chainId: 4663,
      findingId: 102,
      dispatchId: 12,
      desk: "curves",
      claim: "PONSVISION curve reached 100% graduation with $42,700 24h volume.",
      evidence: "\"curve_progress_pct\":100",
      sourceUrl: "https://ponsfamily.com/api/launches",
      status: "verified",
    },
    {
      epochHour: 1795082400,
      chainId: 4663,
      findingId: 103,
      dispatchId: 13,
      desk: "defi",
      claim: "Morpho holds $14,820,000 TVL on Robinhood Chain.",
      evidence: "\"chain_tvl_usd\":14820000",
      sourceUrl: "https://api.llama.fi/protocols",
      status: "verified",
    },
  ];

  const tree = buildMerkleTree(leaves);
  assert.match(tree.root, /^0x[0-9a-f]{64}$/);

  const proof0 = tree.getProof(0);
  const ok = verifyMerkleProof({ record: leaves[0], proof: proof0, expectedRoot: tree.root });
  assert.equal(ok.valid, true);

  // Mutate a single digit in claim -> proof MUST fail
  const tampered = { ...leaves[0], claim: leaves[0].claim.replace("$342.18", "$399.18") };
  const bad = verifyMerkleProof({ record: tampered, proof: proof0, expectedRoot: tree.root });
  assert.equal(bad.valid, false);
});
