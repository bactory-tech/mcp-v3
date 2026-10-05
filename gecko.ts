// Live Base market data from the GeckoTerminal public API.
// The free tier allows about 30 calls a minute, so calls are spaced out, cached and retried on 429.

const API = 'https://api.geckoterminal.com/api/v2';
const GAP_MS = 2_100;

let last = 0;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, { t: number; v: unknown }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(path: string, ttlMs = 60_000): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = last + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const r = await fetch(API + path, { headers: { accept: 'application/json' } });
      if (r.status === 429) {
        await sleep(5_000 * (attempt + 1));
        continue;
      }
      if (r.status === 404) throw new Error(`Not found on Base: ${path}`);
      if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
      const v = (await r.json()) as T;
      cache.set(path, { t: Date.now(), v });
      return v;
    }
    throw new Error('GeckoTerminal rate limit: try again in a minute');
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

type Json = Record<string, any>;
const num = (x: unknown) => (x == null ? null : Number(x));
const strip = (id?: string) => id?.replace(/^base_/, '');

export interface Token {
  address: string; name: string; symbol: string; decimals: number;
  priceUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null;
  marketCapUsd: number | null; fdvUsd: number | null; topPools: string[];
}

export interface Pool {
  address: string; name: string; dex: string | undefined; baseToken: string | undefined; quoteToken: string | undefined;
  priceUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null; change24hPct: number | null;
  trades24h: number | null; feePct: number | null; createdAt: string;
}

const tokenOf = (d: Json): Token => {
  const a = d.attributes;
  return {
    address: a.address, name: a.name, symbol: a.symbol, decimals: a.decimals,
    priceUsd: num(a.price_usd), liquidityUsd: num(a.total_reserve_in_usd), volume24hUsd: num(a.volume_usd?.h24),
    marketCapUsd: num(a.market_cap_usd), fdvUsd: num(a.fdv_usd),
    topPools: (d.relationships?.top_pools?.data ?? []).map((p: Json) => strip(p.id)),
  };
};

const poolOf = (d: Json): Pool => {
  const a = d.attributes, r = d.relationships ?? {};
  const fee = (a.name.match(/([\d.]+)%/) ?? [])[1];
  const tx = a.transactions?.h24;
  return {
    address: a.address, name: a.name, dex: r.dex?.data?.id,
    baseToken: strip(r.base_token?.data?.id), quoteToken: strip(r.quote_token?.data?.id),
    priceUsd: num(a.base_token_price_usd), liquidityUsd: num(a.reserve_in_usd), volume24hUsd: num(a.volume_usd?.h24),
    change24hPct: num(a.price_change_percentage?.h24), trades24h: tx ? tx.buys + tx.sells : null,
    feePct: fee ? Number(fee) : null, createdAt: a.pool_created_at,
  };
};

export const gecko = {
  async token(address: string) {
    return tokenOf((await get<Json>(`/networks/base/tokens/${address}?include=top_pools`)).data);
  },
  async tokenPools(address: string) {
    return (await get<Json>(`/networks/base/tokens/${address}/pools?page=1`)).data.map(poolOf) as Pool[];
  },
  async pool(address: string) {
    return poolOf((await get<Json>(`/networks/base/pools/${address}`, 30_000)).data);
  },
  async topPools() {
    return (await get<Json>('/networks/base/pools?page=1&sort=h24_volume_usd_desc', 120_000)).data.map(poolOf) as Pool[];
  },
  async trades(pool: string) {
    return (await get<Json>(`/networks/base/pools/${pool}/trades`, 20_000)).data.map((t: Json) => {
      const a = t.attributes;
      return {
        kind: a.kind as 'buy' | 'sell', tx: a.tx_hash as string, time: a.block_timestamp as string,
        usd: num(a.volume_in_usd), priceUsd: num(a.kind === 'buy' ? a.price_to_in_usd : a.price_from_in_usd),
      };
    });
  },
  async ohlcv(pool: string, timeframe: 'day' | 'hour' | 'minute', limit: number) {
    const d = await get<Json>(`/networks/base/pools/${pool}/ohlcv/${timeframe}?limit=${limit}`, 300_000);
    return (d.data.attributes.ohlcv_list as number[][]).map(([t, o, h, l, c, v]) => ({
      time: new Date(t * 1000).toISOString(), open: o, high: h, low: l, close: c, volumeUsd: v,
    })).reverse();
  },
  async search(query: string) {
    const d = await get<Json>(`/search/pools?query=${encodeURIComponent(query)}&network=base&include=base_token`, 120_000);
    const toks: Record<string, Json> = {};
    for (const t of d.included ?? []) if (t.type === 'token') toks[t.id] = t.attributes;
    const seen = new Set<string>();
    const out: { address: string; name: string; symbol: string; liquidityUsd: number | null; pool: string; poolName: string }[] = [];
    for (const p of d.data) {
      const id = p.relationships.base_token.data.id, t = toks[id];
      if (!t || seen.has(id)) continue;
      seen.add(id);
      out.push({ address: t.address, name: t.name, symbol: t.symbol, liquidityUsd: num(p.attributes.reserve_in_usd), pool: p.attributes.address, poolName: p.attributes.name });
    }
    return out;
  },
};
