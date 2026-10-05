#!/usr/bin/env node
// Bactory MCP server: live Base market data and AgentGuard checks for AI assistants.
// Read and propose only. No tool signs or sends a transaction.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Address } from 'viem';
import { gecko } from './gecko.js';
import { analyzeMarket } from './analyze.js';
import { NETWORKS, guardStatus, previewOnchain, readFeed, readSequencer } from './chain.js';
import { checkProposal, STRIKES_TO_SUSPEND } from './guard.js';
import { runBacktest } from './backtest.js';
import { report, runCycle } from './treasury.js';

const VERSION = '0.3.0';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x-prefixed 20-byte address');
const amount = z.string().regex(/^\d+$/, 'an integer amount in the token\'s smallest unit, as a string');
const network = z.enum(['base', 'base-sepolia']).default('base');

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
const safe = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return fail(e); }
};
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

const server = new McpServer({ name: 'bactory', version: VERSION });

// ------------------------------------------------------------------ market data

server.registerTool('search_assets', {
  title: 'Search Base assets',
  description: 'Find tokens on Base by name, ticker or contract address. Returns each token with its most liquid pool.',
  inputSchema: { query: z.string().min(1).describe('Token name, ticker or address, e.g. "AERO"') },
  annotations: readOnly,
}, safe(({ query }) => gecko.search(query)));

server.registerTool('get_asset', {
  title: 'Asset overview',
  description: 'Price, liquidity, 24 h volume, market cap and top pools for a Base token.',
  inputSchema: { address: address.describe('Token contract on Base') },
  annotations: readOnly,
}, safe(({ address }) => gecko.token(address)));

server.registerTool('get_asset_pools', {
  title: 'Asset pools',
  description: 'Every DEX pool on Base that trades a token, with liquidity, volume, fee tier and 24 h change.',
  inputSchema: { address: address.describe('Token contract on Base') },
  annotations: readOnly,
}, safe(({ address }) => gecko.tokenPools(address)));

server.registerTool('get_pool', {
  title: 'Pool details',
  description: 'Live state of one Base DEX pool.',
  inputSchema: { address: address.describe('Pool address on Base') },
  annotations: readOnly,
}, safe(({ address }) => gecko.pool(address)));

server.registerTool('list_top_markets', {
  title: 'Top Base markets',
  description: 'Base pools ranked by 24 h volume.',
  inputSchema: { limit: z.number().int().min(1).max(20).default(10) },
  annotations: readOnly,
}, safe(async ({ limit }) => (await gecko.topPools()).slice(0, limit)));

server.registerTool('get_trades', {
  title: 'Recent trades',
  description: 'Latest swaps in a Base pool, with side, USD size, price and transaction hash.',
  inputSchema: { pool: address.describe('Pool address on Base'), limit: z.number().int().min(1).max(100).default(20) },
  annotations: readOnly,
}, safe(async ({ pool, limit }) => (await gecko.trades(pool)).slice(0, limit)));

server.registerTool('get_price_history', {
  title: 'Price history',
  description: 'OHLCV candles for a Base pool, oldest first.',
  inputSchema: {
    pool: address.describe('Pool address on Base'),
    timeframe: z.enum(['day', 'hour', 'minute']).default('day'),
    limit: z.number().int().min(1).max(1000).default(30),
  },
  annotations: readOnly,
}, safe(({ pool, timeframe, limit }) => gecko.ohlcv(pool, timeframe, limit)));

server.registerTool('analyze_market', {
  title: 'Market health for agents',
  description:
    'Summarises a token\'s Base market the way a Bactory agent would before proposing an action: liquidity depth and how it is spread across pools, ' +
    'volume to liquidity, 24 h volatility and price divergence between pools. Returns metrics plus plain-language flags.',
  inputSchema: { address: address.describe('Token contract on Base') },
  annotations: readOnly,
}, safe(({ address }) => analyzeMarket(address)));

// ------------------------------------------------------------------ onchain

server.registerTool('get_oracle_price', {
  title: 'Chainlink price and freshness',
  description:
    'Reads a Chainlink price feed on Base (ETH/USD by default) and the L2 sequencer uptime feed. ' +
    'These are the inputs AgentGuard uses for its oracle-freshness check.',
  inputSchema: {
    network,
    feed: address.optional().describe('Chainlink aggregator address; defaults to ETH/USD'),
    maxAgeSeconds: z.number().int().positive().default(3600).describe('Freshness limit to judge against'),
  },
  annotations: readOnly,
}, safe(async ({ network, feed, maxAgeSeconds }) => {
  const [price, sequencer] = await Promise.all([
    readFeed(network, (feed ?? NETWORKS[network].ethUsdFeed) as Address),
    readSequencer(network),
  ]);
  const sequencerOk = !sequencer || (sequencer.up && !sequencer.inGracePeriod);
  return { network, ...price, maxAgeSeconds, fresh: sequencerOk && price.ageSeconds <= maxAgeSeconds && price.price > 0, sequencer };
}));

server.registerTool('get_agent_guard', {
  title: 'AgentGuard status',
  description: 'Reads a deployed AgentGuard: its market, proposal count, oracle settings and, optionally, one agent\'s record (rate limit, strikes, accepted and rejected proposals).',
  inputSchema: { network, guard: address.describe('AgentGuard contract'), agent: address.optional().describe('Agent address to look up') },
  annotations: readOnly,
}, safe(async ({ network, guard, agent }) => {
  const s = await guardStatus(network, guard as Address, agent as Address | undefined);
  return { ...s, strikesToSuspend: STRIKES_TO_SUSPEND };
}));

server.registerTool('preview_agent_proposal', {
  title: 'Preview a proposal onchain',
  description: 'Calls AgentGuard.preview on a deployed guard: runs every check for an agent\'s proposed treasury action without executing it. Nothing is signed or sent.',
  inputSchema: {
    network,
    guard: address.describe('AgentGuard contract'),
    agent: address.describe('Registered agent that would submit the proposal'),
    kind: z.enum(['allocate', 'recall']),
    strategy: address.describe('Strategy the treasury would allocate to or recall from'),
    token: address.describe('Treasury token'),
    amount,
  },
  annotations: readOnly,
}, safe(async ({ network, guard, agent, kind, strategy, token, amount }) => {
  const reason = await previewOnchain(network, guard as Address, agent as Address, { kind, strategy: strategy as Address, token: token as Address, amount: BigInt(amount) });
  return { network, guard, agent, action: { kind, strategy, token, amount }, wouldExecute: reason === 'None', reason };
}));

// ------------------------------------------------------------------ offline guard

server.registerTool('check_agent_proposal', {
  title: 'Simulate AgentGuard',
  description:
    'Runs a proposed treasury action through the same checks as AgentGuard, offline, with market state you supply. ' +
    'Use it to test a proposal before a market is deployed or to explain why the guard would reject it. ' +
    'Checks, in order: agent suspended, market paused, daily rate limit, sequencer and oracle freshness, strategy approval, per-action limit, treasury reserve (allocate) or existing allocation (recall). ' +
    'Amounts are integers in the token\'s smallest unit, passed as strings.',
  inputSchema: {
    kind: z.enum(['allocate', 'recall']),
    amount,
    idle: amount.describe('Treasury balance not allocated to any strategy'),
    totalValue: amount.describe('Idle plus allocated'),
    actionLimit: amount.describe('Largest amount one action may move'),
    allocated: amount.default('0').describe('Already allocated to the strategy (recalls)'),
    reserveBps: z.number().int().min(0).max(10_000).default(3000).describe('Share of total value that must stay idle, in basis points'),
    strategyApproved: z.boolean().default(true),
    usedToday: z.number().int().min(0).default(0),
    maxPerDay: z.number().int().min(0).default(4),
    oracleAgeSeconds: z.number().int().nullable().default(null).describe('Seconds since the price feed updated; null when the market has no feed'),
    oracleMaxAgeSeconds: z.number().int().positive().default(3600),
    sequencerUp: z.boolean().default(true),
    marketPaused: z.boolean().default(false),
    agentSuspended: z.boolean().default(false),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, safe(async (a) => {
  const result = checkProposal(
    {
      agentSuspended: a.agentSuspended, marketPaused: a.marketPaused, usedToday: a.usedToday, maxPerDay: a.maxPerDay,
      oracleAgeSeconds: a.oracleAgeSeconds, oracleMaxAgeSeconds: a.oracleMaxAgeSeconds, sequencerUp: a.sequencerUp,
      strategyApproved: a.strategyApproved, actionLimit: BigInt(a.actionLimit), idle: BigInt(a.idle),
      totalValue: BigInt(a.totalValue), reserveBps: a.reserveBps, allocated: BigInt(a.allocated),
    },
    { kind: a.kind, amount: BigInt(a.amount) },
  );
  return { ...result, note: result.addsStrike ? `A rejection like this adds a strike; ${STRIKES_TO_SUSPEND} strikes suspend the agent.` : undefined };
}));

server.registerTool('backtest_strategy', {
  title: 'Backtest an agent strategy',
  description:
    'Replays a simple treasury strategy over a Base pool\'s price history and sends every proposal through the offline AgentGuard. ' +
    'Reports return against buy and hold, max drawdown and how the guard treated the agent: executions, rejections by reason, strikes and suspension. ' +
    'Strategies: dca (allocate every candle), momentum (allocate above the moving average, recall below it), ' +
    'mean_reversion (allocate when price falls thresholdPct below the average, recall when it gets back). ' +
    'The treasury holds USD; allocating buys the pool\'s base token, recalling sells the whole position. Amounts are in USD.',
  inputSchema: {
    pool: address.describe('Pool address on Base'),
    strategy: z.enum(['dca', 'momentum', 'mean_reversion']).default('momentum'),
    timeframe: z.enum(['day', 'hour']).default('day'),
    candles: z.number().int().min(10).max(1000).default(180).describe('How many candles of history to replay'),
    lookback: z.number().int().min(2).max(200).default(20).describe('Moving-average window in candles'),
    thresholdPct: z.number().positive().max(90).default(5).describe('mean_reversion: buy this far below the average'),
    treasuryUsd: z.number().positive().default(10_000),
    amountUsd: z.number().positive().default(2_500).describe('Size of each proposed allocation'),
    actionLimitUsd: z.number().positive().default(2_500),
    reserveBps: z.number().int().min(0).max(10_000).default(3000),
    maxPerDay: z.number().int().min(1).default(4),
    costBps: z.number().min(0).max(1000).default(30).describe('Swap fee plus slippage per executed action'),
    sizeToGuard: z.boolean().default(true).describe('Guard-aware agent: shrink allocations to what the guard allows. False sends fixed sizes and collects strikes'),
    events: z.number().int().min(0).max(200).default(30).describe('How many of the latest proposals to list'),
  },
  annotations: readOnly,
}, safe(async ({ pool, timeframe, candles, events, ...cfg }) => {
  const history = await gecko.ohlcv(pool, timeframe, candles);
  if (cfg.strategy !== 'dca' && history.length <= cfg.lookback) {
    throw new Error(`only ${history.length} candles available; need more than the ${cfg.lookback}-candle lookback`);
  }
  const r = runBacktest(history, cfg);
  return {
    pool, timeframe, config: cfg,
    ...r,
    events: events ? r.events.slice(-events) : [],
    assumptions: 'Oracle fresh, sequencer up, strategy approved and market open throughout. Strikes never expire. ' +
      'Fills at the candle close with costBps deducted. Past prices say nothing certain about future ones.',
  };
}));

server.registerTool('run_treasury_cycle', {
  title: 'Run the treasury agent',
  description:
    'One cycle of the Bactory treasury agent for a Base token: checks oracle freshness and market liquidity, ranks dca, momentum and mean_reversion ' +
    'on recent daily history, takes today\'s signal from the best one, sizes it to what AgentGuard allows and runs the guard checks. ' +
    'Returns allocate, recall, hold or stand_down with the reasons and a plain-text report. Amounts are in USD. Proposes only; nothing is signed or sent.',
  inputSchema: {
    asset: z.string().min(1).describe('Ticker or token address on Base, e.g. "AERO"'),
    idleUsd: z.number().min(0).default(10_000).describe('Treasury balance not in any strategy'),
    positionUsd: z.number().min(0).default(0).describe('Current value the treasury holds in this market'),
    amountUsd: z.number().positive().default(2_500).describe('Target size of one allocation'),
    actionLimitUsd: z.number().positive().default(2_500),
    reserveBps: z.number().int().min(0).max(10_000).default(3000),
    maxPerDay: z.number().int().min(1).default(4),
    usedToday: z.number().int().min(0).default(0),
    historyDays: z.number().int().min(30).max(365).default(90).describe('Days of history to rank strategies on'),
  },
  annotations: readOnly,
}, safe(async ({ asset, historyDays, ...treasury }) => {
  const r = await runCycle(asset, treasury, { historyDays });
  return { decision: r.plan.decision, amountUsd: r.plan.amountUsd, strategy: r.plan.strategy, reasons: r.plan.reasons, ranking: r.plan.ranking, guard: r.plan.guard, report: report(r) };
}));

// ------------------------------------------------------------------ prompts and resources

server.registerPrompt('propose_treasury_action', {
  title: 'Draft a guarded treasury proposal',
  description: 'Walks through analysing a market and drafting an allocate or recall proposal that passes AgentGuard.',
  argsSchema: { asset: z.string().describe('Token address or ticker on Base'), goal: z.string().optional().describe('What the treasury should achieve') },
}, ({ asset, goal }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text:
        `You are a Bactory market agent. Agents propose; contracts enforce.\n\n` +
        `Asset: ${asset}\nGoal: ${goal ?? 'keep the treasury productive without breaking its reserve'}\n\n` +
        `1. If the asset is not an address, resolve it with search_assets.\n` +
        `2. Run analyze_market and get_oracle_price. Stop and explain if the price is stale or the flags say the market is unsafe.\n` +
        `3. Draft one action: allocate or recall, with an amount. Keep it within the action limit and leave the reserve intact.\n` +
        `4. Run check_agent_proposal (or preview_agent_proposal if a deployed guard address is known). If it is rejected, adjust and check again.\n` +
        `5. Report the final proposal, the checks it passed and the market data behind it. Do not claim anything was executed.`,
    },
  }],
}));

server.registerResource('guard-rules', 'bactory://agent-guard/rules', {
  title: 'AgentGuard rules',
  description: 'How Bactory\'s AgentGuard decides whether an agent\'s proposal executes.',
  mimeType: 'text/markdown',
}, async (uri) => ({
  contents: [{
    uri: uri.href,
    mimeType: 'text/markdown',
    text: `# AgentGuard

Agents never hold market assets and never get admin rights. An agent submits an action
(allocate treasury funds to a strategy, or recall them); the guard checks it and either
executes it through the treasury or records the rejection onchain with its reason.

Checks, in order:

1. **AgentSuspended**: the agent has ${STRIKES_TO_SUSPEND} strikes.
2. **MarketPaused**: allocations are blocked while the market is paused; recalls still work.
3. **RateLimited**: the agent used its proposals for the day.
4. **OracleNotFresh**: the L2 sequencer is down or in its 1 h grace period, or the price feed is older than the limit.
5. **StrategyNotApproved** (allocate): the market admin has not approved the strategy.
6. **ExceedsActionLimit** (allocate): zero, or above the per-action limit.
7. **BreaksReserve** (allocate): the treasury would keep less idle than its reserve share of total value.
8. **InsufficientAllocation** (recall): zero, or more than the strategy holds.

Every rejection except RateLimited and AgentSuspended adds a strike.
Source: https://github.com/bactory-tech
`,
  }],
}));

await server.connect(new StdioServerTransport());
