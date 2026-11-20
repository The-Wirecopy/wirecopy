import { runInit } from "./init.js";
import { DEFAULT_WIRECOPY_URL, startStdioMcpServer } from "./mcp.js";

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--api") flags.api = args[++i];
    else if (a === "--desk") flags.desk = args[++i];
    else if (a === "--wallet") flags.wallet = args[++i];
    else flags._.push(a);
  }
  return flags;
}

export async function runCli(argv, { fetchImpl = fetch, stdout = process.stdout, homeDir } = {}) {
  const flags = parseFlags(argv);
  const cmd = flags._[0] || "help";
  const apiUrl = (flags.api || process.env.WIRECOPY_API_URL || DEFAULT_WIRECOPY_URL).replace(/\/+$/, "");

  if (cmd === "mcp") {
    startStdioMcpServer({ apiUrl, wallet: flags.wallet, fetchImpl });
    return;
  }

  if (cmd === "init") {
    const res = runInit({ homeDir, dryRun: Boolean(flags.dryRun), apiUrl: flags.api || "" });
    for (const r of res) {
      stdout.write(`[OK] ${r.dryRun ? "(dry-run) " : ""}Wired ${r.client} -> ${r.path}\n`);
    }
    stdout.write("--30--\n");
    return;
  }

  if (cmd === "search") {
    const q = flags._.slice(1).join(" ");
    const r = await fetchImpl(`${apiUrl}/v1/memory?q=${encodeURIComponent(q)}&limit=12`).then((x) => x.json());
    for (const f of r.findings || []) {
      stdout.write(`[${f.stamp}] (#${f.mission} ${f.desk_code}) ${f.claim}\n  quoted: ${f.evidence}\n`);
    }
    if (!(r.findings || []).length) stdout.write("No matching clippings in the Morgue.\n");
    stdout.write("--30--\n");
    return;
  }

  if (cmd === "xray" || cmd === "scan") {
    const q = flags._.slice(1).join(" ").trim();
    if (!q) throw new Error('Usage: wirecopy-mcp xray <0x_or_ticker>');
    const xr = await fetchImpl(`${apiUrl}/v1/xray?q=${encodeURIComponent(q)}`).then((x) => x.json());
    if (xr.error) throw new Error(xr.error);
    stdout.write(`[${xr.badge}] ${xr.title} (${xr.address || xr.query}) — ${xr.elapsed_ms}ms\n`);
    for (const m of xr.metrics || []) stdout.write(`  ${m.label.padEnd(18)} : ${m.value}\n`);
    for (const f of xr.flags || []) stdout.write(`  [${f.severity.toUpperCase()}] ${f.text}\n`);
    stdout.write("--30--\n");
    return;
  }

  if (cmd === "dispatch" || cmd === "ask") {
    const question = flags._.slice(1).join(" ").trim();
    if (!question) throw new Error('Usage: wirecopy-mcp dispatch "TSLA"');
    const headers = { "content-type": "application/json" };
    if (flags.wallet) headers["x-wallet-address"] = flags.wallet;
    const r = await fetchImpl(`${apiUrl}/v1/missions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ desk: flags.desk, question }),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    stdout.write(`Transmitted Bulletin #${r.mission.id} to ${r.mission.desk_name} (${r.mission.status})\n--30--\n`);
    return;
  }

  stdout.write(`WIRECOPY CLI & MCP (Robinhood Chain 4663)
Commands:
  npx wirecopy-mcp init [--dry-run]        Register WireCopy MCP in Cursor & Claude Code
  npx wirecopy-mcp search <query>          Search verified ON THE WIRE findings in the Morgue
  npx wirecopy-mcp dispatch "<question>"   Transmit a live AI research dispatch
  npx wirecopy-mcp mcp                     Start stdio JSON-RPC 2.0 MCP server
--30--
`);
}
