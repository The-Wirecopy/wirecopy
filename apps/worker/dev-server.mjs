#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { tick } from "./src/index.js";
import { sqliteD1 } from "./d1-sqlite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(HERE, "..", "site");
const PORT = Number(process.env.PORT || 8788);
const DB_PATH = path.join(HERE, ".local-wirecopy.sqlite");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const db = sqliteD1(DB_PATH);
const env = {
  DB: db,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  PROVIDER: process.env.PROVIDER || "openai",
  MODEL: process.env.MODEL || "gpt-5.4",
  RH_RPC_URL: process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  ADMIN_KEY: process.env.ADMIN_KEY || "dev-admin",
  TOKEN_ADDRESS: process.env.TOKEN_ADDRESS || "",
  TAPE_REGISTRY_ADDRESS: process.env.TAPE_REGISTRY_ADDRESS || "",
  ASSETS: {
    async fetch(req) {
      const u = new URL(req.url);
      let rel = decodeURIComponent(u.pathname);
      if (rel === "/") rel = "/index.html";
      const filePath = path.resolve(SITE_DIR, "." + rel);
      if (!filePath.startsWith(SITE_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        const indexFallback = path.join(SITE_DIR, "index.html");
        if (fs.existsSync(indexFallback)) {
          return new Response(fs.readFileSync(indexFallback), { headers: { "content-type": MIME[".html"] } });
        }
        return new Response("Not found", { status: 404 });
      }
      const ext = path.extname(filePath).toLowerCase();
      return new Response(fs.readFileSync(filePath), {
        headers: { "content-type": MIME[ext] || "application/octet-stream" },
      });
    },
  },
};

// Seed 3 live dispatches on Robinhood Chain if local DB is empty so the front page teletype is immediately rich
const count = (await db.prepare("SELECT COUNT(*) AS c FROM missions").first())?.c || 0;
if (count === 0) {
  console.log("[wirecopy] Seeding initial live Robinhood Chain dispatches into local Morgue...");
  await tick(env, { force: true });
  await tick(env, { force: true });
  await tick(env, { force: true });
}

const server = http.createServer(async (req, res) => {
  const url = `http://localhost:${PORT}${req.url}`;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const waitTasks = [];
  const cfReq = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  const resp = await worker.fetch(cfReq, env, {
    waitUntil(p) {
      waitTasks.push(Promise.resolve(p).catch((e) => console.error("[waitUntil]", e)));
    },
  });

  res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()));
  const ab = await resp.arrayBuffer();
  res.end(Buffer.from(ab));
  await Promise.allSettled(waitTasks);
});

server.listen(PORT, () => {
  console.log(`[wirecopy] Live Newsroom & Teletype running at http://localhost:${PORT}`);
});
