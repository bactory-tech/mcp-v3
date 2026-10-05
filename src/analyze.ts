// Market health the way a Bactory agent reads it before proposing an action.

import { gecko, type Pool } from './gecko.js';

/** Below this much liquidity across all pools, an agent should not allocate at all. */
export const MIN_LIQUIDITY_USD = 100_000;

export async function analyzeMarket(address: string) {
  const [token, pools] = await Promise.all([gecko.token(address), gecko.tokenPools(address)]);
  const live = pools.filter((p) => (p.liquidityUsd ?? 0) > 0);
  const totalLiq = live.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);
  const top = live[0] as Pool | undefined;
  const prices = live.filter((p) => (p.liquidityUsd ?? 0) > 250_000 && p.baseToken?.toLowerCase() === address.toLowerCase()).map((p) => p.priceUsd ?? 0).filter((x) => x > 0);
  const divergencePct = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100 : 0;
  const topShare = top && totalLiq ? (top.liquidityUsd ?? 0) / totalLiq : null;
  const turnover = token.liquidityUsd ? (token.volume24hUsd ?? 0) / token.liquidityUsd : null;
  const change = top?.change24hPct ?? null;

  const flags: string[] = [];
  if (totalLiq < MIN_LIQUIDITY_USD) flags.push('thin liquidity: under $100K across all pools; large actions will move the price');
  if (topShare !== null && topShare > 0.8) flags.push(`concentrated: ${(topShare * 100).toFixed(0)}% of liquidity sits in one pool`);
  if (change !== null && Math.abs(change) > 10) flags.push(`volatile: ${change.toFixed(1)}% in 24 h on the main pool`);
  if (divergencePct > 1) flags.push(`pools disagree on price by ${divergencePct.toFixed(2)}%; check oracle freshness before acting`);
  if (turnover !== null && turnover < 0.05) flags.push('low turnover: little fee income relative to liquidity');
  if (!flags.length) flags.push('no warnings');

  return {
    token: { address: token.address, symbol: token.symbol, name: token.name, priceUsd: token.priceUsd },
    metrics: {
      totalLiquidityUsd: Math.round(totalLiq), pools: live.length,
      mainPool: top ? { address: top.address, name: top.name, dex: top.dex, liquidityUsd: top.liquidityUsd, feePct: top.feePct } : null,
      mainPoolShare: topShare, volume24hUsd: token.volume24hUsd, volumeToLiquidity: turnover,
      change24hPct: change, priceDivergencePct: Number(divergencePct.toFixed(4)),
    },
    flags,
  };
}
