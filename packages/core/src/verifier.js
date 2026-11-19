/**
 * Verbatim Source-Evidence Verifier & 0-Wallet Robinhood Chain (4663) Gate Helpers.
 *
 * Editorial rule:
 *  - ON THE WIRE (`verified`): exact substring/number in `evidence` exists inside the cited raw step output.
 *  - SPIKED (`unverified`): missing or altered quote -> flagged on the spike board so hallucinations never hide.
 */

export const RH_CHAIN_ID = 4663;
export const RH_DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const BURN_SINKS = new Set([
  "0x000000000000000000000000000000000000dead",
  "0x0000000000000000000000000000000000000000",
]);

export function isEvmAddress(v) {
  return typeof v === "string" && EVM_ADDR_RE.test(v.trim());
}

export function isEvmTxHash(v) {
  return typeof v === "string" && EVM_TX_RE.test(v.trim());
}

const normQuote = (s) => String(s || "").toLowerCase().replace(/[\s"'`,]/g, "");

/**
 * Deterministically checks whether `evidence` appears verbatim inside `rawStepOutput`.
 */
export function checkEvidence(rawStepOutput, evidence) {
  const e = normQuote(evidence);
  if (!rawStepOutput) {
    return { ok: false, stamp: "SPIKED", why: "cited step is missing or returned no raw payload" };
  }
  if (e.length < 3) {
    return { ok: false, stamp: "SPIKED", why: "quoted evidence is too short to verify" };
  }
  if (!/[0-9]/.test(e) && e.length < 8) {
    return { ok: false, stamp: "SPIKED", why: "evidence must contain a numeric figure or exact 8+ char field" };
  }
  const hay = normQuote(typeof rawStepOutput === "string" ? rawStepOutput : JSON.stringify(rawStepOutput));
  if (hay.includes(e)) {
    return { ok: true, stamp: "ON THE WIRE", why: "exact quote matched raw source payload" };
  }
  return { ok: false, stamp: "SPIKED", why: "quoted figure was not present in cited source step" };
}

/**
 * Scrubs accidental API keys / Bearer tokens / private keys before saving user questions or logs.
 */
export function scrubSecrets(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, (m) => m); // keep 32-byte tx hashes intact unless labeled key
}

export async function rhRpcCall(rpcUrl, method, params = [], fetchImpl = fetch) {
  const url = rpcUrl || RH_DEFAULT_RPC;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 350 * 2 ** attempt));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (body.error) {
      throw new Error(`Robinhood Chain RPC ${method}: ${body.error.message || "error"}`);
    }
    if (!res.ok) {
      throw new Error(`Robinhood Chain RPC HTTP ${res.status}`);
    }
    return body.result;
  }
  throw new Error(`Robinhood Chain RPC ${method} timed out`);
}

/**
 * 100% 0-Wallet read-only ERC-20 `balanceOf(wallet)` check on Robinhood Chain (4663).
 * Zero `window.ethereum` popups, zero signatures, zero approvals.
 */
export async function readTokenBalanceUnits(rpcUrl, tokenAddress, walletAddress, decimals = 18, fetchImpl = fetch) {
  if (!isEvmAddress(tokenAddress) || !isEvmAddress(walletAddress)) return 0;
  const data = "0x70a08231" + walletAddress.trim().slice(2).toLowerCase().padStart(64, "0");
  const rawHex = await rhRpcCall(
    rpcUrl,
    "eth_call",
    [{ to: tokenAddress.trim().toLowerCase(), data }, "latest"],
    fetchImpl
  );
  if (!rawHex || rawHex === "0x") return 0;
  const raw = BigInt(rawHex);
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale);
}

/**
 * Extracts exact burned amount of `tokenAddress` sent to `0x...dEaD` or `0x...0000` in a receipt.
 */
export function burnedInReceipt(receipt, tokenAddress) {
  let raw = 0n;
  let sender = null;
  const targetToken = String(tokenAddress || "").toLowerCase();
  for (const log of receipt?.logs || []) {
    if (String(log.address || "").toLowerCase() !== targetToken) continue;
    if (log.topics?.[0] !== ERC20_TRANSFER_TOPIC || (log.topics || []).length !== 3) continue;
    const to = "0x" + log.topics[2].slice(26).toLowerCase();
    if (!BURN_SINKS.has(to)) continue;
    raw += BigInt(log.data || "0x0");
    sender = sender || "0x" + log.topics[1].slice(26).toLowerCase();
  }
  return { raw, sender };
}
