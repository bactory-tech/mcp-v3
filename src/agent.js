#!/usr/bin/env node
// Runs one treasury agent cycle from the command line and prints the proposal.
//   npm run agent -- AERO --idle 10000 --position 0
// Read and propose only: no key, no signature, no transaction.

import { parseArgs } from 'node:util';
import { report, runCycle } from './treasury.js';

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    idle: { type: 'string', default: '10000' },
    position: { type: 'string', default: '0' },
    amount: { type: 'string', default: '2500' },
    limit: { type: 'string', default: '2500' },
    reserve: { type: 'string', default: '3000' },
    'max-per-day': { type: 'string', default: '4' },
    used: { type: 'string', default: '0' },
    days: { type: 'string', default: '90' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const asset = positionals[0];
if (v.help || !asset) {
  console.log(`usage: bactory-agent <ticker or token address> [options]

  --idle <usd>         treasury balance not in any strategy   (10000)
  --position <usd>     current value held in this market      (0)
  --amount <usd>       target size of one allocation          (2500)
  --limit <usd>        guard per-action limit                 (2500)
  --reserve <bps>      share that must stay idle              (3000)
  --max-per-day <n>    proposals allowed per day              (4)
  --used <n>           proposals already made today           (0)
  --days <n>           days of history to rank strategies on  (90)
  --json               print the full result as JSON`);
  process.exit(asset ? 0 : 1);
}

const n = (s: string) => {
  const x = Number(s);
  if (!Number.isFinite(x) || x < 0) throw new Error(`not a valid number: ${s}`);
  return x;
};

try {
  const r = await runCycle(asset, {
    idleUsd: n(v.idle), positionUsd: n(v.position), amountUsd: n(v.amount), actionLimitUsd: n(v.limit),
    reserveBps: n(v.reserve), maxPerDay: n(v['max-per-day']), usedToday: n(v.used),
  }, { historyDays: n(v.days) });
  console.log(v.json ? JSON.stringify(r, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2) : report(r));
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
