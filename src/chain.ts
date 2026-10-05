// Onchain reads on Base: Chainlink prices, the sequencer feed and a deployed AgentGuard.

import { createPublicClient, http, parseAbi, type Address, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { Rejection } from './guard.js';
import { REJECTIONS } from './guard.js';

export const NETWORKS = {
  base: {
    chain: base,
    ethUsdFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as Address,
    sequencerFeed: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433' as Address,
  },
  'base-sepolia': {
    chain: baseSepolia,
    ethUsdFeed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1' as Address,
    sequencerFeed: null,
  },
} as const;
export type NetworkName = keyof typeof NETWORKS;

const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
]);

const guardAbi = parseAbi([
  'struct Action { uint8 kind; address strategy; address token; uint256 amount; }',
  'struct AgentInfo { bool registered; bool suspended; uint16 maxPerDay; uint16 usedToday; uint32 dayIndex; uint32 accepted; uint32 rejected; uint8 strikes; }',
  'function preview(address agent, Action action) view returns (uint8)',
  'function agentInfo(address agent) view returns (AgentInfo)',
  'function proposalCount() view returns (uint256)',
  'function market() view returns (address)',
  'function oracleFeed() view returns (address)',
  'function oracleMaxAge() view returns (uint32)',
]);

const clients: Partial<Record<NetworkName, PublicClient>> = {};
function client(network: NetworkName): PublicClient {
  const rpc = network === 'base' ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
  return (clients[network] ??= createPublicClient({ chain: NETWORKS[network].chain, transport: http(rpc) }) as PublicClient);
}

export async function readFeed(network: NetworkName, feed: Address) {
  const c = client(network);
  const [round, decimals, description] = await Promise.all([
    c.readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' }),
    c.readContract({ address: feed, abi: feedAbi, functionName: 'decimals' }),
    c.readContract({ address: feed, abi: feedAbi, functionName: 'description' }).catch(() => ''),
  ]);
  const [, answer, , updatedAt] = round;
  const now = Math.floor(Date.now() / 1000);
  return {
    feed, description,
    price: Number(answer) / 10 ** decimals,
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
    ageSeconds: now - Number(updatedAt),
  };
}

/** Chainlink sequencer uptime feed: answer 0 means up. A one hour grace period follows a restart. */
export async function readSequencer(network: NetworkName) {
  const feed = NETWORKS[network].sequencerFeed;
  if (!feed) return null;
  const [, answer, startedAt] = await client(network).readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' });
  const up = answer === 0n;
  const sinceSeconds = Math.floor(Date.now() / 1000) - Number(startedAt);
  return { up, sinceSeconds, inGracePeriod: up && sinceSeconds < 3600 };
}

export async function previewOnchain(network: NetworkName, guard: Address, agent: Address, action: { kind: 'allocate' | 'recall'; strategy: Address; token: Address; amount: bigint }): Promise<Rejection> {
  const r = await client(network).readContract({
    address: guard, abi: guardAbi, functionName: 'preview',
    args: [agent, { kind: action.kind === 'allocate' ? 0 : 1, strategy: action.strategy, token: action.token, amount: action.amount }],
  });
  return REJECTIONS[Number(r)] ?? 'None';
}

export async function guardStatus(network: NetworkName, guard: Address, agent?: Address) {
  const c = client(network);
  const [market, proposalCount, oracleFeed, oracleMaxAge] = await Promise.all([
    c.readContract({ address: guard, abi: guardAbi, functionName: 'market' }),
    c.readContract({ address: guard, abi: guardAbi, functionName: 'proposalCount' }),
    c.readContract({ address: guard, abi: guardAbi, functionName: 'oracleFeed' }),
    c.readContract({ address: guard, abi: guardAbi, functionName: 'oracleMaxAge' }),
  ]);
  const info = agent ? await c.readContract({ address: guard, abi: guardAbi, functionName: 'agentInfo', args: [agent] }) : null;
  return {
    guard, market, proposalCount: proposalCount.toString(), oracleFeed, oracleMaxAgeSeconds: oracleMaxAge,
    agent: info && agent ? { address: agent, ...info } : null,
  };
}
