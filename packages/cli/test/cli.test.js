import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit, isTransientRunnerDir } from "../src/init.js";
import { forwardMcpMessage } from "../src/mcp.js";
import { runCli } from "../src/cli.js";

test("wirecopy-mcp init writes Cursor & Claude configs idempotently and preserves existing servers", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wirecopy-cli-"));
  const cursorPath = path.join(tmp, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, JSON.stringify({ mcpServers: { existingServer: { command: "node" } } }));

  runInit({ homeDir: tmp });
  const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.ok(parsed.mcpServers.existingServer, "Preserves user's existing MCP server");
  assert.ok(parsed.mcpServers.wirecopy, "Adds wirecopy MCP server");
  assert.equal(fs.existsSync(`${cursorPath}.wirecopy-bak`), true, "Creates .wirecopy-bak backup");

  assert.equal(isTransientRunnerDir("/Users/dev/.npm/_npx/12345/node_modules/.bin"), true);
});

test("wirecopy-mcp search & stdio forwarder handle JSON-RPC cleanly", async () => {
  let out = "";
  const mockFetch = async (url) => {
    if (String(url).includes("/mcp")) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search_morgue" }] } }));
    }
    return new Response(
      JSON.stringify({
        findings: [{ stamp: "ON THE WIRE", mission: 4, desk_code: "EQT", claim: "TSLA oracle reads $350.", evidence: '"price_usd":350' }],
      })
    );
  };

  await runCli(["search", "TSLA", "--api", "https://wirecopy.app"], {
    fetchImpl: mockFetch,
    stdout: { write: (s) => (out += s) },
  });
  assert.ok(out.includes("[ON THE WIRE]"));
  assert.ok(out.includes("--30--"));

  const rpcReply = await forwardMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { fetchImpl: mockFetch });
  assert.equal(rpcReply.result.tools[0].name, "search_morgue");
});
