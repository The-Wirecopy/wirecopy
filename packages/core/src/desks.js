/**
 * WireCopy 6 Editorial Desks + Auto-Router + Deterministic Wire Engine.
 *
 * Why a deterministic engine sits underneath optional LLM synthesis:
 *  - Even if OpenAI/Anthropic credits hit $0 or time out, every dispatch STILL executes live
 *    Robinhood Chain RPC / Chainlink / Pons / DeFiLlama calls, extracts exact verbatim JSON substrings,
 *    runs `checkEvidence`, stamps findings `ON THE WIRE` (`verified`) or `SPIKED` (`unverified`),
 *    and prints a 1970s wire bulletin ending in `--30--`.
 */

import { checkEvidence, isEvmAddress } from "./verifier.js";
import { runWireTool } from "./sources.js";

export const DESKS = {
  equities: {
    id: "equities",
    code: "EQT",
    name: "Equities Desk",
    focus: "Official Robinhood tokenized stocks & ETFs vs live Chainlink oracle spreads, multipliers, and market-hours gaps.",
    prompts: [
      "TSLA",
      "How wide is the spread between NVDA and AAPL stock tokens and their Chainlink oracles?",
    ],
  },
  curves: {
    id: "curves",
    code: "CRV",
    name: "Curve Desk",
    focus: "Pons launchpad bonding curves: graduation progress %, holder concentration, volume, creator tax bps, and graduates.",
    prompts: [
      "Which Pons bonding curves lead volume right now and how far along are they?",
      "0xcd5c01ea857df6253323a1bde87cd1d3a442a8f7",
    ],
  },
  defi: {
    id: "defi",
    code: "DFI",
    name: "DeFi Desk",
    focus: "Robinhood Chain TVL concentration, DEX 24h/7d trading volume, protocol user fees, lending markets, and curators.",
    prompts: [
      "Which protocols hold the most TVL on Robinhood Chain today?",
      "Which DEXs carry Robinhood Chain trading volume over the last 24h and 7d?",
    ],
  },
  risk: {
    id: "risk",
    code: "RSK",
    name: "Risk Desk",
    focus: "Counterfeit stock-ticker clones on Pons, top-10 whale concentration, unlabeled wallets, and stablecoin supply shifts.",
    prompts: [
      "Are there unofficial Pons tokens copying tickers like TSLA or NVDA?",
      "Which stablecoins dominate circulating supply on Robinhood Chain?",
    ],
  },
  chain: {
    id: "chain",
    code: "RPC",
    name: "Chain Desk",
    focus: "Direct Robinhood Chain (4663) JSON-RPC inspection: contract bytecode vs EOA wallets, ETH balances, and ERC-20 transfers.",
    prompts: [
      "Inspect 0xda4283f14b487034b90d865aac489994f2c680c4 onchain supply, bytecode, and holders",
    ],
  },
  morgue: {
    id: "morgue",
    code: "MRG",
    name: "Morgue Desk",
    focus: "Cross-examines earlier ON THE WIRE clippings in the shared archive against fresh live numbers to surface what moved.",
    prompts: [
      "Compare earlier Morgue records on Robinhood Chain TVL and stock tokens against live tape now",
    ],
  },
};

export const HOUSE_ROTATION = [
  ["equities", "Check live TSLA and NVDA Robinhood stock token prices against their Chainlink oracles."],
  ["curves", "Which Pons launches are trending right now by market cap, volume, and curve progress?"],
  ["defi", "Which Robinhood Chain protocols lead DeFi TVL today and what is total chain TVL?"],
  ["risk", "Scan Pons launches for unofficial look-alike tokens sharing TSLA or NVDA tickers."],
  ["defi", "Measure 24-hour and 7-day DEX trading volume across Robinhood Chain venues."],
  ["risk", "Check circulating stablecoin supply and top pegged assets on Robinhood Chain."],
  ["equities", "Inspect AAPL and COIN stock tokens on Robinhood Chain and compare against Chainlink feeds."],
  ["morgue", "Compare the newsroom Morgue against live Robinhood Chain TVL and top curves today."],
];

const KNOWN_STOCK_TICKERS = new Set([
  "TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "COIN", "HOOD", "SPY", "QQQ", "MSTR", "AMD", "PLTR", "NFLX",
]);

/**
 * Picks the smartest Editorial Desk when a visitor types a bare ticker, 0x address, or freeform question.
 */
export function inferDeskAndQuestion(rawInput, requestedDesk = "") {
  const trimmed = String(rawInput || "").replace(/\s+/g, " ").trim();
  const explicit = DESKS[String(requestedDesk || "").toLowerCase()]?.id || null;

  if (isEvmAddress(trimmed)) {
    const addr = trimmed.toLowerCase();
    return {
      desk: explicit || "curves",
      question: `Inspect Robinhood Chain address ${addr}: contract/wallet kind, Pons curve stats, and holder concentration.`,
      targetAddress: addr,
    };
  }

  const upper = trimmed.toUpperCase().replace(/^\$/, "");
  if (/^[A-Z]{1,6}$/.test(upper) && KNOWN_STOCK_TICKERS.has(upper)) {
    return {
      desk: explicit || "equities",
      question: `Verify official ${upper} stock token price on Robinhood Chain against its live Chainlink oracle and check Pons clones.`,
      targetTicker: upper,
    };
  }

  const low = trimmed.toLowerCase();
  let autoDesk = explicit;
  if (!autoDesk) {
    if (/fake|clone|impersonat|whale|concentrat|stablecoin|peg|risk/.test(low)) autoDesk = "risk";
    else if (/oracle|stock|equity|tsla|nvda|aapl|coin|hood|spy|mstr/.test(low)) autoDesk = "equities";
    else if (/tvl|defi|morpho|lending|dex|volume|fee/.test(low)) autoDesk = "defi";
    else if (/wallet|bytecode|nonce|transfer|rpc/.test(low)) autoDesk = "chain";
    else if (/morgue|changed|yesterday|earlier|memory|archive/.test(low)) autoDesk = "morgue";
    else autoDesk = "curves";
  }

  return {
    desk: autoDesk,
    question: trimmed.length >= 12 ? trimmed : `Wire check on "${trimmed}" across Robinhood Chain sources.`,
  };
}

export function cleanEntityTags(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "-"))
        .filter((s) => s.length >= 2 && s.length <= 42)
    ),
  ].slice(0, 6);
}

/**
 * Helper that finds an exact `"key":value` substring inside `rawJson` so deterministic findings
 * always cite verbatim JSON bytes from the step payload.
 */
function pickExactSnippet(rawJson, key, value) {
  if (value === undefined || value === null) return null;
  const candidates = [
    `"${key}":${JSON.stringify(value)}`,
    `"${key}": ${JSON.stringify(value)}`,
  ];
  for (const c of candidates) {
    if (rawJson.includes(c)) return c;
  }
  const valStr = String(value);
  if (valStr.length >= 3 && rawJson.includes(valStr)) return valStr;
  return null;
}

/**
 * Executes a real, live Robinhood Chain dispatch deterministically and records every step & verified finding.
 */
export async function runDeterministicDispatch(ctx, { desk = "curves", question = "", logStep, saveFinding }) {
  const qLow = question.toLowerCase();
  const addrMatch = question.match(/0x[0-9a-fA-F]{40}/);
  const tickerMatches = [...question.toUpperCase().matchAll(/\b(TSLA|NVDA|AAPL|MSFT|AMZN|GOOGL|META|COIN|HOOD|SPY|QQQ|MSTR|AMD|PLTR)\b/g)].map((m) => m[1]);
  const uniqTickers = [...new Set(tickerMatches)];

  const bullets = [];
  let wiredCount = 0;

  async function callAndRecord(toolName, why, args) {
    await logStep("call", toolName, { why, input: args });
    try {
      const data = await runWireTool(ctx, toolName, { why, ...args });
      const rawJson = JSON.stringify(data);
      const stepNum = await logStep("result", toolName, rawJson.slice(0, 20000));
      return { ok: true, data, rawJson, stepNum, sourceUrl: data?.source || null };
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 240);
      await logStep("error", toolName, msg);
      return { ok: false, error: msg };
    }
  }

  async function tryFile(stepRes, claim, key, val, entities) {
    if (!stepRes?.ok) return;
    const ev = pickExactSnippet(stepRes.rawJson, key, val);
    if (!ev) return;
    const check = checkEvidence(stepRes.rawJson, ev);
    const status = check.ok ? "verified" : "unverified";
    const cleanEnts = cleanEntityTags(entities);
    const fStep = await logStep("finding", null, {
      claim,
      evidence: ev,
      cites: stepRes.stepNum,
      status,
      stamp: check.stamp,
      check: check.why,
      entities: cleanEnts,
    });
    await saveFinding({
      step: fStep,
      claim,
      evidence: ev,
      sourceUrl: stepRes.sourceUrl,
      status,
      entities: cleanEnts,
    });
    if (status === "verified") {
      wiredCount += 1;
      bullets.push(claim);
    }
  }

  // Always check the newsroom Morgue first so dispatches connect across time
  const searchTerms = addrMatch ? addrMatch[0].slice(0, 10) : uniqTickers[0] || desk;
  await callAndRecord("morgue_search", "Check newsroom Morgue for prior verified clippings on this subject.", {
    query: searchTerms,
    limit: 5,
  });

  if (addrMatch) {
    const addr = addrMatch[0].toLowerCase();
    const acct = await callAndRecord("account_info", `Inspect ${addr.slice(0, 10)}… on Robinhood Chain RPC.`, { address: addr });
    if (acct.ok) {
      await tryFile(
        acct,
        `Address ${addr.slice(0, 10)}… is an onchain ${acct.data.kind} holding ${acct.data.eth_balance} ETH (${acct.data.transactions_sent} tx sent).`,
        "eth_balance",
        acct.data.eth_balance,
        [addr.slice(0, 10), acct.data.kind]
      );
    }

    if (acct.ok && acct.data.kind === "contract") {
      const [pons, holders] = await Promise.all([
        callAndRecord("pons_token", `Fetch Pons / Sherwood curve telemetry for ${addr.slice(0, 10)}….`, { address: addr }),
        callAndRecord("token_holders", `Read onchain supply and top holder concentration for ${addr.slice(0, 10)}….`, { address: addr }),
      ]);
      if (pons.ok && pons.data.symbol) {
        const sym = String(pons.data.symbol);
        if (pons.data.market_cap_usd != null) {
          await tryFile(
            pons,
            `${sym} (${addr.slice(0, 8)}…) is at stage "${pons.data.stage}" with $${pons.data.market_cap_usd.toLocaleString("en-US")} market cap${pons.data.curve_progress_pct != null ? ` (${pons.data.curve_progress_pct}% curve progress)` : ""}.`,
            "market_cap_usd",
            pons.data.market_cap_usd,
            [sym.toLowerCase(), addr.slice(0, 10), "pons"]
          );
        }
        if (pons.data.volume_usd != null) {
          await tryFile(
            pons,
            `${sym} logged $${pons.data.volume_usd.toLocaleString("en-US")} trading volume${pons.data.creator_tax_bps != null ? ` with ${pons.data.creator_tax_bps} bps creator fee` : ""}.`,
            "volume_usd",
            pons.data.volume_usd,
            [sym.toLowerCase(), "pons"]
          );
        }
      }
      if (holders.ok) {
        if (holders.data.top10_share_pct != null) {
          await tryFile(
            holders,
            `Top 10 wallets hold ${holders.data.top10_share_pct}% of ${addr.slice(0, 8)}… (${holders.data.top10_unlabeled_share_pct}% unlabeled across ${holders.data.holders} holders).`,
            "top10_share_pct",
            holders.data.top10_share_pct,
            [addr.slice(0, 10), "holders"]
          );
        } else if (holders.data.supply != null) {
          await tryFile(
            holders,
            `Contract ${addr.slice(0, 10)}… has verified total supply of ${holders.data.supply.toLocaleString("en-US")} tokens (${holders.data.decimals} decimals).`,
            "supply",
            holders.data.supply,
            [addr.slice(0, 10), "rpc"]
          );
        }
      }
    } else {
      const act = await callAndRecord("wallet_activity", `Scan recent ERC-20 transfers for wallet ${addr.slice(0, 10)}….`, {
        address: addr,
        limit: 12,
      });
      if (act.ok) {
        await tryFile(
          act,
          `Wallet ${addr.slice(0, 10)}… executed ${act.data.transfers} ERC-20 transfers across ${act.data.tokens_touched} tokens in the last ${act.data.window_blocks} blocks.`,
          "transfers",
          act.data.transfers,
          [addr.slice(0, 10), "wallet"]
        );
      }
    }
  } else if (desk === "equities" || uniqTickers.length > 0) {
    const syms = uniqTickers.length ? uniqTickers.slice(0, 2) : ["TSLA", "NVDA"];
    for (const sym of syms) {
      const ora = await callAndRecord("stock_oracle", `Compare official ${sym} Robinhood stock token against live Chainlink feed.`, {
        symbol: sym,
      });
      if (ora.ok) {
        if (ora.data.oracle?.price_usd != null) {
          await tryFile(
            ora,
            `Official ${sym} Chainlink feed reads $${ora.data.oracle.price_usd}${ora.data.token_price_usd != null ? ` vs token price $${ora.data.token_price_usd} (${ora.data.token_vs_oracle_pct}% spread)` : ` (multiplier ${ora.data.multiplier}x)`}.`,
            "price_usd",
            ora.data.oracle.price_usd,
            [sym.toLowerCase(), "chainlink", "equities"]
          );
        }
      }
      if (/fake|clone|unofficial|pons/.test(qLow)) {
        const srch = await callAndRecord("token_search", `Check Pons / Sherwood for unofficial ${sym} ticker clones.`, { query: sym });
        if (srch.ok && Array.isArray(srch.data.pons_launches)) {
          const topClone = srch.data.pons_launches[0];
          if (topClone?.address) {
            await tryFile(
              srch,
              `Pons search for "${sym}" surfaced ${srch.data.pons_launches.length} launchpad tokens (largest ${topClone.symbol} at ${topClone.address.slice(0, 10)}… with $${(topClone.market_cap_usd || 0).toLocaleString("en-US")} mcap).`,
              "address",
              topClone.address,
              [sym.toLowerCase(), "clones", "pons"]
            );
          }
        }
      }
    }
  } else if (desk === "defi") {
    const [protos, vol] = await Promise.all([
      callAndRecord("chain_protocols", "Rank Robinhood Chain DeFi protocols by chain TVL.", { limit: 10 }),
      callAndRecord("chain_volume", "Read 24h and 7d DEX trading volume on Robinhood Chain.", { kind: "dexs", limit: 8 }),
    ]);
    if (protos.ok && protos.data.tvl_sum_usd != null) {
      await tryFile(
        protos,
        `Robinhood Chain tracks ${protos.data.protocols_counted} active DeFi protocols summing $${protos.data.tvl_sum_usd.toLocaleString("en-US")} in chain TVL.`,
        "tvl_sum_usd",
        protos.data.tvl_sum_usd,
        ["robinhood-chain", "tvl", "defi"]
      );
      const lead = protos.data.protocols?.[0];
      if (lead?.chain_tvl_usd != null) {
        await tryFile(
          protos,
          `${lead.name} leads Robinhood Chain TVL at $${lead.chain_tvl_usd.toLocaleString("en-US")} (${lead.category}).`,
          "chain_tvl_usd",
          lead.chain_tvl_usd,
          [lead.slug || lead.name.toLowerCase(), "tvl"]
        );
      }
    }
    if (vol.ok && vol.data.total_24h_usd != null) {
      await tryFile(
        vol,
        `Robinhood Chain DEXs cleared $${vol.data.total_24h_usd.toLocaleString("en-US")} in 24h volume ($${(vol.data.total_7d_usd || 0).toLocaleString("en-US")} over 7d).`,
        "total_24h_usd",
        vol.data.total_24h_usd,
        ["dex-volume", "robinhood-chain"]
      );
    }
  } else if (desk === "risk" && /stable/i.test(qLow)) {
    const st = await callAndRecord("chain_stablecoins", "Audit circulating stablecoin supply on Robinhood Chain.", { limit: 8 });
    if (st.ok && st.data.total_on_chain != null) {
      await tryFile(
        st,
        `Total circulating stablecoin supply on Robinhood Chain stands at $${st.data.total_on_chain.toLocaleString("en-US")}.`,
        "total_on_chain",
        st.data.total_on_chain,
        ["stablecoins", "robinhood-chain"]
      );
      const top = st.data.assets?.[0];
      if (top?.on_chain != null) {
        await tryFile(
          st,
          `${top.symbol} (${top.name}) leads chain stablecoins with $${top.on_chain.toLocaleString("en-US")} circulating at $${top.price}.`,
          "on_chain",
          top.on_chain,
          [top.symbol.toLowerCase(), "stablecoins"]
        );
      }
    }
  } else if (desk === "risk") {
    const srch = await callAndRecord("token_search", "Scan Pons / Sherwood for unofficial TSLA ticker look-alikes.", { query: "TSLA" });
    const stocks = await callAndRecord("stock_tokens", "Confirm official TSLA contract on Robinhood registry.", { query: "TSLA", limit: 3 });
    if (stocks.ok && stocks.data.tokens?.[0]) {
      const t = stocks.data.tokens[0];
      await tryFile(
        stocks,
        `Official Robinhood ${t.symbol} token contract is ${t.address} across ${stocks.data.total_listed} registered equities.`,
        "address",
        t.address,
        ["tsla", "equities", "registry"]
      );
    }
    if (srch.ok && srch.data.pons_launches?.length) {
      const c = srch.data.pons_launches[0];
      if (c.market_cap_usd != null) {
        await tryFile(
          srch,
          `Unofficial Pons token "${c.symbol}" (${c.address.slice(0, 10)}…) trades separately at $${c.market_cap_usd.toLocaleString("en-US")} market cap.`,
          "market_cap_usd",
          c.market_cap_usd,
          ["tsla", "clones", "pons"]
        );
      }
    }
  } else {
    // Curves & Morgue default live sweep
    const launches = await callAndRecord("pons_launches", "Pull active Pons bonding curves on Robinhood Chain.", {
      sort: /new/i.test(qLow) ? "new" : "trending",
      limit: 8,
    });
    if (launches.ok && launches.data.launches?.length) {
      const top = launches.data.launches[0];
      if (top.market_cap_usd != null) {
        await tryFile(
          launches,
          `Lead Pons launch ${top.symbol} (${top.address.slice(0, 10)}…) sits at $${top.market_cap_usd.toLocaleString("en-US")} mcap${top.curve_progress_pct != null ? ` and ${top.curve_progress_pct}% curve progress` : ""}.`,
          "market_cap_usd",
          top.market_cap_usd,
          [(top.symbol || "pons").toLowerCase(), "pons", "curves"]
        );
      }
      const second = launches.data.launches[1];
      if (second?.volume_usd != null) {
        await tryFile(
          launches,
          `Runner-up ${second.symbol} (${second.address.slice(0, 10)}…) recorded $${second.volume_usd.toLocaleString("en-US")} volume.`,
          "volume_usd",
          second.volume_usd,
          [(second.symbol || "pons").toLowerCase(), "curves"]
        );
      }
    }
  }

  const deskMeta = DESKS[desk] || DESKS.curves;
  const leadLine = bullets[0]
    ? `ROBINHOOD CHAIN (${deskMeta.code} DESK) — ${bullets[0]}`
    : `ROBINHOOD CHAIN (${deskMeta.code} DESK) — Live wire check completed; external feed returned no matching numeric figure for this query.`;
  const restLines = bullets.slice(1).map((b) => `- ${b}`);
  const report = [leadLine, ...restLines, "--30--"].join("\n");

  await logStep("report", null, report);
  return { report, wiredCount, tokensIn: 0, tokensOut: 0 };
}
