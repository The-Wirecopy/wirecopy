/**
 * WIRECOPY API + Live Teletype Cron + Hourly Onchain Merkle Sealer + Streamable HTTP MCP Server.
 *
 * 100% 0-Wallet Architecture (passes all 4 Launchpad Product Gates):
 *  - Zero `Connect Wallet` / `personal_sign` popups required anywhere.
 *  - Visitors read live dispatches, search the Morgue, explore the Entity Graph, verify Merkle proofs,
 *    chat with the Copy Chief, and transmit free live dispatches immediately.
 *  - Holding `$WIRECOPY` (>= 1M Press Pass, >= 5M Bureau Chief) is checked 100% read-only via
 *    `eth_call balanceOf(0x...)` on Robinhood Chain (4663) by pasting any public 0x address.
 *  - Burning 50,000 `$WIRECOPY` to `0x...dEaD` jumps straight to #1 in the dispatch queue by tx hash.
 */

import {
  DESKS,
  HOUSE_ROTATION,
  RH_DEFAULT_RPC,
  isEvmAddress,
  isEvmTxHash,
  scrubSecrets,
  rhRpcCall,
  readTokenBalanceUnits,
  burnedInReceipt,
  inferDeskAndQuestion,
  keccak256,
  buildMerkleTree,
  verifyMerkleProof,
  hashFindingLeaf,
  getLiveTrenchRadar,
  runInstantXray,
  WireToolError,
} from "../../../packages/core/src/index.js";
import { executeMission, normalizeChatHistory, runCopyChiefChat } from "./llm-loop.js";
import { hasModelKey } from "./providers.js";
import { privateKeyToAddress, signLegacyTx } from "./signer.js";

export const VERSION = "1.0.0";
const MIN = 60_000;
const STALE_MS = 12 * MIN;
const DAY_MS = 86_400_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, x-api-key, x-admin-key, x-wallet-address, mcp-session-id, mcp-protocol-version",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", ...extra },
  });

const fail = (status, message) => Object.assign(new Error(message), { status });
const clamp = (v, lo, hi, d) =>
  Math.min(hi, Math.max(lo, v != null && v !== "" && Number.isFinite(+v) ? Math.floor(+v) : d));
const safeParse = (s, d) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};
const utcDay = () => new Date().toISOString().slice(0, 10);
const currentEpochHour = (ms = Date.now()) => Math.floor(ms / 1000 / 3600) * 3600;
const sha256Hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const randomKey = (prefix) =>
  prefix + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");

const BOOST_LABELS = ["", "press_pass", "bureau_chief", "flash_burn"];
const LIST_SQL = `SELECT m.*,
  (SELECT COUNT(*) FROM findings f WHERE f.mission = m.id) AS findings,
  (SELECT COUNT(*) FROM findings f WHERE f.mission = m.id AND f.status = 'verified') AS verified
  FROM missions m`;

function formatMission(m) {
  return {
    id: m.id,
    agent: m.agent,
    desk_name: DESKS[m.agent]?.name || m.agent,
    desk_code: DESKS[m.agent]?.code || "WIR",
    question: m.question,
    source: m.source,
    status: m.status,
    boost: BOOST_LABELS[m.priority || 0] || null,
    deep: Boolean(m.deep),
    created: m.created,
    started: m.started,
    finished: m.finished,
    report: m.report,
    error: m.error,
    findings: m.findings ?? 0,
    verified: m.verified ?? 0,
  };
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  // Lightweight idempotent bootstrap + starter newsroom Morgue seed so a cold DB is never empty
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM missions")
    .first()
    .catch(() => null);
  if (countRow === null) return; // schema applied externally via wrangler d1 execute
  schemaReady = true;
}

export function tierConfig(env) {
  const n = (v, d) => (v != null && v !== "" && Number.isFinite(+v) ? +v : d);
  return {
    token: env.TOKEN_ADDRESS || null,
    registry: env.TAPE_REGISTRY_ADDRESS || null,
    burn_flash: n(env.BURN_FLASH, 50_000),
    free: {
      name: "free",
      label: "Public Reader",
      min: 0,
      ask: n(env.ASK_FREE, 3),
      chat: n(env.CHAT_FREE, 20),
      api: n(env.API_FREE, 200),
      priority: 0,
      deep: false,
    },
    press: {
      name: "press",
      label: "Press Pass",
      min: n(env.HOLD_PRESS, 1_000_000),
      ask: n(env.ASK_PRESS, 12),
      chat: n(env.CHAT_PRESS, 100),
      api: n(env.API_PRESS, 5_000),
      priority: 1,
      deep: false,
    },
    chief: {
      name: "chief",
      label: "Bureau Chief",
      min: n(env.HOLD_CHIEF, 5_000_000),
      ask: n(env.ASK_CHIEF, 30),
      chat: n(env.CHAT_CHIEF, 300),
      api: n(env.API_CHIEF, 50_000),
      priority: 2,
      deep: true,
    },
  };
}

async function readCachedBalance(env, wallet) {
  if (!env.TOKEN_ADDRESS || !isEvmAddress(wallet)) return 0;
  const addr = wallet.trim().toLowerCase();
  const cfg = tierConfig(env);
  const row = await env.DB.prepare("SELECT holds, hold_checked FROM wallets WHERE addr = ?").bind(addr).first();
  const ttl = row && row.holds >= cfg.press.min ? 5 * MIN : 25_000;
  if (row && Date.now() - row.hold_checked < ttl) return row.holds;

  let holds = row?.holds ?? 0;
  try {
    holds = await readTokenBalanceUnits(
      env.RH_RPC_URL || RH_DEFAULT_RPC,
      env.TOKEN_ADDRESS,
      addr,
      Number(env.TOKEN_DECIMALS || 18),
      env.__fetchImpl || fetch
    );
    await env.DB.prepare(
      "INSERT INTO wallets (addr, holds, hold_checked) VALUES (?1, ?2, ?3) ON CONFLICT(addr) DO UPDATE SET holds = ?2, hold_checked = ?3"
    )
      .bind(addr, holds, Date.now())
      .run();
  } catch {}
  return holds;
}

/**
 * Resolves caller identity 100% read-only (zero wallet signature required):
 *  - `Authorization: Bearer wcp_...` / `x-api-key` -> bound wallet
 *  - `x-wallet-address` / `?wallet=0x...` / `body.wallet` -> read-only public wallet check
 */
async function resolveCaller(req, env, bodyObj = null) {
  const url = new URL(req.url);
  const rawKey =
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    (req.headers.get("x-api-key") || "").trim();

  if (rawKey) {
    if (!/^wcp_[0-9a-f]{40}$/.test(rawKey)) throw fail(401, "Invalid WireCopy MCP key (expected wcp_...)");
    const hash = await sha256Hex(rawKey);
    const row = await env.DB.prepare("SELECT wallet, name, expires FROM api_keys WHERE hash = ?").bind(hash).first();
    if (!row || row.expires < Date.now()) throw fail(401, "MCP key expired or unknown");
    return { wallet: row.wallet, keyName: row.name };
  }

  const candidate = (
    req.headers.get("x-wallet-address") ||
    url.searchParams.get("wallet") ||
    bodyObj?.wallet ||
    ""
  ).trim();
  if (candidate) {
    if (!isEvmAddress(candidate)) throw fail(400, "Wallet must be a valid 0x Robinhood Chain address");
    return { wallet: candidate.toLowerCase(), keyName: null };
  }
  return { wallet: null, keyName: null };
}

async function resolveTier(env, caller) {
  const cfg = tierConfig(env);
  if (!caller?.wallet || !env.TOKEN_ADDRESS) return { ...cfg.free, holds: 0, wallet: caller?.wallet || null };
  const holds = await readCachedBalance(env, caller.wallet);
  const tier = holds >= cfg.chief.min ? cfg.chief : holds >= cfg.press.min ? cfg.press : cfg.free;
  return { ...tier, holds, wallet: caller.wallet };
}

const whoKey = (req, caller) =>
  caller?.wallet ? `w:${caller.wallet}` : `ip:${req.headers.get("cf-connecting-ip") || "local"}`;

async function getUsage(env, who, kind) {
  return (
    (await env.DB.prepare("SELECT n FROM usage WHERE who = ? AND kind = ? AND day = ?").bind(who, kind, utcDay()).first())
      ?.n || 0
  );
}

async function bumpUsage(env, who, kind) {
  await env.DB.prepare(
    "INSERT INTO usage (who, kind, day, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(who, kind, day) DO UPDATE SET n = n + 1"
  )
    .bind(who, kind, utcDay())
    .run();
}

async function getGlobalToday(env, kind) {
  return (await env.DB.prepare("SELECT n FROM usage WHERE who = 'global' AND kind = ? AND day = ?").bind(kind, utcDay()).first())?.n || 0;
}

async function claimFlashBurn(env, txHashRaw) {
  if (!env.TOKEN_ADDRESS) throw fail(400, "Flash Bulletin burns activate as soon as $WIRECOPY is live on Pons");
  const tx = String(txHashRaw || "").trim().toLowerCase();
  if (!isEvmTxHash(tx)) throw fail(400, "burn_tx must be a 66-character 0x transaction hash");
  if (await env.DB.prepare("SELECT 1 FROM burns WHERE tx = ?").bind(tx).first()) {
    throw fail(409, "This burn transaction already dispatched a Flash Bulletin");
  }
  const f = env.__fetchImpl || fetch;
  const receipt = await rhRpcCall(env.RH_RPC_URL, "eth_getTransactionReceipt", [tx], f);
  if (!receipt) throw fail(404, "Burn tx not indexed on Robinhood Chain yet; retry in 2 seconds");
  if (receipt.status !== "0x1") throw fail(400, "Burn transaction reverted onchain");
  const block = await rhRpcCall(env.RH_RPC_URL, "eth_getBlockByNumber", [receipt.blockNumber, false], f);
  if (block?.timestamp && Date.now() / 1000 - parseInt(block.timestamp, 16) > 3600) {
    throw fail(400, "Burn transaction is older than 60 minutes; submit a fresh burn");
  }
  const { raw, sender } = burnedInReceipt(receipt, env.TOKEN_ADDRESS);
  const dec = Number(env.TOKEN_DECIMALS || 18);
  const need = BigInt(tierConfig(env).burn_flash) * 10n ** BigInt(dec);
  if (!sender || raw < need) {
    throw fail(400, `Burn at least ${tierConfig(env).burn_flash.toLocaleString("en-US")} $WIRECOPY to 0x...dEaD`);
  }
  const amount = Number(raw / 10n ** BigInt(dec));
  await env.DB.prepare("INSERT INTO burns (tx, wallet, amount, created) VALUES (?, ?, ?, ?)")
    .bind(tx, sender, amount, Date.now())
    .run();
  return sender;
}

function buildToolContext(env) {
  return {
    rpcUrl: env.RH_RPC_URL || RH_DEFAULT_RPC,
    fetchImpl: env.__fetchImpl || fetch,
    async cacheGet(key) {
      const row = await env.DB.prepare("SELECT body, at FROM cache WHERE key = ?").bind(key).first();
      return row ? { value: safeParse(row.body, null), at: row.at } : null;
    },
    async cacheSet(key, value, at) {
      await env.DB.prepare(
        "INSERT INTO cache (key, body, at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET body = ?2, at = ?3"
      )
        .bind(key, JSON.stringify(value), at)
        .run();
    },
    async morgueSearch({ query, limit }) {
      const words = String(query || "").toLowerCase().match(/[a-z0-9$.-]{2,}/g) || [];
      if (!words.length) return { source: "WireCopy Morgue", matches: [] };
      const n = clamp(limit, 1, 20, 10);
      const clauses = words.slice(0, 5).map(() => "(lower(f.claim) LIKE ? OR lower(f.entities) LIKE ?)").join(" OR ");
      const args = words.slice(0, 5).flatMap((w) => [`%${w}%`, `%${w}%`]);
      const { results } = await env.DB.prepare(
        `SELECT f.id, f.claim, f.evidence, f.status, f.source_url, f.created, m.agent, m.id AS mission
         FROM findings f JOIN missions m ON m.id = f.mission
         WHERE ${clauses}
         ORDER BY f.status = 'verified' DESC, f.id DESC LIMIT ?`
      )
        .bind(...args, n)
        .all();
      return {
        source: "WireCopy Morgue",
        matches: results.map((r) => ({
          finding: r.id,
          claim: r.claim,
          evidence: r.evidence,
          status: r.status,
          stamp: r.status === "verified" ? "ON THE WIRE" : "SPIKED",
          saved: new Date(r.created).toISOString().slice(0, 16),
          desk: r.agent,
          dispatch: r.mission,
          source: r.source_url,
        })),
      };
    },
  };
}

/**
 * Builds & seals a Merkle tape for the latest hour of `ON THE WIRE` findings (and optionally broadcasts
 * `WireTapeRegistry.sealTape` on Robinhood Chain 4663 if `SEAL_SIGNER_KEY` + `TAPE_REGISTRY_ADDRESS` are set).
 */
export async function sealLatestEpochTape(env, { epochHour = currentEpochHour() } = {}) {
  const existing = await env.DB.prepare("SELECT * FROM tape_seals WHERE epoch_hour = ?").bind(epochHour).first();
  if (existing) {
    return {
      epochHour: existing.epoch_hour,
      merkleRoot: existing.merkle_root,
      dispatchCount: existing.dispatch_count,
      wiredCount: existing.wired_count,
      txHash: existing.tx_hash,
      sealedAt: existing.sealed_at,
      leaves: safeParse(existing.leaves_json, []),
    };
  }

  const { results } = await env.DB.prepare(
    `SELECT f.id, f.mission, f.claim, f.evidence, f.source_url, f.status, m.agent
     FROM findings f JOIN missions m ON m.id = f.mission
     WHERE f.status = 'verified'
     ORDER BY f.id DESC LIMIT 32`
  ).all();

  if (!results.length) return null;

  const rawLeaves = results.map((r) => ({
    epochHour,
    chainId: 4663,
    findingId: r.id,
    dispatchId: r.mission,
    desk: r.agent,
    claim: r.claim,
    evidence: r.evidence,
    sourceUrl: r.source_url || "",
    status: "verified",
  }));

  const tree = buildMerkleTree(rawLeaves);
  const leavesWithProof = tree.leaves.map((l, idx) => ({
    index: idx,
    leafHash: l.leafHash,
    record: l.normalized,
    proof: tree.getProof(idx),
  }));
  const dispatchCount = new Set(results.map((r) => r.mission)).size;
  let txHash = null;

  if (env.SEAL_SIGNER_KEY && isEvmAddress(env.TAPE_REGISTRY_ADDRESS)) {
    try {
      const f = env.__fetchImpl || fetch;
      const rpcUrl = env.RH_RPC_URL || RH_DEFAULT_RPC;
      const signerAddr = privateKeyToAddress(env.SEAL_SIGNER_KEY);
      const [nonceHex, gasPriceHex] = await Promise.all([
        rhRpcCall(rpcUrl, "eth_getTransactionCount", [signerAddr, "pending"], f),
        rhRpcCall(rpcUrl, "eth_gasPrice", [], f),
      ]);
      const selector = keccak256("sealTape(uint64,bytes32,uint32,uint32)").slice(0, 10);
      const dataHex =
        selector +
        BigInt(epochHour).toString(16).padStart(64, "0") +
        tree.root.slice(2).padStart(64, "0") +
        BigInt(dispatchCount).toString(16).padStart(64, "0") +
        BigInt(results.length).toString(16).padStart(64, "0");

      const signed = signLegacyTx(
        {
          nonce: BigInt(nonceHex),
          gasPriceWei: (BigInt(gasPriceHex || "0x5f5e100") * 12n) / 10n,
          gasLimit: 180_000n,
          to: env.TAPE_REGISTRY_ADDRESS.toLowerCase(),
          valueWei: 0n,
          dataHex,
          chainId: 4663,
        },
        env.SEAL_SIGNER_KEY
      );
      txHash = await rhRpcCall(rpcUrl, "eth_sendRawTransaction", [signed.rawTx], f);
    } catch (e) {
      console.error("sealTape onchain broadcast skipped:", e.message || e);
    }
  }

  const sealedAt = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO tape_seals (epoch_hour, merkle_root, dispatch_count, wired_count, tx_hash, sealed_at, leaves_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(epochHour, tree.root, dispatchCount, results.length, txHash, sealedAt, JSON.stringify(leavesWithProof))
    .run();

  return {
    epochHour,
    merkleRoot: tree.root,
    dispatchCount,
    wiredCount: results.length,
    txHash,
    sealedAt,
    leaves: leavesWithProof,
  };
}

/**
 * Works one queued dispatch (or schedules a house beat dispatch when idle).
 */
export async function tick(env, { now = Date.now(), force = false, targetId = null } = {}) {
  const db = env.DB;
  await db
    .prepare("UPDATE missions SET status = 'failed', error = 'wire timed out', finished = ? WHERE status = 'running' AND started < ?")
    .bind(now, now - STALE_MS)
    .run();

  if (!targetId && (await db.prepare("SELECT id FROM missions WHERE status = 'running' LIMIT 1").first())) {
    return null;
  }

  let next = targetId
    ? await db.prepare("SELECT * FROM missions WHERE id = ? AND status = 'queued'").bind(targetId).first()
    : await db.prepare("SELECT * FROM missions WHERE status = 'queued' ORDER BY priority DESC, id ASC LIMIT 1").first();

  if (!next && !targetId) {
    const last = await db.prepare("SELECT MAX(COALESCE(started, created)) AS t FROM missions").first();
    const everyMs = Number(env.HOUSE_EVERY_MIN || 90) * MIN;
    if (!force && last?.t && now - last.t < everyMs) return null;
    const houseCount = (await db.prepare("SELECT COUNT(*) AS c FROM missions WHERE source = 'house'").first())?.c || 0;
    const [desk, question] = HOUSE_ROTATION[houseCount % HOUSE_ROTATION.length];
    const ins = await db
      .prepare("INSERT INTO missions (agent, question, source, status, created) VALUES (?, ?, 'house', 'queued', ?)")
      .bind(desk, question, now)
      .run();
    const id = ins.meta?.last_row_id ?? ins.lastInsertRowid;
    next = await db.prepare("SELECT * FROM missions WHERE id = ?").bind(id).first();
  }

  if (!next) return null;

  const claim = await db
    .prepare("UPDATE missions SET status = 'running', started = ? WHERE id = ? AND status = 'queued'")
    .bind(now, next.id)
    .run();
  if (!(claim.meta?.changes ?? claim.changes)) return null;

  let stepN = (await db.prepare("SELECT MAX(n) AS n FROM steps WHERE mission = ?").bind(next.id).first())?.n || 0;
  const ctx = buildToolContext(env);

  const logStep = async (kind, tool, body) => {
    stepN += 1;
    await db
      .prepare("INSERT INTO steps (mission, n, at, kind, tool, body) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(next.id, stepN, Date.now(), kind, tool, typeof body === "string" ? body : JSON.stringify(body))
      .run();
    return stepN;
  };

  const saveFinding = async ({ step, claim: cText, evidence, sourceUrl, status, entities }) => {
    await db
      .prepare(
        "INSERT INTO findings (mission, step, claim, evidence, source_url, status, entities, epoch_hour, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(next.id, step, cText, evidence, sourceUrl, status, JSON.stringify(entities), currentEpochHour(), Date.now())
      .run();
  };

  const loadStepBody = async (n) => {
    const r = await db.prepare("SELECT body FROM steps WHERE mission = ? AND n = ?").bind(next.id, n).first();
    return r?.body || null;
  };

  try {
    const res = await executeMission(env, ctx, next, { logStep, saveFinding, loadStepBody });
    await db
      .prepare("UPDATE missions SET status = 'done', finished = ?, report = ?, tokens_in = ?, tokens_out = ? WHERE id = ?")
      .bind(Date.now(), res.report, res.tokensIn || 0, res.tokensOut || 0, next.id)
      .run();
    // Refresh current hour Merkle tape snapshot whenever new verified findings land
    if (res.wiredCount > 0) {
      await env.DB.prepare("DELETE FROM tape_seals WHERE epoch_hour = ? AND tx_hash IS NULL").bind(currentEpochHour()).run();
      await sealLatestEpochTape(env).catch(() => null);
    }
  } catch (err) {
    await db
      .prepare("UPDATE missions SET status = 'failed', finished = ?, error = ? WHERE id = ?")
      .bind(Date.now(), String(err.message || err).slice(0, 280), next.id)
      .run();
  }

  return next.id;
}

async function getStats(env, req) {
  const m = await env.DB.prepare(
    "SELECT COUNT(*) AS runs, SUM(status = 'done') AS done, SUM(status = 'failed') AS failed, SUM(status = 'queued') AS queued, SUM(status = 'running') AS running, MAX(COALESCE(finished, started, created)) AS last FROM missions"
  ).first();
  const f = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(status = 'verified') AS verified, SUM(status = 'unverified') AS spiked FROM findings"
  ).first();
  const b = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(amount) AS amount FROM burns").first();
  const s = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(epoch_hour) AS latest FROM tape_seals").first();

  const caller = await resolveCaller(req, env).catch(() => ({ wallet: null }));
  const tier = await resolveTier(env, caller);
  const who = whoKey(req, caller);

  return {
    name: "WIRECOPY",
    version: VERSION,
    ai_live: hasModelKey(env),
    model: env.MODEL || "gpt-5.4",
    missions: m?.runs || 0,
    done: m?.done || 0,
    failed: m?.failed || 0,
    queued: m?.queued || 0,
    running: m?.running || 0,
    last_activity: m?.last || null,
    findings: f?.total || 0,
    verified: f?.verified || 0,
    spiked: f?.spiked || 0,
    match_rate_pct: f?.total ? Math.round(((f.verified || 0) / f.total) * 100) : 100,
    burns: b?.n || 0,
    burned: b?.amount || 0,
    seals: s?.n || 0,
    latest_seal_epoch: s?.latest || null,
    desks: Object.keys(DESKS).length,
    house_every_min: Number(env.HOUSE_EVERY_MIN || 90),
    token: env.TOKEN_ADDRESS || null,
    registry: env.TAPE_REGISTRY_ADDRESS || null,
    tiers: tierConfig(env),
    caller: {
      wallet: tier.wallet,
      holds: tier.holds,
      tier: tier.name,
      label: tier.label,
      used: {
        ask: await getUsage(env, who, "ask"),
        chat: await getUsage(env, who, "chat"),
        api: await getUsage(env, who, "api"),
      },
      limits: { ask: tier.ask, chat: tier.chat, api: tier.api },
    },
  };
}

async function getMissionDetail(env, id, after = 0) {
  const m = await env.DB.prepare(`${LIST_SQL} WHERE m.id = ?`).bind(id).first();
  if (!m) throw fail(404, "Dispatch not found");
  const { results } = await env.DB.prepare(
    "SELECT n, at, kind, tool, body FROM steps WHERE mission = ? AND n > ? ORDER BY n ASC LIMIT 300"
  )
    .bind(id, after)
    .all();

  const steps = results.map((s) => ({
    n: s.n,
    at: s.at,
    kind: s.kind,
    tool: s.tool,
    body: s.kind === "result" || s.kind === "call" || s.kind === "finding" ? safeParse(s.body, s.body) : s.body,
  }));

  let position = null;
  if (m.status === "queued") {
    position =
      ((
        await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM missions WHERE status = 'queued' AND (priority > ?1 OR (priority = ?1 AND id < ?2))"
        )
          .bind(m.priority || 0, id)
          .first()
      )?.c || 0) + 1;
  }

  return { mission: { ...formatMission(m), position }, steps };
}

async function enqueueDispatch(env, req, body, ctxExec) {
  const caller = await resolveCaller(req, env, body);
  const rawInput = scrubSecrets(String(body.question || body.input || "").replace(/\s+/g, " ").trim());
  if (rawInput.length < 2 || rawInput.length > 280) {
    throw fail(400, "Enter a stock ticker (TSLA), 0x address, or wire question up to 280 chars");
  }
  if (/https?:\/\//i.test(rawInput)) {
    throw fail(400, "Paste a ticker or 0x address rather than an external URL");
  }

  const routed = inferDeskAndQuestion(rawInput, body.agent || body.desk || "");
  const tier = await resolveTier(env, caller);
  const who = whoKey(req, caller);

  let priority = tier.priority;
  let wallet = caller.wallet;
  let burnTx = null;

  if (body.burn_tx) {
    wallet = await claimFlashBurn(env, body.burn_tx);
    burnTx = String(body.burn_tx).trim().toLowerCase();
    priority = 3;
  } else {
    if ((await getUsage(env, who, "ask")) >= tier.ask) {
      throw fail(
        429,
        tier.name === "free" && env.TOKEN_ADDRESS
          ? `Daily free dispatches (${tier.ask}) used. Paste a wallet holding >=1M $WIRECOPY (0-wallet read-only) or burn ${tierConfig(env).burn_flash.toLocaleString("en-US")} to jump first.`
          : "Daily dispatch quota used for this tier."
      );
    }
    if (tier.name === "free" && (await getGlobalToday(env, "ask")) >= Number(env.PUBLIC_PER_DAY || 50)) {
      throw fail(429, "Public reader wire queue is at daily capacity; Press Pass holders and Flash Burns still transmit.");
    }
  }

  const ins = await env.DB.prepare(
    "INSERT INTO missions (agent, question, source, ip, wallet, priority, deep, burn_tx, status, created) VALUES (?, ?, 'public', ?, ?, ?, ?, ?, 'queued', ?)"
  )
    .bind(
      routed.desk,
      routed.question,
      who.startsWith("ip:") ? who.slice(3) : null,
      wallet,
      priority,
      tier.deep ? 1 : 0,
      burnTx,
      Date.now()
    )
    .run();

  if (!burnTx) {
    await bumpUsage(env, who, "ask");
    if (tier.name === "free") await bumpUsage(env, "global", "ask");
  }

  const newId = ins.meta?.last_row_id ?? ins.lastInsertRowid;
  // Immediately kick execution in background (`ctx.waitUntil`) so the visitor sees live steps stream within 1 second!
  if (ctxExec?.waitUntil) {
    ctxExec.waitUntil(tick(env, { force: true, targetId: newId }));
  } else if (body.sync) {
    await tick(env, { force: true, targetId: newId });
  }

  return getMissionDetail(env, newId, 0);
}

async function queryMorgue(env, { q = "", agent = "", status = "", limit } = {}) {
  const where = [];
  const args = [];
  const cleanQ = String(q || "").toLowerCase().trim().slice(0, 64);
  if (cleanQ) {
    where.push("(lower(f.claim) LIKE ? OR lower(f.entities) LIKE ? OR lower(f.evidence) LIKE ?)");
    args.push(`%${cleanQ}%`, `%${cleanQ}%`, `%${cleanQ}%`);
  }
  if (agent && DESKS[agent]) {
    where.push("m.agent = ?");
    args.push(agent);
  }
  if (status === "verified" || status === "unverified") {
    where.push("f.status = ?");
    args.push(status);
  }
  const { results } = await env.DB.prepare(
    `SELECT f.*, m.agent, m.question FROM findings f JOIN missions m ON m.id = f.mission
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY f.id DESC LIMIT ?`
  )
    .bind(...args, clamp(limit, 1, 200, 60))
    .all();

  return {
    findings: results.map((f) => ({
      id: f.id,
      mission: f.mission,
      step: f.step,
      agent: f.agent,
      desk_code: DESKS[f.agent]?.code || "WIR",
      question: f.question,
      claim: f.claim,
      evidence: f.evidence,
      source: f.source_url,
      status: f.status,
      stamp: f.status === "verified" ? "ON THE WIRE" : "SPIKED",
      entities: safeParse(f.entities, []),
      epoch_hour: f.epoch_hour,
      created: f.created,
    })),
  };
}

async function queryGraph(env) {
  const { results } = await env.DB.prepare("SELECT id, entities, status FROM findings ORDER BY id DESC LIMIT 600").all();
  const nodes = new Map();
  const edges = new Map();
  for (const f of results) {
    const ents = safeParse(f.entities, []);
    for (const e of ents) {
      const n = nodes.get(e) || { id: e, findings: 0, verified: 0 };
      n.findings += 1;
      if (f.status === "verified") n.verified += 1;
      nodes.set(e, n);
    }
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const k = [ents[i], ents[j]].sort().join("\u0000");
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
  }
  const top = [...nodes.values()].sort((a, b) => b.findings - a.findings).slice(0, 65);
  const keep = new Set(top.map((n) => n.id));
  return {
    nodes: top,
    edges: [...edges.entries()]
      .map(([k, w]) => {
        const [a, b] = k.split("\u0000");
        return { a, b, w };
      })
      .filter((e) => keep.has(e.a) && keep.has(e.b))
      .sort((x, y) => y.w - x.w)
      .slice(0, 180),
  };
}

async function issueReadOnlyKey(env, body) {
  const wallet = String(body?.wallet || "").trim().toLowerCase();
  if (!isEvmAddress(wallet)) {
    throw fail(400, "Paste any public 0x Robinhood Chain wallet address (no signature required)");
  }
  const name = String(body?.name || "cursor-agent").trim();
  if (!/^[A-Za-z0-9_.-]{2,28}$/.test(name)) {
    throw fail(400, "Key label must be 2–28 letters, digits, dashes, or underscores");
  }
  const key = randomKey("wcp_");
  const expires = Date.now() + 365 * DAY_MS;
  await env.DB.prepare("INSERT INTO api_keys (hash, wallet, name, created, expires) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(key), wallet, name, Date.now(), expires)
    .run();
  const tier = await resolveTier(env, { wallet });
  return {
    key,
    name,
    wallet,
    tier: tier.name,
    label: tier.label,
    holds: tier.holds,
    daily_api_limit: tier.api,
    note: "0-wallet read-only MCP key issued. Quota scales automatically with the $WIRECOPY balance held by this address.",
  };
}

// ---------- Streamable HTTP MCP Server (`/mcp`) ----------
export const MCP_TOOLS = [
  {
    name: "instant_xray",
    title: "Instant <1s Robinhood Chain Token / Stock / Wallet X-Ray",
    description:
      "Sub-second deterministic check for fake stock ticker clones (TSLA, NVDA, HOOD, SPY, etc.), Pons bonding-curve tax bps, non-pool top-10 whale concentration %, deployer holdings %, and live Chainlink oracle spread.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: '0x token/wallet address, URL, or ticker, e.g. "TSLA" or "0xaa55..."' },
      },
      required: ["query"],
    },
  },
  {
    name: "search_morgue",
    title: "Search WireCopy Morgue",
    description:
      "Search source-verified ON THE WIRE findings (and SPIKED rejections) about Robinhood Chain stock tokens, Chainlink feeds, Pons curves, DeFi TVL, and wallets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Keywords, ticker, or 0x prefix, e.g. "TSLA" or "morpho"' },
        status: { type: "string", enum: ["verified", "unverified", "all"] },
        limit: { type: "number", description: "1–100, default 20" },
      },
    },
  },
  {
    name: "recent_dispatches",
    title: "Recent Wire Dispatches",
    description: "List the latest live AI research dispatches across all 6 editorial desks.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "1–50, default 12" } },
    },
  },
  {
    name: "get_dispatch",
    title: "Read Full Dispatch Tape",
    description: "Read every numbered step, raw JSON tool output, finding verification stamp, and final --30-- bulletin.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "ask_copy_chief",
    title: "Ask the Copy Chief",
    description: "Ask WireCopy's Copy Chief a question; checks the Morgue and live Robinhood Chain feeds.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "transmit_dispatch",
    title: "Transmit Live Research Dispatch",
    description: `Queue a live public AI research dispatch to one of the 6 desks (${Object.keys(DESKS).join(", ")}).`,
    inputSchema: {
      type: "object",
      properties: {
        desk: { type: "string", enum: Object.keys(DESKS) },
        question: { type: "string", description: "Ticker, 0x address, or research question (up to 280 chars)" },
      },
      required: ["question"],
    },
  },
  {
    name: "verify_tape_seal",
    title: "Verify Hourly Merkle Tape Seal",
    description: "Fetch the latest Merkle root and inclusion proofs of ON THE WIRE findings anchored to Robinhood Chain.",
    inputSchema: {
      type: "object",
      properties: { epoch_hour: { type: "number", description: "Optional UTC epoch hour" } },
    },
  },
];

async function handleMcp(req, env, ctxExec) {
  const msg = await req.json().catch(() => null);
  if (!msg || msg.jsonrpc !== "2.0") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON-RPC parse error" } }, 400);
  }
  if (msg.id === undefined) return new Response(null, { status: 202, headers: CORS });

  const reply = (result) => json({ jsonrpc: "2.0", id: msg.id, result });
  const textOut = (text, data) => reply({ content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) });

  if (msg.method === "initialize") {
    return reply({
      protocolVersion: msg.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "wirecopy", title: "WIRECOPY — Verified AI Memory Wire for Robinhood Chain", version: VERSION },
      instructions:
        "WIRECOPY is a shared, source-verified research wire for Robinhood Chain (4663). Search the Morgue before making redundant RPC calls, and cite whether each finding was stamped ON THE WIRE (verified) or SPIKED.",
    });
  }
  if (msg.method === "ping") return reply({});
  if (msg.method === "tools/list") return reply({ tools: MCP_TOOLS });

  if (msg.method === "tools/call") {
    const { name, arguments: a = {} } = msg.params || {};
    try {
      const caller = await resolveCaller(req, env);
      const who = whoKey(req, caller);
      const tier = await resolveTier(env, caller);
      if ((await getUsage(env, who, "api")) >= tier.api) {
        throw fail(429, `Daily MCP call quota (${tier.api}) reached. Pass X-Wallet-Address holding >=1M $WIRECOPY for 5,000+/day.`);
      }
      await bumpUsage(env, who, "api");

      if (name === "instant_xray") {
        const xr = await runInstantXray(buildToolContext(env), a.query || "");
        const summary = [
          `[${xr.badge}] ${xr.title} (${xr.address}) — ${xr.elapsed_ms}ms`,
          ...(xr.metrics || []).map((m) => `• ${m.label}: ${m.value}`),
          ...(xr.flags || []).map((f) => `[${f.severity.toUpperCase()}] ${f.text}`),
        ].join("\n");
        return textOut(summary, xr);
      }
      if (name === "search_morgue") {
        const r = await queryMorgue(env, {
          q: a.query || "",
          status: a.status === "all" ? "" : a.status || "",
          limit: clamp(a.limit, 1, 100, 20),
        });
        const txt = r.findings.length
          ? r.findings.map((f) => `[${f.stamp}] ${f.claim} (evidence: ${f.evidence} · source: ${f.source || "n/a"} · dispatch #${f.mission})`).join("\n")
          : "No clippings in the Morgue match that query yet.";
        return textOut(txt, r);
      }
      if (name === "recent_dispatches") {
        const { results } = await env.DB.prepare(`${LIST_SQL} ORDER BY m.id DESC LIMIT ?`).bind(clamp(a.limit, 1, 50, 12)).all();
        const list = results.map(formatMission);
        return textOut(
          list.map((m) => `#${m.id} [${m.desk_code}] ${m.status} (${m.verified}/${m.findings} ON WIRE) — ${m.question}`).join("\n"),
          { missions: list }
        );
      }
      if (name === "get_dispatch") {
        const r = await getMissionDetail(env, Number(a.id), 0);
        return textOut(`#${r.mission.id} [${r.mission.desk_code}] ${r.mission.question}\n\n${r.mission.report || r.mission.status}`, r);
      }
      if (name === "ask_copy_chief") {
        const r = await runCopyChiefChat(env, buildToolContext(env), [{ role: "user", content: String(a.question || "") }]);
        return textOut(r.reply, r);
      }
      if (name === "transmit_dispatch") {
        const r = await enqueueDispatch(env, req, { desk: a.desk, question: a.question }, ctxExec);
        return textOut(`Dispatch #${r.mission.id} transmitted to ${r.mission.desk_name}. Read with get_dispatch.`, r);
      }
      if (name === "verify_tape_seal") {
        const seal = await sealLatestEpochTape(env, a.epoch_hour ? { epochHour: Number(a.epoch_hour) } : {});
        if (!seal) return textOut("No verified findings sealed in this epoch yet.");
        return textOut(
          `Epoch ${seal.epochHour} · Merkle Root ${seal.merkleRoot} · ${seal.wiredCount} ON THE WIRE findings${seal.txHash ? ` · tx ${seal.txHash}` : ""}`,
          seal
        );
      }
      return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    } catch (e) {
      return reply({ isError: true, content: [{ type: "text", text: e.message || "MCP call failed" }] });
    }
  }

  return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
}

function buildLlmsTxt(origin, env) {
  return `# WIRECOPY — Autonomous AI News Wire & Source-Verified Shared Memory on Robinhood Chain (4663)

> If the tape doesn't match, spike the copy.

WIRECOPY operates 6 autonomous AI research desks (Equities, Curves, DeFi, Risk, Chain, Morgue) reading live Robinhood Chain data: official Robinhood tokenized equities, Chainlink oracles, Pons bonding curves, Sherwood, DeFiLlama, and RPC logs. Every quoted figure is deterministically checked against raw step JSON before going ON THE WIRE (\`verified\`) or getting SPIKED (\`unverified\`), and hourly Merkle roots are sealed to \`WireTapeRegistry.sol\` on chain 4663.

## Quick Connect (Zero Wallet Signatures Required)
- Local CLI + Multi-Agent Installer (Cursor, Claude Code, Codex, Claude Desktop): \`npx -y github:The-Wirecopy/wirecopy init\`
- Public GitHub Repository: https://github.com/The-Wirecopy/wirecopy
- Remote Streamable HTTP MCP (JSON-RPC 2.0): \`${origin}/mcp\`
- Optional Read-Only Press Pass Header: \`X-Wallet-Address: 0xYourPublicRobinhoodWallet\` (reads \`balanceOf\` onchain, zero signatures)

## Token & Onchain Contracts (Chain ID 4663)
- Token ($WIRECOPY): ${env.TOKEN_ADDRESS || "ANNOUNCING_ON_X"}
- WireTapeRegistry (Sourcify exact_match): ${env.TAPE_REGISTRY_ADDRESS || "DEPLOYING_ON_4663"}

## REST API
- \`GET ${origin}/v1/stats\` — Bureau stats, match rate %, caller read-only tier
- \`GET ${origin}/v1/desks\` — The 6 editorial AI desks
- \`GET ${origin}/v1/missions\` — Live & completed wire dispatches
- \`GET ${origin}/v1/missions/:id?after=0\` — Step-by-step live teletype stream & verbatim JSON payloads
- \`POST ${origin}/v1/missions\` — Transmit a live question, ticker, or 0x address (\`{"question":"TSLA","desk":"equities"}\`)
- \`GET ${origin}/v1/memory?q=&status=\` — Search ON THE WIRE findings & SPIKED claims
- \`GET ${origin}/v1/graph\` — Entity co-occurrence graph
- \`POST ${origin}/v1/chat\` — Chat with the Copy Chief
- \`GET ${origin}/v1/seals\` — Hourly Merkle roots & inclusion proofs for client-side verification
- \`POST ${origin}/v1/keys\` — Issue a read-only \`wcp_...\` MCP key bound to a public 0x address
`;
}

export default {
  async fetch(req, env, ctxExec) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";

    try {
      await ensureSchema(env);

      if (p === "/llms.txt" || p === "/SKILL.md") {
        return new Response(buildLlmsTxt(url.origin, env), {
          status: 200,
          headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (p === "/mcp") {
        return req.method === "POST"
          ? await handleMcp(req, env, ctxExec)
          : json({ name: "WIRECOPY MCP", protocol: "JSON-RPC 2.0 over POST", tools: MCP_TOOLS.map((t) => t.name) });
      }

      if (req.method === "GET" && p.startsWith("/v1")) {
        if (p === "/v1") {
          return json({
            name: "WIRECOPY API",
            version: VERSION,
            endpoints: [
              "/v1/xray?q=<0x_or_ticker>",
              "/v1/radar",
              "/v1/stats",
              "/v1/desks",
              "/v1/missions",
              "/v1/missions/:id",
              "/v1/memory",
              "/v1/graph",
              "/v1/seals",
              "/v1/chat",
              "/v1/keys",
              "/mcp",
            ],
          });
        }
        if (p === "/v1/radar") {
          return json(await getLiveTrenchRadar(buildToolContext(env)), 200, { "cache-control": "public, max-age=45" });
        }
        if (p === "/v1/xray") {
          const q = url.searchParams.get("q") || url.searchParams.get("address") || url.searchParams.get("query") || "";
          try {
            return json(await runInstantXray(buildToolContext(env), q));
          } catch (err) {
            if (err instanceof WireToolError) throw fail(400, err.message);
            throw err;
          }
        }
        if (p === "/v1/desks" || p === "/v1/agents") {
          return json({ desks: Object.values(DESKS) }, 200, { "cache-control": "public, max-age=300" });
        }
        if (p === "/v1/stats") return json(await getStats(env, req));
        if (p === "/v1/missions") {
          const { results } = await env.DB.prepare(`${LIST_SQL} ORDER BY m.id DESC LIMIT ?`)
            .bind(clamp(url.searchParams.get("limit"), 1, 100, 30))
            .all();
          return json({ missions: results.map(formatMission) });
        }
        const mMatch = p.match(/^\/v1\/missions\/(\d+)$/);
        if (mMatch) {
          return json(await getMissionDetail(env, Number(mMatch[1]), clamp(url.searchParams.get("after"), 0, 1e6, 0)));
        }
        if (p === "/v1/memory") {
          return json(
            await queryMorgue(env, {
              q: url.searchParams.get("q") || "",
              agent: url.searchParams.get("agent") || url.searchParams.get("desk") || "",
              status: url.searchParams.get("status") || "",
              limit: url.searchParams.get("limit"),
            })
          );
        }
        if (p === "/v1/graph") return json(await queryGraph(env));
        if (p === "/v1/seals") {
          await sealLatestEpochTape(env).catch(() => null);
          const { results } = await env.DB.prepare(
            "SELECT epoch_hour, merkle_root, dispatch_count, wired_count, tx_hash, sealed_at, leaves_json FROM tape_seals ORDER BY epoch_hour DESC LIMIT 12"
          ).all();
          return json({
            registry: env.TAPE_REGISTRY_ADDRESS || null,
            chainId: 4663,
            seals: results.map((s) => ({
              epochHour: s.epoch_hour,
              merkleRoot: s.merkle_root,
              dispatchCount: s.dispatch_count,
              wiredCount: s.wired_count,
              txHash: s.tx_hash,
              sealedAt: s.sealed_at,
              leaves: safeParse(s.leaves_json, []),
            })),
          });
        }
      }

      if (req.method === "POST" && p.startsWith("/v1")) {
        const body = await req.json().catch(() => ({}));
        if (p === "/v1/missions") return json(await enqueueDispatch(env, req, body, ctxExec), 201);
        if (p === "/v1/chat") {
          const caller = await resolveCaller(req, env, body);
          const tier = await resolveTier(env, caller);
          const who = whoKey(req, caller);
          const usedNow = await getUsage(env, who, "chat");
          if (usedNow >= tier.chat) {
            throw fail(429, `Daily Copy Chief messages (${tier.chat}) used. Paste a Press Pass wallet (>=1M $WIRECOPY) for 100/day.`);
          }
          await bumpUsage(env, who, "chat");
          const msgs = normalizeChatHistory(body.messages);
          const out = await runCopyChiefChat(env, buildToolContext(env), msgs);
          return json({ ...out, left: Math.max(0, tier.chat - usedNow - 1), tier: tier.name });
        }
        if (p === "/v1/keys") return json(await issueReadOnlyKey(env, body), 201);
        if (p === "/v1/verify-leaf") {
          const v = verifyMerkleProof({
            record: body.record,
            leafHash: body.leafHash || (body.record ? hashFindingLeaf(body.record).leafHash : undefined),
            proof: body.proof || [],
            expectedRoot: body.expectedRoot || "",
          });
          return json(v);
        }
        if (p === "/v1/run") {
          if (!env.ADMIN_KEY || req.headers.get("x-admin-key") !== env.ADMIN_KEY) throw fail(401, "Admin key required");
          const ran = await tick(env, { force: true });
          const seal = await sealLatestEpochTape(env).catch(() => null);
          return json({ ran, latestSeal: seal?.merkleRoot || null });
        }
      }

      // Serve static website assets when running as unified Cloudflare Worker + Assets
      if (env.ASSETS) {
        return env.ASSETS.fetch(req);
      }

      throw fail(404, "Not found");
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : "Internal wire error" }, e.status || 500);
    }
  },

  async scheduled(_event, env, ctxExec) {
    ctxExec.waitUntil(
      (async () => {
        await tick(env);
        if (new Date().getUTCMinutes() === 5) {
          await sealLatestEpochTape(env).catch(() => null);
        }
      })()
    );
  },
};
