/**
 * Live Read-Only Robinhood Chain (4663) Research Tools for WireCopy Desks.
 * Every tool returns structured JSON with an explicit `source` URL so `checkEvidence`
 * can verify quoted figures character-by-character before anything goes `ON THE WIRE`.
 * Zero private keys, zero wallet signatures, zero state-changing calls.
 */

import { RH_CHAIN_ID, RH_DEFAULT_RPC, isEvmAddress, rhRpcCall } from "./verifier.js";

const LLAMA = "https://api.llama.fi";
const COINS = "https://coins.llama.fi";
const PONS = "https://ponsfamily.com/api/launches";
const PONS_BALANCES = "https://balancesapi.ponsfamily.com/v1";
const SHERWOOD = "https://api.sherwood.stream/v1/public";
const REGISTRY = "https://api.robinhood.com/rhj/assets";
const FEEDS = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const CHAIN = "Robinhood Chain";
const CHAIN_URL = encodeURIComponent(CHAIN);
const UA = { "user-agent": "wirecopy-desk/1.0", accept: "application/json" };

const round = (n, d = 2) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const usd = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const clampInt = (v, lo, hi, dflt) =>
  Math.min(hi, Math.max(lo, v != null && v !== "" && Number.isFinite(+v) ? Math.floor(+v) : dflt));

export class WireToolError extends Error {}
const bad = (msg) => {
  throw new WireToolError(msg);
};

const memCache = new Map();

async function withCache(ctx, key, ttlMs, loader) {
  const now = Date.now();
  if (ctx?.cacheGet) {
    const hit = await ctx.cacheGet(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
  } else {
    const hit = memCache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
  }
  const value = await loader();
  if (ctx?.cacheSet) {
    await ctx.cacheSet(key, value, now);
  } else {
    memCache.set(key, { value, at: now });
  }
  return value;
}

async function fetchJson(url, ctx = {}, retries = 2) {
  const f = ctx.fetchImpl || fetch;
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const r = await f(url, { headers: UA });
    if (r.ok) return r.json();
    if (attempt < retries && (r.status === 429 || r.status >= 500)) {
      await new Promise((res) => setTimeout(res, attempt ? 2200 : 800));
      continue;
    }
    if (r.status === 429) {
      bad(`${host} is rate-limiting WireCopy right now; switch sources or report unavailable.`);
    }
    bad(`${host} answered HTTP ${r.status}`);
  }
}

const rpc = (ctx, method, params) => rhRpcCall(ctx?.rpcUrl || RH_DEFAULT_RPC, method, params, ctx?.fetchImpl || fetch);
const ethCall = (ctx, to, data) => rpc(ctx, "eth_call", [{ to, data }, "latest"]);
const word = (hex, i) => BigInt("0x" + ((hex || "0x").slice(2 + i * 64, 2 + (i + 1) * 64) || "0"));
const units = (raw, dec) => Number(raw) / 10 ** dec;
const topicAddr = (a) => "0x" + a.slice(2).padStart(64, "0");
const mustAddr = (v, what = "address") => (isEvmAddress(v) ? v.trim().toLowerCase() : bad(`${what} must be a 0x EVM address`));

const stockRegistry = (ctx) =>
  withCache(ctx, "rh:stocks", 30 * 60000, async () => {
    const { assets } = await fetchJson(REGISTRY, ctx);
    return (assets || [])
      .filter((a) => a.status === "ASSET_STATUS_ACTIVE")
      .flatMap((a) =>
        (a.deployments || [])
          .filter((d) => d.chainId === RH_CHAIN_ID)
          .map((d) => ({
            symbol: a.tokenSymbol,
            name: String(a.tokenName || "").replace(/\s*•\s*Robinhood Token$/, ""),
            address: d.contractAddress.toLowerCase(),
            multiplier: Number(a.currentMultiplier) || 1,
            isin: a.isin || undefined,
          }))
      );
  });

const chainlinkFeeds = (ctx) =>
  withCache(ctx, "rh:feeds", 6 * 3600000, async () =>
    (await fetchJson(FEEDS, ctx))
      .filter((f) => f.proxyAddress)
      .map((f) => ({ name: f.name, proxy: f.proxyAddress, decimals: f.decimals ?? 8 }))
  );

async function readOracle(ctx, f) {
  const hex = await ethCall(ctx, f.proxy, "0xfeaf968c");
  return {
    feed: f.name,
    oracle_address: f.proxy,
    price_usd: round(units(word(hex, 1), f.decimals), 4),
    updated: new Date(Number(word(hex, 3)) * 1000).toISOString(),
  };
}

function normalizeLaunchRow(x) {
  const prog = x.progress ?? x.curveProgress ?? (x.graduated ? 1 : null);
  const createdTs =
    typeof x.createdAt === "number"
      ? x.createdAt > 1e12
        ? x.createdAt / 1000
        : x.createdAt
      : x.createdAt
        ? Date.parse(x.createdAt) / 1000
        : null;
  return {
    address: String(x.address || x.tokenAddress || "").toLowerCase(),
    name: x.name,
    symbol: x.symbol,
    stage: x.stage || (x.graduated ? "graduated" : "curve"),
    curve_progress_pct: prog != null ? round(prog <= 1 ? prog * 100 : prog, 1) : null,
    price_usd: x.priceUsd != null ? Number(x.priceUsd) : null,
    market_cap_usd: usd(Number(x.marketCapUsd ?? x.mcapUsd)),
    volume_usd: usd(Number(x.volumeUsd ?? x.volume24hUsd)),
    trades: x.tradeCount ?? x.txCount ?? null,
    age_hours: createdTs ? round((Date.now() / 1000 - createdTs) / 3600, 1) : null,
    creator_tax_bps: x.creatorTaxBps ?? null,
    deployer: x.deployer || x.creator || null,
  };
}

async function llamaPrices(ctx, addrs) {
  const keys = addrs.map((a) => `robinhood:${a}`).join(",");
  const [now, d1] = await Promise.all([
    withCache(ctx, "ll:now:" + keys, 5 * 60000, () => fetchJson(`${COINS}/prices/current/${keys}`, ctx)),
    withCache(ctx, "ll:pct:" + keys, 5 * 60000, () => fetchJson(`${COINS}/percentage/${keys}?period=24h`, ctx)).catch(() => ({})),
  ]);
  const low = (o) => Object.fromEntries(Object.entries(o?.coins || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const n = low(now);
  const p = low(d1);
  return Object.fromEntries(
    addrs.map((a) => [
      a,
      n[`robinhood:${a}`] ? { ...n[`robinhood:${a}`], change_24h_pct: round(p[`robinhood:${a}`]) } : null,
    ])
  );
}

const TOOLS = {
  async stock_tokens(ctx, { query, limit }) {
    const all = await stockRegistry(ctx);
    const q = String(query || "").trim().toLowerCase();
    const rows = q
      ? all.filter((t) => t.symbol.toLowerCase() === q || t.name.toLowerCase().includes(q) || t.address === q)
      : all;
    const page = rows.slice(0, clampInt(limit, 1, 30, 20));
    const px = page.length ? await llamaPrices(ctx, page.map((t) => t.address)).catch(() => ({})) : {};
    return {
      source: REGISTRY,
      note: "Official Robinhood tokenized equities list on chain 4663. Any matching ticker absent from this list is an unofficial token.",
      total_listed: all.length,
      matches: rows.length,
      tokens: page.map((t) => ({
        ...t,
        price_usd: px[t.address]?.price ?? null,
        change_24h_pct: px[t.address]?.change_24h_pct ?? null,
      })),
    };
  },

  async stock_oracle(ctx, { symbol }) {
    const s = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z0-9.]{1,10}$/.test(s)) bad('give a stock ticker, e.g. "TSLA"');
    const [all, list] = await Promise.all([stockRegistry(ctx), chainlinkFeeds(ctx)]);
    const t = all.find((x) => x.symbol.toUpperCase() === s);
    if (!t) bad(`${s} is not on the official Robinhood stock token registry`);
    const f = list.find((x) => x.name.toUpperCase() === `ROBINHOOD ${s} / USD`);
    const [px, o] = await Promise.all([
      llamaPrices(ctx, [t.address]).catch(() => ({})),
      f ? readOracle(ctx, f).catch(() => null) : null,
    ]);
    const price = px[t.address]?.price ?? null;
    return {
      source: `${FEEDS} + Robinhood Chain RPC latestRoundData + ${COINS}`,
      symbol: s,
      name: t.name,
      token: t.address,
      multiplier: t.multiplier,
      token_price_usd: price,
      oracle: o || "no Chainlink feed for this ticker",
      token_vs_oracle_pct: price && o?.price_usd ? round((price / o.price_usd - 1) * 100, 3) : null,
      note: "US equity venues close overnight and weekends; multiplier > 1 reflects corporate actions or dividend adjustments.",
    };
  },

  async price_feeds(ctx, { query }) {
    const list = await chainlinkFeeds(ctx);
    const q = String(query || "").trim().toLowerCase();
    const pick = (q ? list.filter((f) => f.name.toLowerCase().includes(q)) : list).slice(0, 12);
    const rows = await Promise.all(
      pick.map((f) => readOracle(ctx, f).catch(() => ({ feed: f.name, oracle_address: f.proxy, price_usd: null })))
    );
    return {
      source: `${FEEDS} + Robinhood Chain RPC latestRoundData`,
      total_feeds: list.length,
      feeds: rows,
    };
  },

  async chain_protocols(ctx, { category, limit }) {
    const all = await withCache(ctx, "llama:protocols:rh", 30 * 60000, async () => {
      const list = await fetchJson(`${LLAMA}/protocols`, ctx);
      return list
        .filter((p) => p.chainTvls && p.chainTvls[CHAIN] > 0 && p.category !== "CEX")
        .map((p) => ({
          name: p.name,
          slug: p.slug,
          category: p.category,
          chain_tvl_usd: usd(p.chainTvls[CHAIN]),
          total_tvl_usd: usd(p.tvl),
          change_1d_pct: round(p.change_1d),
          change_7d_pct: round(p.change_7d),
        }))
        .sort((a, b) => b.chain_tvl_usd - a.chain_tvl_usd);
    });
    const rows = category ? all.filter((p) => (p.category || "").toLowerCase() === String(category).toLowerCase()) : all;
    const total = all.reduce((t, p) => t + (p.chain_tvl_usd || 0), 0);
    return {
      source: `${LLAMA}/protocols`,
      protocols_counted: all.length,
      tvl_sum_usd: usd(total),
      categories: [...new Set(all.map((p) => p.category))].slice(0, 30),
      protocols: rows.slice(0, clampInt(limit, 1, 40, 15)),
    };
  },

  async protocol_detail(ctx, { slug, days }) {
    const s = String(slug || "").toLowerCase();
    if (!/^[a-z0-9.-]{2,60}$/.test(s)) bad("invalid protocol slug");
    const p = await fetchJson(`${LLAMA}/protocol/${s}`, ctx);
    const d = clampInt(days, 7, 365, 30);
    const series = (p.chainTvls?.[CHAIN]?.tvl || p.tvl || [])
      .slice(-d - 1)
      .map((x) => ({ date: day(x.date), tvl_usd: usd(x.totalLiquidityUSD) }));
    return {
      source: `${LLAMA}/protocol/${s}`,
      name: p.name,
      category: p.category,
      url: p.url,
      chain_tvl_history: series,
    };
  },

  async chain_tvl_history(ctx, { days }) {
    const d = clampInt(days, 7, 730, 90);
    const url = `${LLAMA}/v2/historicalChainTvl/${CHAIN_URL}`;
    const rows = (await fetchJson(url, ctx)).filter((x) => x.tvl > 0);
    const series = rows.slice(-d - 1).map((x) => ({ date: day(x.date), tvl_usd: usd(x.tvl) }));
    return {
      source: url,
      first: series[0],
      last: series.at(-1),
      change_pct: series.length >= 2 ? round((series.at(-1).tvl_usd / series[0].tvl_usd - 1) * 100) : 0,
      series,
    };
  },

  async chain_volume(ctx, { kind, limit }) {
    const k = kind === "fees" ? "fees" : "dexs";
    const url = `${LLAMA}/overview/${k}/${CHAIN_URL}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
    const o = await withCache(ctx, `llama:${k}:rh`, 30 * 60000, async () => {
      const j = await fetchJson(url, ctx);
      return {
        total_24h_usd: usd(j.total24h),
        total_7d_usd: usd(j.total7d),
        total_30d_usd: usd(j.total30d),
        change_1d_pct: round(j.change_1d),
        change_7d_pct: round(j.change_7d),
        protocols: (j.protocols || [])
          .filter((p) => p.total24h > 0)
          .sort((a, b) => b.total24h - a.total24h)
          .slice(0, 30)
          .map((p) => ({
            name: p.displayName || p.name,
            category: p.category,
            total_24h_usd: usd(p.total24h),
            total_7d_usd: usd(p.total7d),
          })),
      };
    });
    return {
      source: url,
      metric: k === "fees" ? "fees paid by users" : "DEX trading volume",
      ...o,
      protocols: o.protocols.slice(0, clampInt(limit, 1, 30, 12)),
    };
  },

  async chain_stablecoins(ctx, { limit }) {
    const url = "https://stablecoins.llama.fi/stablecoins?includePrices=true";
    const rows = await withCache(ctx, "llama:stables:rh", 30 * 60000, async () => {
      const j = await fetchJson(url, ctx);
      const val = (o) => (o ? Object.values(o)[0] : 0) || 0;
      return (j.peggedAssets || [])
        .map((a) => ({
          name: a.name,
          symbol: a.symbol,
          price: round(a.price, 4),
          on_chain: usd(val(a.chainCirculating?.[CHAIN]?.current)),
          on_chain_7d_ago: usd(val(a.chainCirculating?.[CHAIN]?.circulatingPrevWeek)),
        }))
        .filter((a) => a.on_chain > 10000)
        .sort((a, b) => b.on_chain - a.on_chain);
    });
    const total = rows.reduce((t, a) => t + a.on_chain, 0);
    return {
      source: url,
      total_on_chain: usd(total),
      assets: rows.slice(0, clampInt(limit, 1, 25, 10)),
    };
  },

  async pons_launches(ctx, { sort, limit }) {
    const s = ["new", "trending", "volume"].includes(sort) ? sort : "trending";
    const n = clampInt(limit, 1, 30, 12);
    try {
      const url = `${PONS}?sort=${s}`;
      const j = await withCache(ctx, "pons:list:" + s, 3 * 60000, () => fetchJson(url, ctx, 1));
      return { source: url, sort: s, launches: (j.items || []).slice(0, n).map(normalizeLaunchRow) };
    } catch {
      const swUrl = `${SHERWOOD}/tokens/search?q=a`;
      const sw = await fetchJson(swUrl, ctx, 1);
      const items = sw.tokens || sw.items || sw.data || [];
      return { source: swUrl, sort: s, launches: items.slice(0, n).map(normalizeLaunchRow) };
    }
  },

  async pons_token(ctx, { address: a0 }) {
    const a = mustAddr(a0, "token");
    try {
      const url = `${PONS}/${a}`;
      const p = await withCache(ctx, "pons:tok:" + a, 3 * 60000, () => fetchJson(url, ctx, 1));
      return {
        source: url,
        ...normalizeLaunchRow(p),
        description: String(p.description || "").slice(0, 300),
        curve: p.curve || null,
        pool: p.pool || null,
        buyback_enabled: !!p.buybackEnabled,
        socials: p.socials || null,
      };
    } catch {
      const swUrl = `${SHERWOOD}/tokens/search?q=${a}`;
      const sw = await fetchJson(swUrl, ctx, 1);
      const items = sw.tokens || sw.items || sw.data || [];
      const hit = items.find((t) => String(t.address || t.tokenAddress || "").toLowerCase() === a) || items[0];
      if (!hit) bad(`Token ${a} not found on Pons or Sherwood`);
      return { source: swUrl, ...normalizeLaunchRow(hit), description: String(hit.description || "").slice(0, 300) };
    }
  },

  async token_search(ctx, { query }) {
    const q = String(query || "").trim().slice(0, 42);
    if (q.length < 2) bad("query must be at least 2 characters");
    const low = q.toLowerCase();
    const stocks = await stockRegistry(ctx)
      .then((list) => list.filter((t) => t.symbol.toLowerCase() === low || t.name.toLowerCase().includes(low) || t.address === low).slice(0, 5))
      .catch(() => []);
    let launches = [];
    let launchSource = `${SHERWOOD}/tokens/search?q=${encodeURIComponent(q)}`;
    try {
      const sw = await withCache(ctx, "sw:q:" + low, 3 * 60000, () => fetchJson(launchSource, ctx, 1));
      const items = sw.tokens || sw.items || sw.data || [];
      launches = items.slice(0, 8).map(normalizeLaunchRow);
    } catch {
      launchSource = `${PONS}?q=${encodeURIComponent(q)}`;
      const j = await fetchJson(launchSource, ctx, 1).catch(() => ({ items: [] }));
      launches = (j.items || []).slice(0, 8).map(normalizeLaunchRow);
    }
    return {
      source: `${REGISTRY} + ${launchSource}`,
      note: "Official Robinhood stock tokens appear under stock_tokens; Pons launchpad tokens appear under pons_launches.",
      stock_tokens: stocks,
      pons_launches: launches,
    };
  },

  async token_pairs(ctx, { address: a0 }) {
    const a = mustAddr(a0, "token");
    const url = `https://api.dexscreener.com/tokens/v1/robinhood/${a}`;
    try {
      const pairs = await withCache(ctx, "ds:" + a, 3 * 60000, () => fetchJson(url, ctx, 1));
      const rows = (Array.isArray(pairs) ? pairs : [])
        .sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))
        .slice(0, 8);
      if (!rows.length) throw new Error("empty pairs");
      const self = rows[0].baseToken?.address?.toLowerCase() === a ? rows[0].baseToken : rows[0].quoteToken;
      return {
        source: url,
        token: self ? { name: self.name, symbol: self.symbol, address: a } : { address: a },
        pairs: rows.map((p) => ({
          dex: p.dexId,
          pair: p.pairAddress,
          quote: p.quoteToken?.symbol,
          price_usd: p.priceUsd,
          liquidity_usd: usd(p.liquidity?.usd),
          volume_24h_usd: usd(p.volume?.h24),
          txns_24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
          buys_24h: p.txns?.h24?.buys,
          sells_24h: p.txns?.h24?.sells,
          market_cap_usd: usd(p.marketCap),
        })),
      };
    } catch {
      return TOOLS.pons_token(ctx, { address: a });
    }
  },

  async token_price(ctx, { addresses }) {
    const list = (Array.isArray(addresses) ? addresses : String(addresses || "").split(","))
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => isEvmAddress(s))
      .slice(0, 15);
    if (!list.length) bad("give at least one 0x token address");
    const px = await llamaPrices(ctx, list).catch(() => ({}));
    const out = await Promise.all(
      list.map(async (a) => {
        if (px[a]) {
          return {
            address: a,
            symbol: px[a].symbol,
            price_usd: px[a].price,
            change_24h_pct: px[a].change_24h_pct,
            source: "defillama",
          };
        }
        const p = await TOOLS.pons_token(ctx, { address: a }).catch(() => null);
        return p?.price_usd != null
          ? { address: a, symbol: p.symbol, price_usd: p.price_usd, source: "pons" }
          : { address: a, price_usd: null, note: "no price indexed yet" };
      })
    );
    return { source: `${COINS}/prices/current`, prices: out };
  },

  async token_holders(ctx, { address: a0 }) {
    const a = mustAddr(a0, "token");
    const [supplyHex, decHex] = await Promise.all([ethCall(ctx, a, "0x18160ddd"), ethCall(ctx, a, "0x313ce567")]);
    const decimals = Number(word(decHex, 0)) || 18;
    const supply = round(units(word(supplyHex, 0), decimals), 2);
    const url = `${PONS_BALANCES}/tokens/${a}/holders?limit=20`;
    const j = await withCache(ctx, "holders:" + a, 3 * 60000, () => fetchJson(url, ctx, 1)).catch(() => null);
    if (!j?.page) {
      return {
        source: "Robinhood Chain RPC totalSupply + decimals",
        address: a,
        supply,
        decimals,
        note: "Onchain supply verified via RPC; holder breakdown is indexed for Pons launchpad tokens.",
      };
    }
    const top = j.page.map((h, i) => ({
      rank: i + 1,
      wallet: h.wallet,
      label: h.label || undefined,
      amount: round(units(BigInt(h.balance), decimals), 2),
      share_pct: round(h.share * 100, 3),
    }));
    const sum = (n) => round(top.slice(0, n).reduce((t, h) => t + h.share_pct, 0), 2);
    return {
      source: url,
      address: a,
      supply,
      decimals,
      holders: j.holders,
      top1_share_pct: sum(1),
      top10_share_pct: sum(10),
      top10_unlabeled_share_pct: round(
        top
          .filter((h) => !h.label)
          .slice(0, 10)
          .reduce((t, h) => t + h.share_pct, 0),
        2
      ),
      top,
    };
  },

  async account_info(ctx, { address: a0 }) {
    const a = mustAddr(a0);
    const [code, bal, nonce] = await Promise.all([
      rpc(ctx, "eth_getCode", [a, "latest"]),
      rpc(ctx, "eth_getBalance", [a, "latest"]),
      rpc(ctx, "eth_getTransactionCount", [a, "latest"]),
    ]);
    const isContract = Boolean(code && code !== "0x");
    const out = {
      source: "Robinhood Chain RPC eth_getCode + eth_getBalance + eth_getTransactionCount",
      address: a,
      kind: isContract ? "contract" : "wallet",
      eth_balance: round(units(BigInt(bal || "0x0"), 18), 5),
      transactions_sent: parseInt(nonce || "0x0", 16),
      code_bytes: isContract ? (code.length - 2) / 2 : 0,
      explorer: `https://robinhoodchain.blockscout.com/address/${a}`,
    };
    if (isContract) {
      const stock = await stockRegistry(ctx)
        .then((list) => list.find((t) => t.address === a))
        .catch(() => null);
      if (stock) out.stock_token = stock;
    }
    return out;
  },

  async wallet_activity(ctx, { address: a0, limit }) {
    const a = mustAddr(a0);
    const tip = parseInt(await rpc(ctx, "eth_blockNumber", []), 16);
    const span = 10000;
    const slices = [...Array(4).keys()].map((i) => [tip - span * (i + 1) + 1, tip - span * i]);
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const scan = async (topics) =>
      (
        await Promise.all(
          slices.map(([f, t]) =>
            rpc(ctx, "eth_getLogs", [
              { fromBlock: "0x" + Math.max(0, f).toString(16), toBlock: "0x" + t.toString(16), topics },
            ]).catch(() => [])
          )
        )
      ).flat();
    const [out, inn] = await Promise.all([scan([TRANSFER, topicAddr(a)]), scan([TRANSFER, null, topicAddr(a)])]);
    const rows = [...out.map((l) => ({ l, dir: "out" })), ...inn.map((l) => ({ l, dir: "in" }))]
      .filter(({ l }) => (l.topics || []).length === 3)
      .sort((x, y) => parseInt(y.l.blockNumber, 16) - parseInt(x.l.blockNumber, 16));
    const tokens = {};
    for (const { l, dir } of rows) {
      const t = (tokens[l.address.toLowerCase()] ||= { in: 0, out: 0 });
      t[dir] += 1;
    }
    return {
      source: "Robinhood Chain RPC eth_getLogs (ERC-20 Transfer)",
      address: a,
      window_blocks: span * slices.length,
      transfers: rows.length,
      tokens_touched: Object.keys(tokens).length,
      by_token: Object.entries(tokens)
        .slice(0, 12)
        .map(([token, c]) => ({ token, ...c })),
      latest: rows.slice(0, clampInt(limit, 1, 25, 10)).map(({ l, dir }) => ({
        dir,
        token: l.address,
        tx: l.transactionHash,
        block: parseInt(l.blockNumber, 16),
      })),
    };
  },
};

const WHY_PROP = { type: "string", description: "One crisp editorial reason shown on the public wire tape." };
const def = (name, description, properties, required = []) => ({
  name,
  description,
  input_schema: {
    type: "object",
    properties: { why: WHY_PROP, ...properties },
    required: ["why", ...required],
    additionalProperties: false,
  },
});

export const WIRE_TOOL_DEFS = [
  def("stock_tokens", "Official Robinhood Chain stock & ETF tokens with address, multiplier, price and 24h change.", {
    query: { type: "string" },
    limit: { type: "integer" },
  }),
  def("stock_oracle", "Compare one official stock token by ticker against its live Chainlink oracle price and freshness.", {
    symbol: { type: "string" },
  }, ["symbol"]),
  def("price_feeds", "Read live Chainlink oracle feeds on Robinhood Chain (stocks, ETH, BTC, stablecoins).", {
    query: { type: "string" },
  }),
  def("pons_launches", "Pons launchpad curves sorted by new, trending or volume with curve progress %, market cap and trades.", {
    sort: { type: "string", enum: ["new", "trending", "volume"] },
    limit: { type: "integer" },
  }),
  def("pons_token", "Single Pons token launch details: stage, curve progress %, market cap, volume, creator tax bps, deployer.", {
    address: { type: "string" },
  }, ["address"]),
  def("token_holders", "Onchain totalSupply and top-20 holder concentration (%) for a Robinhood Chain / Pons token.", {
    address: { type: "string" },
  }, ["address"]),
  def("token_pairs", "DexScreener pairs on Robinhood Chain: liquidity, 24h volume, buys/sells, market cap.", {
    address: { type: "string" },
  }, ["address"]),
  def("token_price", "USD price and 24h change of Robinhood Chain tokens by 0x address.", {
    addresses: { type: "array", items: { type: "string" } },
  }, ["addresses"]),
  def("token_search", "Search across official Robinhood stock tokens and Pons/Sherwood launches by ticker, name or 0x address.", {
    query: { type: "string" },
  }, ["query"]),
  def("chain_protocols", "DeFiLlama: Robinhood Chain protocols ranked by TVL with 1d/7d change.", {
    category: { type: "string" },
    limit: { type: "integer" },
  }),
  def("protocol_detail", "DeFiLlama: historical Robinhood Chain TVL for one protocol slug.", {
    slug: { type: "string" },
    days: { type: "integer" },
  }, ["slug"]),
  def("chain_tvl_history", "DeFiLlama: daily total DeFi TVL across Robinhood Chain.", {
    days: { type: "integer" },
  }),
  def("chain_volume", "DeFiLlama: Robinhood Chain 24h/7d DEX trading volume or user fees.", {
    kind: { type: "string", enum: ["dexs", "fees"] },
    limit: { type: "integer" },
  }),
  def("chain_stablecoins", "DeFiLlama: circulating stablecoin supply on Robinhood Chain.", {
    limit: { type: "integer" },
  }),
  def("account_info", "Robinhood Chain RPC: classify 0x address as wallet or contract, ETH balance, code size and tx nonce.", {
    address: { type: "string" },
  }, ["address"]),
  def("wallet_activity", "Robinhood Chain RPC: recent ERC-20 token transfers in/out of an address.", {
    address: { type: "string" },
    limit: { type: "integer" },
  }, ["address"]),
  def("morgue_search", "Search WireCopy's shared newsroom morgue for earlier ON THE WIRE findings.", {
    query: { type: "string" },
    limit: { type: "integer" },
  }, ["query"]),
  def("file_finding", "File one finding to the copy desk. `evidence` MUST be copied verbatim from the cited step output so `checkEvidence` can stamp it ON THE WIRE (`verified`) or SPIKED (`unverified`).", {
    claim: { type: "string", description: "One declarative wire sentence stating the fact and exact figure." },
    evidence: { type: "string", description: "Exact substring copied from the cited step JSON, e.g. \"token_vs_oracle_pct\":0.12" },
    step: { type: "integer", description: "Step number of the cited raw tool output." },
    entities: { type: "array", items: { type: "string" }, description: "Lowercase tickers, protocols or 0x prefixes, e.g. [\"tsla\",\"chainlink\"]." },
  }, ["claim", "evidence", "step", "entities"]),
];

export async function runWireTool(ctx, name, args = {}) {
  if (name === "morgue_search") {
    if (ctx?.morgueSearch) return ctx.morgueSearch(args);
    return { source: "WireCopy Morgue", matches: [] };
  }
  const fn = TOOLS[name];
  if (!fn) throw new WireToolError(`Unknown desk tool: ${name}`);
  const { why: _why, ...cleanArgs } = args || {};
  return fn(ctx, cleanArgs);
}
