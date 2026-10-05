// Offline mirror of AgentGuard._check (bactory-protocol/src/modules/AgentGuard.sol).
// Same order of checks, same rejection reasons, so an agent can test a proposal
// before any contract is deployed or any gas is spent.

export const REJECTIONS = [
  'None',
  'AgentSuspended',
  'RateLimited',
  'OracleNotFresh',
  'StrategyNotApproved',
  'ExceedsActionLimit',
  'BreaksReserve',
  'InsufficientAllocation',
  'MarketPaused',
] as const;
export type Rejection = (typeof REJECTIONS)[number];

export const STRIKES_TO_SUSPEND = 3;
const BPS = 10_000n;

export interface GuardState {
  agentSuspended: boolean;
  marketPaused: boolean;
  usedToday: number;
  maxPerDay: number;
  /** Seconds since the oracle last updated, or null when the market has no price feed. */
  oracleAgeSeconds: number | null;
  oracleMaxAgeSeconds: number;
  /** False when the L2 sequencer is down or restarted less than an hour ago. True when no sequencer feed is set. */
  sequencerUp: boolean;
  strategyApproved: boolean;
  /** Largest amount one action may move (TreasuryModule.actionLimit). */
  actionLimit: bigint;
  /** Treasury balance not allocated to any strategy. */
  idle: bigint;
  /** Idle plus allocated. */
  totalValue: bigint;
  reserveBps: number;
  /** Amount already allocated to the strategy (used by recalls). */
  allocated: bigint;
}

export interface GuardAction {
  kind: 'allocate' | 'recall';
  amount: bigint;
}

export interface GuardCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface GuardResult {
  executed: boolean;
  reason: Rejection;
  /** Whether this rejection would add a strike to the agent (three strikes suspend it). */
  addsStrike: boolean;
  checks: GuardCheck[];
}

const fmt = (x: bigint) => x.toString();

/** Largest allocation that passes the action-limit and reserve checks, or 0n when none does. */
export function maxAllocation(s: Pick<GuardState, 'actionLimit' | 'idle' | 'totalValue' | 'reserveBps'>): bigint {
  const reserve = (s.totalValue * BigInt(s.reserveBps)) / BPS;
  const room = s.idle > reserve ? s.idle - reserve : 0n;
  return room < s.actionLimit ? room : s.actionLimit;
}

export function checkProposal(s: GuardState, a: GuardAction): GuardResult {
  const checks: GuardCheck[] = [];
  const done = (reason: Rejection): GuardResult => ({
    executed: reason === 'None',
    reason,
    addsStrike: reason !== 'None' && reason !== 'RateLimited' && reason !== 'AgentSuspended',
    checks,
  });
  const step = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
    return passed;
  };

  if (!step('agent active', !s.agentSuspended, s.agentSuspended ? 'agent is suspended' : 'agent is not suspended')) return done('AgentSuspended');

  const pausedBlocks = s.marketPaused && a.kind === 'allocate';
  if (!step('market open', !pausedBlocks, pausedBlocks ? 'market is paused; only recalls are allowed' : s.marketPaused ? 'market is paused, recall allowed' : 'market is not paused')) return done('MarketPaused');

  if (!step('rate limit', s.usedToday < s.maxPerDay, `${s.usedToday} of ${s.maxPerDay} proposals used today`)) return done('RateLimited');

  // OracleLib.check: the sequencer comes first, even when no price feed is set.
  if (!step('sequencer', s.sequencerUp, s.sequencerUp ? 'L2 sequencer is up' : 'L2 sequencer is down or in its 1 h grace period')) return done('OracleNotFresh');
  if (s.oracleAgeSeconds === null) {
    step('oracle freshness', true, 'no price feed configured; check skipped');
  } else {
    const fresh = s.oracleAgeSeconds >= 0 && s.oracleAgeSeconds <= s.oracleMaxAgeSeconds;
    if (!step('oracle freshness', fresh, `price is ${s.oracleAgeSeconds}s old, limit ${s.oracleMaxAgeSeconds}s`)) return done('OracleNotFresh');
  }

  if (a.kind === 'allocate') {
    if (!step('strategy approved', s.strategyApproved, s.strategyApproved ? 'strategy is approved by the market' : 'strategy is not approved')) return done('StrategyNotApproved');

    const withinLimit = a.amount > 0n && a.amount <= s.actionLimit;
    if (!step('action limit', withinLimit, `amount ${fmt(a.amount)}, limit ${fmt(s.actionLimit)}`)) return done('ExceedsActionLimit');

    const reserve = (s.totalValue * BigInt(s.reserveBps)) / BPS;
    const keepsReserve = a.amount <= s.idle && s.idle - a.amount >= reserve;
    const left = a.amount <= s.idle ? fmt(s.idle - a.amount) : 'negative';
    if (!step('reserve', keepsReserve, `idle after action ${left}, reserve required ${fmt(reserve)} (${s.reserveBps / 100}% of ${fmt(s.totalValue)})`)) return done('BreaksReserve');
  } else {
    const ok = a.amount > 0n && a.amount <= s.allocated;
    if (!step('allocation', ok, `recall ${fmt(a.amount)}, allocated ${fmt(s.allocated)}`)) return done('InsufficientAllocation');
  }

  return done('None');
}
