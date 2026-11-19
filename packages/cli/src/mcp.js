/**
 * Stdio JSON-RPC 2.0 MCP Bridge (`wirecopy-mcp mcp`).
 * Proxies tool calls (`search_morgue`, `recent_dispatches`, `get_dispatch`, `ask_copy_chief`,
 * `transmit_dispatch`, `verify_tape_seal`) to the live WireCopy HTTP `/mcp` endpoint.
 */

import readline from "node:readline";

export const DEFAULT_WIRECOPY_URL = process.env.WIRECOPY_API_URL || "https://trywirecopy.com";

export async function forwardMcpMessage(msg, { apiUrl = DEFAULT_WIRECOPY_URL, apiKey = process.env.WIRECOPY_API_KEY || "", wallet = process.env.WIRECOPY_WALLET || "", fetchImpl = fetch } = {}) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (wallet) headers["x-wallet-address"] = wallet;

  const res = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
  if (res.status === 202 || res.status === 204) return null;
  return res.json();
}

export function startStdioMcpServer(opts = {}) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    try {
      const reply = await forwardMcpMessage(msg, opts);
      if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
    } catch (e) {
      if (msg.id !== undefined) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { isError: true, content: [{ type: "text", text: `WireCopy MCP unreachable: ${e.message || e}` }] },
          }) + "\n"
        );
      }
    }
  });
}
