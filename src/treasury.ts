// The Bactory treasury agent: one daily cycle of check market → pick strategy → size → guard → report.
// It only proposes. Nothing here signs or sends a transaction.

import type { Address } from 'viem';
import { gecko } from './gecko.js';
import { analyzeMarket, MIN_LIQUIDITY_USD } from './analyze.js';
import { NETWORKS, readFeed, readSequencer } from './chain.js';
import { runBacktest, signal, type BacktestConfig, type Candle, type StrategyKind } from './backtest.js';
import { checkProposal, maxAllocation, type GuardResult } from './guard.js';

export interface TreasuryState {
  idleUsd: number;
  /** Current value of what the treasury holds in this market's strategy. */
  positionUsd: number;
  /** Size the agent aims for on each allocation. */
  amountUsd: number;
  actionLimitUsd: number;
  reserveBps: number;
  maxPerDay: number;
  usedToday: number;
}

export interface CycleInputs {
  market: { totalLiquidityUsd: number; flags: string[] };
  oracle: { ageSeconds: number; maxAgeSeconds: number; sequencerUp: boolean };
  /** Daily candles, oldest first; the last one is today. */
  candles: Candle[];
  treasury: TreasuryState;
  lookback: number;
  thresholdPct: number;
  costBps: number;
}

export interface StrategyScore { strategy: StrategyKind; returnPct: number; maxDrawdownPct: number; score: number }

export interface Plan {
  decision: 'allocate' | 'recall' | 'hold' | 'stand_down';
  amountUsd: number;
  strategy: StrategyKind | null;
  reasons: string[];
  ranking: StrategyScore[];
  guard: GuardResult | null;
}

const STRATEGIES: StrategyKind[] = ['momentum', 'mean_reversion', 'dca'];
const micro = (usd: number) => BigInt(Math.max(0, Math.floor(usd * 1_000_000)));

/** Pure decision step: same inputs, same plan. Covered by tests. */
export function decide(x: CycleInputs): Plan {
  const t = x.treasury;
  const reasons: string[] = [];
  const plan = (decision: Plan['decision'], extra: Partial<Plan> = {}): Plan =>
    ({ decision, amountUsd: 0, strategy: null, reasons, ranking: [], guard: null, ...extra });

  // 1. The guard rejects everything on a stale oracle, recalls included, so there is nothing to propose.
  if (!x.oracle.sequencerUp) { reasons.push('L2 sequencer is down or in its grace period'); return plan('stand_down'); }
  if (x.oracle.ageSeconds > x.oracle.maxAgeSeconds) {
    reasons.push(`oracle price is ${x.oracle.ageSeconds}s old, limit ${x.oracle.maxAgeSeconds}s`);
    return plan('stand_down');
  }

  const guardState = () => ({
    agentSuspended: false, marketPaused: false, usedToday: t.usedToday, maxPerDay: t.maxPerDay,
    oracleAgeSeconds: x.oracle.ageSeconds, oracleMaxAgeSeconds: x.oracle.maxAgeSeconds, sequencerUp: x.oracle.sequencerUp,
    strategyApproved: true, actionLimit: micro(t.actionLimitUsd), idle: micro(t.idleUsd),
    totalValue: micro(t.idleUsd + t.positionUsd), reserveBps: t.reserveBps, allocated: micro(t.positionUsd),
  });
  const propose = (kind: 'allocate' | 'recall', amountUsd: number, extra: Partial<Plan>): Plan => {
    if (t.usedToday >= t.maxPerDay) { reasons.push('daily proposal limit already used'); return plan('hold', extra); }
    const guard = checkProposal(guardState(), { kind, amount: micro(amountUsd) });
    if (!guard.executed) { reasons.push(`guard would reject: ${guard.reason}`); return plan('hold', { ...extra, guard }); }
    return plan(kind, { ...extra, amountUsd: Math.floor(amountUsd * 100) / 100, guard });
  };

  // 2. A market too thin to exit cleanly: get out if we are in, stay out if not.
  if (x.market.totalLiquidityUsd < MIN_LIQUIDITY_USD) {
    reasons.push(`liquidity $${Math.round(x.market.totalLiquidityUsd).toLocaleString('en-US')} is under the $${MIN_LIQUIDITY_USD.toLocaleString('en-US')} floor`);
    return t.positionUsd > 0 ? propose('recall', t.positionUsd, {}) : plan('stand_down');
  }

  // 3. Rank strategies on recent history, scored by return per unit of drawdown.
  const cfg = (strategy: StrategyKind): BacktestConfig => ({
    strategy, lookback: x.lookback, thresholdPct: x.thresholdPct, treasuryUsd: t.idleUsd + t.positionUsd,
    amountUsd: t.amountUsd, actionLimitUsd: t.actionLimitUsd, reserveBps: t.reserveBps, maxPerDay: t.maxPerDay,
    costBps: x.costBps, sizeToGuard: true,
  });
  const ranking = STRATEGIES.map((strategy) => {
    const r = runBacktest(x.candles, cfg(strategy));
    return { strategy, returnPct: r.returnPct, maxDrawdownPct: r.maxDrawdownPct, score: Number((r.returnPct / Math.max(r.maxDrawdownPct, 1)).toFixed(3)) };
  }).sort((a, b) => b.score - a.score);
  const best = ranking.find((s) => s.returnPct > 0);
  if (!best) {
    reasons.push(`no strategy made money over the last ${x.candles.length} days`);
    return t.positionUsd > 0 ? propose('recall', t.positionUsd, { ranking }) : plan('hold', { ranking });
  }
  reasons.push(`${best.strategy} ranked first: ${best.returnPct}% return, ${best.maxDrawdownPct}% max drawdown`);

  // 4. Today's signal from the chosen strategy.
  const closes = x.candles.map((c) => c.close);
  const want = signal(cfg(best.strategy), closes, closes.length - 1, t.positionUsd > 0);
  const extra = { ranking, strategy: best.strategy };
  if (!want) { reasons.push(`${best.strategy} gives no signal today`); return plan('hold', extra); }
  if (want === 'recall') { reasons.push(`${best.strategy} signals an exit`); return propose('recall', t.positionUsd, extra); }

  // 5. Size the allocation to what the guard allows, so it never costs a strike.
  const room = Number(maxAllocation(guardState())) / 1_000_000;
  const amount = Math.min(t.amountUsd, room);
  if (amount * 10 < t.amountUsd) { reasons.push(`only $${room.toFixed(2)} left above the reserve and action limit`); return plan('hold', extra); }
  reasons.push(amount < t.amountUsd ? `${best.strategy} signals an entry; sized down to $${amount.toFixed(2)} to keep the reserve` : `${best.strategy} signals an entry`);
  return propose('allocate', amount, extra);
}

export interface CycleOptions { lookback?: number; thresholdPct?: number; costBps?: number; historyDays?: number; oracleMaxAgeSeconds?: number }

/** Full cycle against live Base data: resolve the asset, read market and oracle, then decide. */
export async function runCycle(asset: string, treasury: TreasuryState, o: CycleOptions = {}) {
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(asset);
  const token = isAddress ? asset : (await gecko.search(asset))[0]?.address;
  if (!token) throw new Error(`no Base token found for "${asset}"`);

  const market = await analyzeMarket(token);
  const pool = market.metrics.mainPool?.address;
  if (!pool) throw new Error(`${market.token.symbol} has no live pool on Base`);

  const maxAgeSeconds = o.oracleMaxAgeSeconds ?? 3600;
  const [feed, sequencer, candles] = await Promise.all([
    readFeed('base', NETWORKS.base.ethUsdFeed as Address),
    readSequencer('base'),
    gecko.ohlcv(pool, 'day', o.historyDays ?? 90),
  ]);
  const oracle = { ageSeconds: feed.ageSeconds, maxAgeSeconds, sequencerUp: !sequencer || (sequencer.up && !sequencer.inGracePeriod) };

  const plan = decide({
    market: { totalLiquidityUsd: market.metrics.totalLiquidityUsd, flags: market.flags },
    oracle, candles, treasury,
    lookback: o.lookback ?? 20, thresholdPct: o.thresholdPct ?? 5, costBps: o.costBps ?? 30,
  });
  return { at: new Date().toISOString(), asset: market.token, pool: market.metrics.mainPool, market, oracle, treasury, plan };
}

export type CycleResult = Awaited<ReturnType<typeof runCycle>>;

/** Plain-text report a person can read or paste. */
export function report(r: CycleResult): string {
  const p = r.plan;
  const usd = (x: number) => `$${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const headline = {
    allocate: `PROPOSE allocate ${usd(p.amountUsd)} into ${r.asset.symbol}`,
    recall: `PROPOSE recall ${usd(p.amountUsd)} from ${r.asset.symbol}`,
    hold: `HOLD: no proposal today`,
    stand_down: `STAND DOWN: unsafe to act`,
  }[p.decision];
  const lines = [
    `Bactory treasury agent · ${r.at.slice(0, 16).replace('T', ' ')} UTC`,
    `${r.asset.symbol} at ${usd(r.asset.priceUsd ?? 0)} · main pool ${r.pool?.name ?? '?'} (${r.pool?.dex ?? '?'})`,
    `treasury: ${usd(r.treasury.idleUsd)} idle, ${usd(r.treasury.positionUsd)} in position, reserve ${r.treasury.reserveBps / 100}%`,
    '',
    headline,
    ...p.reasons.map((x) => `  - ${x}`),
  ];
  if (p.ranking.length) {
    lines.push('', 'strategies on recent daily history:');
    for (const s of p.ranking) lines.push(`  ${s.strategy.padEnd(15)} ${String(s.returnPct).padStart(8)}%  drawdown ${String(s.maxDrawdownPct).padStart(6)}%  score ${s.score}`);
  }
  lines.push('', `market flags: ${r.market.flags.join('; ')}`, `oracle: ${r.oracle.ageSeconds}s old, sequencer ${r.oracle.sequencerUp ? 'up' : 'down'}`);
  if (p.guard) lines.push(`guard: ${p.guard.checks.map((c) => `${c.passed ? 'ok' : 'FAIL'} ${c.name}`).join(', ')}`);
  lines.push('', 'Proposal only. Nothing was signed or sent.');
  return lines.join('\n');
}
