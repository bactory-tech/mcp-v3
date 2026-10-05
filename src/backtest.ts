// Replays a simple agent strategy over price history, sending every proposal through the
// offline AgentGuard. Shows what the strategy would have earned and how the guard would have
// treated the agent: executions, rejections, strikes and suspension.

import { checkProposal, maxAllocation, STRIKES_TO_SUSPEND, type Rejection } from './guard.js';

export type StrategyKind = 'dca' | 'momentum' | 'mean_reversion';

export interface Candle { time: string; close: number }

export interface BacktestConfig {
  strategy: StrategyKind;
  /** Moving-average window in candles (momentum, mean_reversion). */
  lookback: number;
  /** How far below the average the price must fall before mean_reversion buys. */
  thresholdPct: number;
  treasuryUsd: number;
  /** Size of each allocation the agent proposes. */
  amountUsd: number;
  actionLimitUsd: number;
  reserveBps: number;
  maxPerDay: number;
  /** Swap fee plus slippage paid on every executed allocate or recall, in basis points. */
  costBps: number;
  /** Guard-aware agent: shrinks allocations to what the guard allows and skips proposals it knows would fail. */
  sizeToGuard: boolean;
}

export interface BacktestEvent {
  time: string;
  action: 'allocate' | 'recall';
  amountUsd: number;
  priceUsd: number;
  result: Rejection;
  strikes: number;
}

export interface BacktestResult {
  candles: number;
  from: string;
  to: string;
  finalValueUsd: number;
  returnPct: number;
  buyAndHoldPct: number;
  maxDrawdownPct: number;
  /** Share of candles the treasury held a position. */
  exposurePct: number;
  proposals: number;
  executed: number;
  rejections: Partial<Record<Rejection, number>>;
  skipped: number;
  strikes: number;
  suspendedAt: string | null;
  events: BacktestEvent[];
}

const MICRO = 1_000_000;
const toMicro = (usd: number) => BigInt(Math.max(0, Math.floor(usd * MICRO)));
const toUsd = (x: bigint) => Number(x) / MICRO;
const round = (x: number, d = 2) => Number(x.toFixed(d));

export function signal(cfg: BacktestConfig, closes: number[], i: number, holding: boolean): 'allocate' | 'recall' | null {
  if (cfg.strategy === 'dca') return 'allocate';
  if (i + 1 < cfg.lookback) return null;
  const window = closes.slice(i + 1 - cfg.lookback, i + 1);
  const sma = window.reduce((s, x) => s + x, 0) / window.length;
  const price = closes[i];
  if (cfg.strategy === 'momentum') {
    if (price > sma) return 'allocate';
    return holding ? 'recall' : null;
  }
  if (price <= sma * (1 - cfg.thresholdPct / 100)) return 'allocate';
  return holding && price >= sma ? 'recall' : null;
}

export function runBacktest(candles: Candle[], cfg: BacktestConfig): BacktestResult {
  if (candles.length < 2) throw new Error('need at least two candles');
  const closes = candles.map((c) => c.close);
  const cost = 1 - cfg.costBps / 10_000;

  let idle = cfg.treasuryUsd;
  let units = 0;
  let day = '';
  let usedToday = 0;
  let strikes = 0;
  let suspendedAt: string | null = null;
  let peak = cfg.treasuryUsd;
  let maxDrawdown = 0;
  let held = 0;
  let proposals = 0;
  let executed = 0;
  let skipped = 0;
  const rejections: Partial<Record<Rejection, number>> = {};
  const events: BacktestEvent[] = [];

  for (let i = 0; i < candles.length; i++) {
    const { time, close: price } = candles[i];
    if (time.slice(0, 10) !== day) { day = time.slice(0, 10); usedToday = 0; }

    const want = suspendedAt ? null : signal(cfg, closes, i, units > 0);
    if (want) {
      const position = units * price;
      const state = {
        agentSuspended: false, marketPaused: false, usedToday, maxPerDay: cfg.maxPerDay,
        oracleAgeSeconds: null, oracleMaxAgeSeconds: 3600, sequencerUp: true, strategyApproved: true,
        actionLimit: toMicro(cfg.actionLimitUsd), idle: toMicro(idle), totalValue: toMicro(idle + position),
        reserveBps: cfg.reserveBps, allocated: toMicro(position),
      };
      let amount = want === 'allocate' ? toMicro(cfg.amountUsd) : toMicro(position);
      if (want === 'allocate' && cfg.sizeToGuard) {
        // Not worth a proposal (or the swap cost) once the room left is a fraction of the intended size.
        const room = maxAllocation(state);
        if (amount > room) amount = room * 10n < toMicro(cfg.amountUsd) ? 0n : room;
      }
      const knownFail = amount === 0n || (cfg.sizeToGuard && usedToday >= cfg.maxPerDay);
      if (want === 'recall' && amount === 0n) {
        // Dust position: nothing to recall.
      } else if (knownFail && cfg.sizeToGuard) {
        skipped++;
      } else {
        const r = checkProposal(state, { kind: want, amount });
        proposals++;
        if (r.reason !== 'RateLimited') usedToday++;
        const usd = toUsd(amount);
        if (r.executed) {
          executed++;
          if (want === 'allocate') { idle -= usd; units += (usd * cost) / price; }
          else { idle += usd * cost; units = 0; }
        } else {
          rejections[r.reason] = (rejections[r.reason] ?? 0) + 1;
          if (r.addsStrike && ++strikes >= STRIKES_TO_SUSPEND) suspendedAt = time;
        }
        events.push({ time, action: want, amountUsd: round(usd), priceUsd: price, result: r.reason, strikes });
      }
    }

    const value = idle + units * price;
    if (units > 0) held++;
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }

  const last = candles[candles.length - 1];
  const finalValue = idle + units * last.close;
  return {
    candles: candles.length,
    from: candles[0].time,
    to: last.time,
    finalValueUsd: round(finalValue),
    returnPct: round((finalValue / cfg.treasuryUsd - 1) * 100),
    buyAndHoldPct: round((last.close / candles[0].close - 1) * 100),
    maxDrawdownPct: round(maxDrawdown * 100),
    exposurePct: round((held / candles.length) * 100, 1),
    proposals, executed, rejections, skipped, strikes, suspendedAt,
    events,
  };
}
