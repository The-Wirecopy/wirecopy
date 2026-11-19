import test from "node:test";
import assert from "node:assert/strict";
import {
  keccak256,
  checkEvidence,
  burnedInReceipt,
  inferDeskAndQuestion,
  runDeterministicDispatch,
  ERC20_TRANSFER_TOPIC,
} from "../src/index.js";

test("keccak256 matches canonical Ethereum test vectors", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("Transfer(address,address,uint256)"), ERC20_TRANSFER_TOPIC);
});

test("checkEvidence stamps ON THE WIRE when exact figure exists and SPIKED when hallucinated", () => {
  const raw = JSON.stringify({
    source: "https://api.llama.fi/protocols",
    tvl_sum_usd: 28450120,
    protocols: [{ name: "Morpho", chain_tvl_usd: 14820000 }],
  });

  const good = checkEvidence(raw, '"chain_tvl_usd": 14820000');
  assert.equal(good.ok, true);
  assert.equal(good.stamp, "ON THE WIRE");

  const hallucinated = checkEvidence(raw, '"chain_tvl_usd": 99999999');
  assert.equal(hallucinated.ok, false);
  assert.equal(hallucinated.stamp, "SPIKED");
});

test("burnedInReceipt sums transfers to 0x...dEaD and ignores ordinary transfers", () => {
  const token = "0x1111111111111111111111111111111111111111";
  const sender = "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dead = "0x000000000000000000000000000000000000000000000000000000000000dead";
  const friend = "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const fiftyK = "0x" + (50000n * 10n ** 18n).toString(16).padStart(64, "0");

  const receipt = {
    logs: [
      { address: token, topics: [ERC20_TRANSFER_TOPIC, sender, friend], data: fiftyK },
      { address: token, topics: [ERC20_TRANSFER_TOPIC, sender, dead], data: fiftyK },
    ],
  };

  const out = burnedInReceipt(receipt, token);
  assert.equal(out.raw, 50000n * 10n ** 18n);
  assert.equal(out.sender, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("inferDeskAndQuestion routes stock tickers, 0x addresses, and risk queries cleanly", () => {
  assert.equal(inferDeskAndQuestion("TSLA").desk, "equities");
  assert.equal(inferDeskAndQuestion("0xcd5c01ea857df6253323a1bde87cd1d3a442a8f7").desk, "curves");
  assert.equal(inferDeskAndQuestion("Are there fake NVDA clones on Pons?").desk, "risk");
});

test("runDeterministicDispatch logs steps, verifies quotes, and prints --30-- bulletin", async () => {
  const steps = [];
  const findings = [];
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("rhj/assets")) {
      return new Response(
        JSON.stringify({
          assets: [
            {
              status: "ASSET_STATUS_ACTIVE",
              tokenSymbol: "TSLA",
              tokenName: "Tesla • Robinhood Token",
              currentMultiplier: 1,
              deployments: [{ chainId: 4663, contractAddress: "0x2222222222222222222222222222222222222222" }],
            },
          ],
        })
      );
    }
    if (u.includes("feeds-robinhood-mainnet")) {
      return new Response(
        JSON.stringify([{ name: "Robinhood TSLA / USD", proxyAddress: "0x3333333333333333333333333333333333333333", decimals: 8 }])
      );
    }
    if (u.includes("coins.llama.fi/prices/current")) {
      return new Response(
        JSON.stringify({
          coins: { "robinhood:0x2222222222222222222222222222222222222222": { symbol: "TSLA", price: 350.25 } },
        })
      );
    }
    if (u.includes("coins.llama.fi/percentage")) {
      return new Response(JSON.stringify({ coins: {} }));
    }
    // RPC latestRoundData() -> answer = 35000000000 ($350.00), updatedAt = 1795080000
    const roundId = "0".repeat(64);
    const ans = (35000000000n).toString(16).padStart(64, "0");
    const started = "0".repeat(64);
    const updated = (1795080000n).toString(16).padStart(64, "0");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + roundId + ans + started + updated + roundId }));
  };

  const res = await runDeterministicDispatch(
    { fetchImpl: mockFetch, rpcUrl: "https://mock.rpc" },
    {
      desk: "equities",
      question: "Check live TSLA stock token vs Chainlink oracle",
      logStep: async (kind, tool, body) => {
        steps.push({ n: steps.length + 1, kind, tool, body });
        return steps.length;
      },
      saveFinding: async (f) => findings.push(f),
    }
  );

  assert.ok(res.report.endsWith("--30--"));
  assert.equal(findings.length >= 1, true);
  assert.equal(findings[0].status, "verified");
});
