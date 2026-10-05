import { describe, expect, it } from 'vitest';
import { runBacktest, type BacktestConfig } from '../src/backtest.js';
import { maxAllocation } from '../src/guard.js';

const cfg: BacktestConfig = {
  strategy: 'momentum', lookback: 3, thresholdPct: 5, treasuryUsd: 10_000, amountUsd: 2_500,
  actionLimitUsd: 2_500, reserveBps: 3000, maxPerDay: 4, costBps: 0, sizeToGuard: true,
};
const series = (closes: number[]) =>
  closes.map((close, i) => ({ time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), close }));

describe('maxAllocation', () => {
  it('is the smaller of the action limit and the room above the reserve', () => {
    expect(maxAllocation({ actionLimit: 2_500n, idle: 10_000n, totalValue: 10_000n, reserveBps: 3000 })).toBe(2_500n);
    expect(maxAllocation({ actionLimit: 2_500n, idle: 5_000n, totalValue: 10_000n, reserveBps: 3000 })).toBe(2_000n);
    expect(maxAllocation({ actionLimit: 2_500n, idle: 2_000n, totalValue: 10_000n, reserveBps: 3000 })).toBe(0n);
  });
});

describe('runBacktest', () => {
  it('flat prices and no costs keep the treasury whole', () => {
    const r = runBacktest(series(Array(30).fill(1)), { ...cfg, strategy: 'dca' });
    expect(r.finalValueUsd).toBe(10_000);
    expect(r.strikes).toBe(0);
  });

  it('a guard-aware agent stops at the reserve without strikes', () => {
    const r = runBacktest(series(Array(10).fill(1)), { ...cfg, strategy: 'dca' });
    // 2,500 + 2,500 + 2,000 brings idle down to the 3,000 reserve.
    expect(r.executed).toBe(3);
    expect(r.skipped).toBe(7);
    expect(r.strikes).toBe(0);
    expect(r.exposurePct).toBe(100);
  });

  it('a naive agent breaks the reserve, collects strikes and is suspended', () => {
    const r = runBacktest(series(Array(10).fill(1)), { ...cfg, strategy: 'dca', sizeToGuard: false });
    expect(r.executed).toBe(2);
    expect(r.rejections.BreaksReserve).toBe(3);
    expect(r.strikes).toBe(3);
    expect(r.suspendedAt).toBe(series(Array(5).fill(1))[4].time);
    expect(r.proposals).toBe(5);
  });

  it('momentum rides a rally and recalls on the reversal', () => {
    const r = runBacktest(series([1, 1, 1, 1.2, 1.4, 1.6, 1.0, 0.8, 0.6]), cfg);
    const kinds = r.events.filter((e) => e.result === 'None').map((e) => e.action);
    expect(kinds.at(-1)).toBe('recall');
    expect(r.returnPct).toBeGreaterThan(r.buyAndHoldPct);
    expect(r.maxDrawdownPct).toBeGreaterThan(0);
  });

  it('mean reversion buys the dip and sells the recovery', () => {
    const r = runBacktest(series([1, 1, 1, 0.8, 1.1, 1.1]), { ...cfg, strategy: 'mean_reversion' });
    expect(r.events.map((e) => e.action)).toEqual(['allocate', 'recall']);
    expect(r.returnPct).toBeGreaterThan(0);
  });

  it('counts the daily rate limit without strikes', () => {
    const hourly = Array.from({ length: 6 }, (_, i) => ({ time: `2026-01-01T0${i}:00:00.000Z`, close: 1 }));
    const r = runBacktest(hourly, { ...cfg, strategy: 'dca', amountUsd: 100, maxPerDay: 4, sizeToGuard: false });
    expect(r.executed).toBe(4);
    expect(r.rejections.RateLimited).toBe(2);
    expect(r.strikes).toBe(0);
  });
});
