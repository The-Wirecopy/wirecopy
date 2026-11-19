#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[wirecopy-mcp] ${err.message || err}\n`);
  process.exit(1);
});
