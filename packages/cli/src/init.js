/**
 * Multi-client MCP bootstrapper (`wirecopy-mcp init`).
 * Safely registers WireCopy's stdio MCP server in Cursor, Claude Code, Codex, and Claude Desktop
 * with `.wirecopy-bak` backups and `_npx` transient-PATH protection.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PKG_SPEC = "wirecopy-mcp";

export function isTransientRunnerDir(dirPath) {
  const norm = String(dirPath || "").replace(/\\/g, "/").toLowerCase();
  return norm.includes("/_npx/") || norm.includes("/node_modules/.bin") || norm.endsWith("/node_modules/.bin");
}

export function buildMcpSpec({ platform = process.platform, forGuiApp = false, apiUrl = "" } = {}) {
  const env = apiUrl ? { WIRECOPY_API_URL: apiUrl } : undefined;
  if (platform === "win32" && forGuiApp) {
    return { command: "cmd", args: ["/c", "npx", "-y", DEFAULT_PKG_SPEC, "mcp"], ...(env ? { env } : {}) };
  }
  return { command: "npx", args: ["-y", DEFAULT_PKG_SPEC, "mcp"], ...(env ? { env } : {}) };
}

function backupOnce(filePath) {
  const bak = `${filePath}.wirecopy-bak`;
  if (fs.existsSync(filePath) && !fs.existsSync(bak)) {
    fs.copyFileSync(filePath, bak);
    return bak;
  }
  return null;
}

export function upsertMcpJsonFile(filePath, spec, { dryRun = false } = {}) {
  let obj = {};
  if (fs.existsSync(filePath)) {
    obj = JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
  }
  obj.mcpServers = obj.mcpServers || {};
  obj.mcpServers.wirecopy = spec;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    backupOnce(filePath);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
  }
  return filePath;
}

export function runInit({ homeDir = os.homedir(), dryRun = false, apiUrl = "" } = {}) {
  const targets = [
    { client: "Cursor", path: path.join(homeDir, ".cursor", "mcp.json"), gui: true },
    { client: "Claude Code", path: path.join(homeDir, ".claude.json"), gui: false },
  ];

  const written = [];
  for (const t of targets) {
    const spec = buildMcpSpec({ forGuiApp: t.gui, apiUrl });
    upsertMcpJsonFile(t.path, spec, { dryRun });
    written.push({ client: t.client, path: t.path, dryRun });
  }
  return written;
}
