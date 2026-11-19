import test from "node:test";
import assert from "node:assert/strict";
import worker, { tick } from "../src/index.js";
import { sqliteD1 } from "../d1-sqlite.mjs";

function createTestEnv(overrides = {}) {
  const db = sqliteD1(":memory:");
  let openAiTurn = 0;

  const mockFetch = async (url, init = {}) => {
    const u = String(url);

    // Mock OpenAI /v1/responses multi-turn tool calling loop!
    if (u === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(init.body || "{}");
      openAiTurn += 1;

      // Copy Chief chat path (no file_finding tool)
      const hasFileFinding = (body.tools || []).some((t) => t.name === "file_finding");
      if (!hasFileFinding) {
        return new Response(
          JSON.stringify({
            id: "resp_chat_1",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "COPY DESK — Official TSLA Chainlink feed reads $352.40 on Robinhood Chain.\n--30--",
                  },
                ],
              },
            ],
            usage: { input_tokens: 120, output_tokens: 30 },
          })
        );
      }

      if (openAiTurn === 1) {
        return new Response(
          JSON.stringify({
            id: "resp_turn_1",
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "chain_protocols",
                arguments: JSON.stringify({ why: "Read live Robinhood Chain TVL leaders", limit: 5 }),
              },
            ],
            usage: { input_tokens: 200, output_tokens: 40 },
          })
        );
      }
      if (openAiTurn === 2) {
        // File ONE exact verified finding AND ONE hallucinated finding so we prove both ON THE WIRE and SPIKED!
        return new Response(
          JSON.stringify({
            id: "resp_turn_2",
            output: [
              {
                type: "function_call",
                call_id: "call_2",
                name: "file_finding",
                arguments: JSON.stringify({
                  why: "File verified Morpho TVL figure",
                  claim: "Morpho holds $14,820,000 TVL on Robinhood Chain.",
                  evidence: '"chain_tvl_usd":14820000',
                  step: 2,
                  entities: ["morpho", "tvl"],
                }),
              },
              {
                type: "function_call",
                call_id: "call_3",
                name: "file_finding",
                arguments: JSON.stringify({
                  why: "Attempt hallucinated TVL figure",
                  claim: "FakeProtocol holds $999,000,000 TVL.",
                  evidence: '"chain_tvl_usd":999000000',
                  step: 2,
                  entities: ["fakeprotocol"],
                }),
              },
            ],
            usage: { input_tokens: 300, output_tokens: 80 },
          })
        );
      }
      return new Response(
        JSON.stringify({
          id: "resp_turn_3",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "ROBINHOOD CHAIN (DFI DESK) — Morpho leads Robinhood Chain DeFi TVL at $14,820,000.\n- Total chain TVL across counted protocols stands at $14,820,000.\n--30--",
                },
              ],
            },
          ],
          usage: { input_tokens: 350, output_tokens: 55 },
        })
      );
    }

    if (u.includes("api.llama.fi/protocols")) {
      return new Response(
        JSON.stringify([
          {
            name: "Morpho",
            slug: "morpho",
            category: "Lending",
            tvl: 2500000000,
            chainTvls: { "Robinhood Chain": 14820000 },
            change_1d: 2.4,
            change_7d: 11.2,
          },
        ])
      );
    }

    // Mock Robinhood Chain RPC `eth_call` for 0-wallet `balanceOf` check (6,000,000 $WIRECOPY -> Bureau Chief!)
    if (u.includes("mock-rpc")) {
      const rpcBody = JSON.parse(init.body || "{}");
      if (rpcBody.method === "eth_call") {
        const sixMillion = "0x" + (6_000_000n * 10n ** 18n).toString(16).padStart(64, "0");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: sixMillion }));
      }
    }

    return new Response(JSON.stringify({}), { status: 200 });
  };

  return {
    DB: db,
    OPENAI_API_KEY: "sk-test-openai-live-loop",
    PROVIDER: "openai",
    MODEL: "gpt-5.4",
    RH_RPC_URL: "https://mock-rpc.local",
    TOKEN_ADDRESS: "0x9999999999999999999999999999999999999999",
    ADMIN_KEY: "secret-admin",
    __fetchImpl: mockFetch,
    ...overrides,
  };
}

test("OpenAI multi-turn mission loop streams steps, stamps ON THE WIRE vs SPIKED, seals Merkle tape, and serves MCP", async () => {
  const env = createTestEnv();

  // 1. Queue a public dispatch with 0 wallet signatures
  const postRes = await worker.fetch(
    new Request("https://wirecopy.app/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desk: "defi", question: "Which protocols lead Robinhood Chain DeFi TVL?" }),
    }),
    env,
    {}
  );
  assert.equal(postRes.status, 201);
  const queued = await postRes.json();
  assert.equal(queued.mission.agent, "defi");

  // 2. Run the queue tick (executes 3 OpenAI turns + live tool + 2 file_finding checks)
  const ranId = await tick(env, { force: true });
  assert.equal(ranId, queued.mission.id);

  // 3. Read completed mission & verify live step stream
  const detailRes = await worker.fetch(new Request(`https://wirecopy.app/v1/missions/${ranId}`), env, {});
  const detail = await detailRes.json();
  assert.equal(detail.mission.status, "done");
  assert.ok(detail.mission.report.endsWith("--30--"));
  assert.equal(detail.mission.findings, 2);
  assert.equal(detail.mission.verified, 1);

  // 4. Check Morgue: 1 ON THE WIRE (`verified`) + 1 SPIKED (`unverified`)
  const memRes = await worker.fetch(new Request("https://wirecopy.app/v1/memory"), env, {});
  const mem = await memRes.json();
  assert.equal(mem.findings.length, 2);
  const stamps = mem.findings.map((f) => f.stamp).sort();
  assert.deepEqual(stamps, ["ON THE WIRE", "SPIKED"]);

  // 5. Check hourly Merkle tape seal + proof verification
  const sealsRes = await worker.fetch(new Request("https://wirecopy.app/v1/seals"), env, {});
  const seals = await sealsRes.json();
  assert.equal(seals.seals.length, 1);
  assert.equal(seals.seals[0].wiredCount, 1);
  const leaf0 = seals.seals[0].leaves[0];
  const verifyRes = await worker.fetch(
    new Request("https://wirecopy.app/v1/verify-leaf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        record: leaf0.record,
        proof: leaf0.proof,
        expectedRoot: seals.seals[0].merkleRoot,
      }),
    }),
    env,
    {}
  );
  const verifiedProof = await verifyRes.json();
  assert.equal(verifiedProof.valid, true);

  // 6. Test 0-wallet read-only Bureau Chief balance check + MCP key + JSON-RPC `/mcp`
  const keyRes = await worker.fetch(
    new Request("https://wirecopy.app/v1/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "cursor-desk" }),
    }),
    env,
    {}
  );
  assert.equal(keyRes.status, 201);
  const issued = await keyRes.json();
  assert.equal(issued.tier, "chief");
  assert.equal(issued.daily_api_limit, 50000);
  assert.match(issued.key, /^wcp_[0-9a-f]{40}$/);

  const mcpRes = await worker.fetch(
    new Request("https://wirecopy.app/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${issued.key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "search_morgue", arguments: { query: "Morpho" } },
      }),
    }),
    env,
    {}
  );
  const mcpJson = await mcpRes.json();
  assert.ok(mcpJson.result.content[0].text.includes("[ON THE WIRE] Morpho holds $14,820,000"));

  // 7. Copy Chief chat
  const chatRes = await worker.fetch(
    new Request("https://wirecopy.app/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What does TSLA oracle read?" }] }),
    }),
    env,
    {}
  );
  const chatJson = await chatRes.json();
  assert.ok(chatJson.reply.includes("$352.40"));
});
