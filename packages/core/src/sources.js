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
    const escSym = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const feedRe = new RegExp(`^ROBINHOOD\\s+${escSym}\\s*(?:/\\s*USD|-USD|\\(24/7\\))`, "i");
    const f = list.find((x) => feedRe.test(x.name) && /\(24\/7\)/i.test(x.name)) || list.find((x) => feedRe.test(x.name));
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
    const url = `${PONS_BALANCES}/tokens/${a}/holders?limit=20`;
    const j = await withCache(ctx, "holders:" + a, 90 * 1000, () => fetchJson(url, ctx, 1)).catch(() => null);
    if (!j?.page) {
      const [supplyHex, decHex] = await Promise.all([ethCall(ctx, a, "0x18160ddd"), ethCall(ctx, a, "0x313ce567")]);
      const decimals = Number(word(decHex, 0)) || 18;
      const supply = round(units(word(supplyHex, 0), decimals), 2);
      return {
        source: "Robinhood Chain RPC totalSupply + decimals",
        address: a,
        supply,
        decimals,
        note: "Onchain supply verified via RPC; holder breakdown is indexed for Pons launchpad tokens.",
      };
    }
    const decimals = 18;
    const supply = j.supply ? round(units(BigInt(j.supply), decimals), 2) : 1_000_000_000;
    const burnedUnits = j.burned ? round(units(BigInt(j.burned), decimals), 2) : 0;
    const burnedApiPct = supply > 0 ? round((burnedUnits / supply) * 100, 2) : 0;
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
      burned_pct: burnedApiPct,
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

const BURN_ADDRESSES = new Set([
  "0x000000000000000000000000000000000000dead",
  "0x0000000000000000000000000000000000000000",
]);

function isVaultOrBurnHolder(h, curveAddr, poolAddr) {
  const w = String(h?.wallet || "").toLowerCase();
  if (!w) return false;
  if (BURN_ADDRESSES.has(w)) return true;
  if (curveAddr && w === curveAddr.toLowerCase()) return true;
  if (poolAddr && w === poolAddr.toLowerCase()) return true;
  const lbl = String(h?.label || "").toLowerCase();
  if (lbl && /curve|pool|burn|dead|vault|uniswap|launchpad|pair|lp/.test(lbl)) return true;
  return false;
}

export async function getLiveTrenchRadar(ctx = {}) {
  return withCache(ctx, "radar:live:v1", 60 * 1000, async () => {
    const [trendingRes, newRes, stocks] = await Promise.all([
      TOOLS.pons_launches(ctx, { sort: "trending", limit: 8 }).catch(() => ({ launches: [] })),
      TOOLS.pons_launches(ctx, { sort: "new", limit: 6 }).catch(() => ({ launches: [] })),
      stockRegistry(ctx).catch(() => []),
    ]);
    const stockSymbols = new Map(stocks.map((s) => [s.symbol.toUpperCase(), s]));
    const seen = new Set();
    const items = [];
    for (const row of [...(trendingRes.launches || []), ...(newRes.launches || [])]) {
      if (!row?.address || seen.has(row.address)) continue;
      seen.add(row.address);
      const sym = String(row.symbol || "").toUpperCase();
      const official = stockSymbols.get(sym);
      items.push({
        address: row.address,
        symbol: row.symbol || "TOKEN",
        name: row.name || row.symbol || "Token",
        stage: row.stage,
        curve_progress_pct: row.curve_progress_pct,
        market_cap_usd: row.market_cap_usd,
        volume_usd: row.volume_usd,
        creator_tax_bps: row.creator_tax_bps,
        is_stock_clone: Boolean(official && official.address !== row.address),
      });
      if (items.length >= 8) break;
    }
    return {
      updated_at: Date.now(),
      items,
      presets: [
        { label: "TSLA Clone Audit", query: "TSLA", kind: "clone-check" },
        { label: "NVDA Oracle + Clones", query: "NVDA", kind: "oracle" },
        { label: "TSLA Curve Clone (0xaa55…)", query: "0xaa5565fa0b8dec9914533e8ae2435b85af6088cd", kind: "trap" },
      ],
    };
  });
}

export async function runInstantXray(ctx = {}, rawInput = "") {
  const started = Date.now();
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) bad("Paste a 0x token/wallet address or ticker (e.g. TSLA, NVDA).");

  // Extract 0x address even if user pasted a full Pons / Blockscout / DexScreener URL
  const addrMatch = trimmed.match(/0x[0-9a-fA-F]{40}/);
  const extractedAddr = addrMatch ? addrMatch[0].toLowerCase() : null;

  if (!extractedAddr) {
    // Ticker / symbol mode
    const qUp = trimmed.replace(/^\$/, "").trim().toUpperCase();
    const [stocks, search] = await Promise.all([
      stockRegistry(ctx).catch(() => []),
      TOOLS.token_search(ctx, { query: qUp.length >= 2 ? qUp : trimmed }).catch(() => ({ stock_tokens: [], pons_launches: [] })),
    ]);

    const official = stocks.find((s) => s.symbol.toUpperCase() === qUp);
    const launches = search.pons_launches || [];

    if (official) {
      const clones = launches.filter((l) => l.address && l.address !== official.address);
      const [oracleRes, topCloneHolders] = await Promise.all([
        TOOLS.stock_oracle(ctx, { symbol: official.symbol }).catch(() => null),
        clones[0]?.address ? TOOLS.token_holders(ctx, { address: clones[0].address }).catch(() => null) : Promise.resolve(null),
      ]);

      const spotUsd = oracleRes?.token_price_usd ?? null;
      const oracleUsd = typeof oracleRes?.oracle === "object" ? oracleRes.oracle?.price_usd ?? null : null;
      const spreadPct = oracleRes?.token_vs_oracle_pct ?? null;

      const flags = [];
      if (clones.length > 0) {
        const c0 = clones[0];
        const cHold = topCloneHolders?.top10_unlabeled_share_pct ?? topCloneHolders?.top10_share_pct;
        flags.push({
          severity: "danger",
          text: `${clones.length} unofficial "${official.symbol}" bonding-curve clone(s) found on Pons! Top clone ${c0.address.slice(0, 8)}… has $${(c0.volume_usd || 0).toLocaleString()} vol${cHold != null ? ` & ${cHold}% top-10 hold` : ""}.`,
        });
      } else {
        flags.push({
          severity: "safe",
          text: `Zero active Pons curve clones found matching ${official.symbol} right now.`,
        });
      }
      if (official.multiplier && official.multiplier !== 1) {
        flags.push({
          severity: "info",
          text: `Corporate-action multiplier ${round(official.multiplier, 6)}x active on official token (${official.isin || "ISIN verified"}).`,
        });
      }

      return {
        kind: "stock_ticker",
        elapsed_ms: Date.now() - started,
        query: qUp,
        level: clones.length > 0 ? "warn" : "safe",
        badge: clones.length > 0 ? `OFFICIAL STOCK + ${clones.length} CLONE TRAP(S)` : "OFFICIAL ISIN STOCK",
        title: `${official.name} ($${official.symbol})`,
        address: official.address,
        explorer: `https://robinhoodchain.blockscout.com/address/${official.address}`,
        metrics: [
          { label: "OFFICIAL CONTRACT", value: `${official.address.slice(0, 8)}…${official.address.slice(-6)}`, tone: "safe" },
          { label: "ISIN REGISTRY", value: official.isin || "VERIFIED", tone: "safe" },
          { label: "TOKEN SPOT PRICE", value: spotUsd != null ? `$${spotUsd}` : "—", tone: "neutral" },
          { label: "CHAINLINK ORACLE", value: oracleUsd != null ? `$${oracleUsd}` : "—", tone: "neutral" },
          { label: "ORACLE SPREAD", value: spreadPct != null ? `${spreadPct > 0 ? "+" : ""}${spreadPct}%` : "0.00%", tone: Math.abs(spreadPct || 0) > 1.5 ? "warn" : "safe" },
          { label: "PONS CLONES FOUND", value: String(clones.length), tone: clones.length > 0 ? "danger" : "safe" },
        ],
        flags,
        official_stock: official,
        clones: clones.slice(0, 5),
      };
    }

    // Non-stock ticker -> jump straight into full 0x X-ray of #1 matching Pons launch!
    if (launches.length > 0 && launches[0].address) {
      const xray = await runInstantXray(ctx, launches[0].address);
      xray.other_matches = launches.slice(1, 5);
      return xray;
    }

    bad(`No Robinhood stock token or Pons curve found matching "${trimmed}". Paste a 0x address.`);
  }

  // 0x Address Mode — fast parallel burst across stock registry, Pons, holders & minimal RPC
  const address = extractedAddr;
  const [stocks, pons, holders] = await Promise.all([
    stockRegistry(ctx).catch(() => []),
    TOOLS.pons_token(ctx, { address }).catch(() => null),
    TOOLS.token_holders(ctx, { address }).catch(() => null),
  ]);
  const account = !pons
    ? await TOOLS.account_info(ctx, { address }).catch(() => ({ address, kind: "unknown", eth_balance: 0, transactions_sent: 0 }))
    : { address, kind: "contract", eth_balance: 0, transactions_sent: 0 };
  const pairsRes = !pons && account.kind === "contract" ? await TOOLS.token_pairs(ctx, { address }).catch(() => null) : null;

  const officialExact = stocks.find((s) => s.address === address);
  if (officialExact) {
    const [oracleRes, searchRes] = await Promise.all([
      TOOLS.stock_oracle(ctx, { symbol: officialExact.symbol }).catch(() => null),
      TOOLS.token_search(ctx, { query: officialExact.symbol }).catch(() => ({ pons_launches: [] })),
    ]);
    const clones = (searchRes.pons_launches || []).filter((l) => l.address && l.address !== address);
    const spotUsd = oracleRes?.token_price_usd ?? null;
    const oracleUsd = typeof oracleRes?.oracle === "object" ? oracleRes.oracle?.price_usd ?? null : null;
    const spreadPct = oracleRes?.token_vs_oracle_pct ?? null;

    return {
      kind: "official_stock",
      elapsed_ms: Date.now() - started,
      query: address,
      level: "safe",
      badge: "OFFICIAL ISIN EQUITY TOKEN",
      title: `${officialExact.name} ($${officialExact.symbol})`,
      address,
      explorer: `https://robinhoodchain.blockscout.com/address/${address}`,
      metrics: [
        { label: "ISIN CODE", value: officialExact.isin || "VERIFIED", tone: "safe" },
        { label: "MULTIPLIER", value: `${round(officialExact.multiplier || 1, 6)}x`, tone: "neutral" },
        { label: "TOKEN PRICE", value: spotUsd != null ? `$${spotUsd}` : "—", tone: "neutral" },
        { label: "CHAINLINK ORACLE", value: oracleUsd != null ? `$${oracleUsd}` : "—", tone: "neutral" },
        { label: "ORACLE SPREAD", value: spreadPct != null ? `${spreadPct > 0 ? "+" : ""}${spreadPct}%` : "—", tone: Math.abs(spreadPct || 0) > 1.5 ? "warn" : "safe" },
        { label: "IMPOSTER CLONES", value: String(clones.length), tone: clones.length > 0 ? "warn" : "safe" },
      ],
      flags: [
        { severity: "safe", text: `Verified official Robinhood Chain equity contract (${officialExact.isin || officialExact.symbol}).` },
        ...(clones.length > 0
          ? [{ severity: "warn", text: `Watch out: ${clones.length} unofficial curve clone(s) also use ticker $${officialExact.symbol} on Pons.` }]
          : []),
      ],
      official_stock: officialExact,
      clones: clones.slice(0, 4),
    };
  }

  // Plain EOA Wallet check
  if (account.kind === "wallet" && !pons && !holders?.supply) {
    const act = await TOOLS.wallet_activity(ctx, { address, limit: 8 }).catch(() => null);
    return {
      kind: "wallet",
      elapsed_ms: Date.now() - started,
      query: address,
      level: "info",
      badge: account.transactions_sent < 5 ? "FRESH EOA WALLET" : "ROBINHOOD CHAIN WALLET",
      title: `Wallet ${address.slice(0, 8)}…${address.slice(-6)}`,
      address,
      explorer: `https://robinhoodchain.blockscout.com/address/${address}`,
      metrics: [
        { label: "ETH BALANCE", value: `${account.eth_balance} ETH`, tone: "neutral" },
        { label: "TXS SENT (NONCE)", value: String(account.transactions_sent), tone: account.transactions_sent < 5 ? "warn" : "neutral" },
        { label: "RECENT TRANSFERS", value: String(act?.transfers ?? 0), tone: "neutral" },
        { label: "TOKENS TOUCHED", value: String(act?.tokens_touched ?? 0), tone: "neutral" },
      ],
      flags: [
        account.transactions_sent < 5
          ? { severity: "warn", text: `Fresh wallet (${account.transactions_sent} outgoing txs) — treat cautiously if deploying curves.` }
          : { severity: "info", text: `Active EOA with ${account.transactions_sent} outgoing transactions and ${account.eth_balance} ETH.` },
      ],
    };
  }

  // Token Contract X-Ray (Pons Bonding Curve / Graduated / ERC-20)
  const topPair = Array.isArray(pairsRes?.pairs) ? pairsRes.pairs[0] : null;
  const symbol = String(pons?.symbol || pairsRes?.token?.symbol || "TOKEN");
  const name = String(pons?.name || pairsRes?.token?.name || symbol);
  const officialSameSymbol = stocks.find(
    (s) => s.symbol.toUpperCase() === symbol.toUpperCase() && s.address !== address
  );
  const isStockClone = Boolean(officialSameSymbol);

  const curveAddr = typeof pons?.curve === "string" ? pons.curve : pons?.curve?.address || "";
  const poolAddr = typeof pons?.pool === "string" ? pons.pool : pons?.pool?.address || topPair?.pair || "";
  const deployer = pons?.deployer ? String(pons.deployer).toLowerCase() : null;

  const deployerTxCount = deployer
    ? await rpc(ctx, "eth_getTransactionCount", [deployer, "latest"])
        .then((hex) => parseInt(hex || "0x0", 16))
        .catch(() => null)
    : null;
  const deployerInfo = deployerTxCount != null ? { transactions_sent: deployerTxCount } : null;

  const holderRows = holders?.top || [];
  const burnedPct = Math.max(
    holders?.burned_pct || 0,
    round(
      holderRows
        .filter((h) => BURN_ADDRESSES.has(String(h.wallet || "").toLowerCase()))
        .reduce((s, h) => s + (h.share_pct || 0), 0),
      2
    )
  );
  const realWhales = holderRows.filter((h) => !isVaultOrBurnHolder(h, curveAddr, poolAddr));
  const realTop10Pct = holderRows.length
    ? round(realWhales.slice(0, 10).reduce((s, h) => s + (h.share_pct || 0), 0), 2)
    : null;
  const realTop1Pct = realWhales[0]?.share_pct ?? null;
  const deployerHoldPct = deployer
    ? round(
        holderRows
          .filter((h) => String(h.wallet || "").toLowerCase() === deployer)
          .reduce((s, h) => s + (h.share_pct || 0), 0),
        2
      )
    : null;

  const taxBps = pons?.creator_tax_bps ?? null;
  const taxPct = taxBps != null ? round(taxBps / 100, 2) : null;
  const mcapUsd = pons?.market_cap_usd ?? topPair?.market_cap_usd ?? null;
  const volUsd = pons?.volume_usd ?? topPair?.volume_24h_usd ?? null;
  const stage = pons?.stage || (topPair ? "dex" : "erc20");
  const curvePct = pons?.curve_progress_pct ?? (stage === "graduated" ? 100 : null);

  const flags = [];
  if (isStockClone) {
    flags.push({
      severity: "danger",
      text: `UNOFFICIAL STOCK CLONE: Uses ticker $${symbol.toUpperCase()}, NOT the real Robinhood equity token (${officialSameSymbol.address.slice(0, 8)}… · ${officialSameSymbol.isin || "ISIN"}).`,
    });
  }
  if (realTop10Pct != null && realTop10Pct >= 60) {
    flags.push({
      severity: "danger",
      text: `Extreme holder concentration: non-pool top-10 wallets control ${realTop10Pct}% of supply (#1 holds ${realTop1Pct}%).`,
    });
  } else if (realTop10Pct != null && realTop10Pct >= 35) {
    flags.push({
      severity: "warn",
      text: `Elevated whale concentration: non-pool top-10 wallets hold ${realTop10Pct}% of supply (#1 holds ${realTop1Pct}%).`,
    });
  } else if (realTop10Pct != null) {
    flags.push({
      severity: "safe",
      text: `Healthy distribution: non-pool top-10 wallets hold ${realTop10Pct}% of supply.`,
    });
  }

  if (taxBps != null && taxBps >= 300) {
    flags.push({
      severity: "warn",
      text: `Creator tax is ${taxBps} bps (${taxPct}% per trade on top of base curve fee).`,
    });
  }
  if (deployerHoldPct != null) {
    if (deployerHoldPct >= 15) {
      flags.push({
        severity: "danger",
        text: `Deployer (${deployer.slice(0, 8)}…) still holds ${deployerHoldPct}% of supply (${deployerInfo?.transactions_sent ?? "?"} total txs).`,
      });
    } else if (deployerHoldPct === 0 && burnedPct > 0) {
      flags.push({
        severity: "safe",
        text: `Deployer holds 0% in top-20 and ${burnedPct}% of supply is burned at 0x…dEaD.`,
      });
    }
  } else if (burnedPct > 0) {
    flags.push({
      severity: "safe",
      text: `${burnedPct}% of total supply confirmed burned at 0x…dEaD / 0x0000.`,
    });
  }

  let level = "safe";
  let badge = stage === "graduated" ? "GRADUATED · CLEAN" : "ACTIVE PONS CURVE";
  if (isStockClone) {
    level = "danger";
    badge = "DANGER · FAKE STOCK CLONE";
  } else if ((realTop10Pct != null && realTop10Pct >= 65) || (deployerHoldPct != null && deployerHoldPct >= 20) || (taxBps != null && taxBps >= 450)) {
    level = "danger";
    badge = "HIGH DUMP / TAX RISK";
  } else if ((realTop10Pct != null && realTop10Pct >= 35) || (taxBps != null && taxBps >= 250) || (deployerHoldPct != null && deployerHoldPct >= 10)) {
    level = "warn";
    badge = "CAUTION · WATCH WHALES / TAX";
  }

  return {
    kind: "token",
    elapsed_ms: Date.now() - started,
    query: address,
    level,
    badge,
    title: `${name} ($${symbol})`,
    symbol,
    address,
    pons_url: pons ? `https://ponsfamily.com/launchpad/${address}` : null,
    explorer: `https://robinhoodchain.blockscout.com/address/${address}`,
    metrics: [
      {
        label: "STAGE / CURVE",
        value: stage === "graduated" ? "GRADUATED (100%)" : curvePct != null ? `CURVE ${curvePct}%` : stage.toUpperCase(),
        tone: stage === "graduated" ? "safe" : "neutral",
      },
      {
        label: "MCAP / 24H VOL",
        value: `${mcapUsd != null ? "$" + mcapUsd.toLocaleString() : "—"} / ${volUsd != null ? "$" + volUsd.toLocaleString() : "$0"}`,
        tone: "neutral",
      },
      {
        label: "CREATOR TAX",
        value: taxBps != null ? `${taxPct}% (${taxBps} bps)` : "0% / N/A",
        tone: taxBps >= 300 ? "warn" : "safe",
      },
      {
        label: "WHALE TOP-10",
        value: realTop10Pct != null ? `${realTop10Pct}% (#1: ${realTop1Pct ?? 0}%)` : "—",
        tone: realTop10Pct >= 60 ? "danger" : realTop10Pct >= 35 ? "warn" : "safe",
      },
      {
        label: "DEV HELD / BURNED",
        value: `${deployerHoldPct != null ? deployerHoldPct + "%" : "0%"} / ${burnedPct}%🔥`,
        tone: deployerHoldPct >= 15 ? "danger" : burnedPct > 0 ? "safe" : "neutral",
      },
      {
        label: "DEPLOYER WALLET",
        value: deployer ? `${deployer.slice(0, 6)}… (${deployerInfo?.transactions_sent ?? "?"} txs)` : "—",
        tone: deployerInfo && deployerInfo.transactions_sent < 5 ? "warn" : "neutral",
      },
    ],
    flags,
    official_stock_collision: officialSameSymbol || null,
    top_whales: realWhales.slice(0, 5),
  };
}

