import { describe, expect, it } from 'vitest';
import { decide, type CycleInputs } from '../src/treasury.js';

const days = (closes: number[]) =>
  closes.map((close, i) => ({ time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), close }));
const rally = days(Array.from({ length: 60 }, (_, i) => 1 + i * 0.01));
const slide = days(Array.from({ length: 60 }, (_, i) => 2 - i * 0.01));

const base: CycleInputs = {
  market: { totalLiquidityUsd: 5_000_000, flags: ['no warnings'] },
  oracle: { ageSeconds: 120, maxAgeSeconds: 3600, sequencerUp: true },
  candles: rally,
  treasury: { idleUsd: 10_000, positionUsd: 0, amountUsd: 2_500, actionLimitUsd: 2_500, reserveBps: 3000, maxPerDay: 4, usedToday: 0 },
  lookback: 20, thresholdPct: 5, costBps: 30,
};

describe('decide', () => {
  it('stands down on a stale oracle or a down sequencer', () => {
    expect(decide({ ...base, oracle: { ...base.oracle, ageSeconds: 4000 } }).decision).toBe('stand_down');
    expect(decide({ ...base, oracle: { ...base.oracle, sequencerUp: false } }).decision).toBe('stand_down');
  });

  it('allocates into a rally with a size that passes the guard', () => {
    const p = decide(base);
    expect(p.decision).toBe('allocate');
    expect(p.amountUsd).toBe(2_500);
    expect(p.guard?.executed).toBe(true);
    expect(p.ranking).toHaveLength(3);
  });

  it('sizes down to keep the reserve', () => {
    // 7,000 total, 30% reserve = 2,100 must stay idle, so 900 of the 3,000 idle can move.
    const p = decide({ ...base, treasury: { ...base.treasury, idleUsd: 3_000, positionUsd: 4_000 } });
    expect(p.decision).toBe('allocate');
    expect(p.amountUsd).toBe(900);
    expect(p.guard?.reason).toBe('None');
  });

  it('holds when the reserve leaves only dust', () => {
    const p = decide({ ...base, treasury: { ...base.treasury, idleUsd: 3_050, positionUsd: 7_000 } });
    expect(p.decision).toBe('hold');
  });

  it('recalls a position when no strategy made money', () => {
    const p = decide({ ...base, candles: slide, treasury: { ...base.treasury, idleUsd: 6_000, positionUsd: 4_000 } });
    expect(p.decision).toBe('recall');
    expect(p.amountUsd).toBe(4_000);
  });

  it('holds in cash when no strategy made money and nothing is held', () => {
    expect(decide({ ...base, candles: slide }).decision).toBe('hold');
  });

  it('exits a market that got too thin, and stays out of one', () => {
    const thin = { totalLiquidityUsd: 40_000, flags: [] };
    expect(decide({ ...base, market: thin, treasury: { ...base.treasury, positionUsd: 1_000 } }).decision).toBe('recall');
    expect(decide({ ...base, market: thin }).decision).toBe('stand_down');
  });

  it('respects the daily proposal limit', () => {
    const p = decide({ ...base, treasury: { ...base.treasury, usedToday: 4 } });
    expect(p.decision).toBe('hold');
    expect(p.reasons.at(-1)).toMatch(/daily proposal limit/);
  });
});
