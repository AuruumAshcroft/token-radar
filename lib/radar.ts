// Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks pre-token protocols only. Every row's value comes from the
// snapshot's own figures, never from a hand-kept list of names:
//
//   fdv       = tvl_usd x 0.30          (a token usually lists near a third of TVL)
//   odds      = launch odds from age: a hump that peaks at two years old
//               (0.30 at birth, 0.80 at the peak, back to 0.30 past four years)
//   boost     = 1 + clamp(change_7d, -40, +100) x 0.004
//   implied   = round(fdv x odds x boost x 0.12)
//               (0.12 = the share of the listing value a farmer can expect)
//
// A protocol that already has a token is never ranked: the Live view shows the
// market's own value for those instead.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';

export const MODEL = {
  baseMultiple: 0.3,
  farmerShare: 0.12,
  oddsFloor: 0.3,
  oddsPeak: 0.5,
  peakAgeDays: 730,
  oddsHorizonDays: 1460,
  growthWeight: 0.004,
  growthFloor: -40,
  growthCap: 100,
  unknownAgeDays: 365,
} as const;

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    fdv_usd: number;
    launch_odds: number;
    growth_boost: number;
    farmer_share: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  fdv_usd: number;
  launch_odds: number;
  growth_boost: number;
  farm_steps: string[];
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const DAY_MS = 86_400_000;

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Whole days from `listed` to `asOf`; null when the date is missing or bad. */
export function daysOld(asOf: string, listed: string | null): number | null {
  if (listed === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listed}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** True when the protocol records a token in any of the three fields. */
export function hasToken(p: Proto): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const NO_BOARD_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
const EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A protocol the board may rank: pre-token, standalone, and not a versioned pool. */
export function rankable(p: Proto): boolean {
  if (hasToken(p)) return false;
  if (p.category !== null && NO_BOARD_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/**
 * Launch odds from age: a hump, not a slope. A protocol fresh out of the gate
 * rarely launches tomorrow; one that has run two years without a token is at
 * peak launch pressure; one that has run four years without one has probably
 * chosen not to. Unknown age counts as one year.
 */
export function launchOdds(ageDays: number | null): number {
  const age = ageDays ?? MODEL.unknownAgeDays;
  const t = Math.min(Math.max(age, 0), MODEL.oddsHorizonDays) / 365;
  const peak = t <= 2 ? t / 2 : Math.max(0, 1 - (t - 2) / 2);
  return MODEL.oddsFloor + MODEL.oddsPeak * peak;
}

/** Growth boost from the 7-day TVL change, clamped so one hot week cannot dominate. */
export function growthBoost(change7d: number | null): number {
  const g = change7d === null || !Number.isFinite(change7d) ? 0 : change7d;
  const clamped = Math.min(MODEL.growthCap, Math.max(MODEL.growthFloor, g));
  return 1 + clamped * MODEL.growthWeight;
}

export interface Valuation {
  value: number;
  fdv: number;
  odds: number;
  boost: number;
  ageDays: number | null;
}

/** The implied value one protocol gets: FDV estimate x launch odds x growth x farmer share. */
export function impliedValue(p: Proto, asOf: string): Valuation {
  const ageDays = daysOld(asOf, p.listed_at);
  const fdv = p.tvl_usd * MODEL.baseMultiple;
  const odds = launchOdds(ageDays);
  const boost = growthBoost(p.change_7d);
  const value = Math.max(1, Math.round(fdv * odds * boost * MODEL.farmerShare));
  return { value, fdv: Math.round(fdv), odds: round4(odds), boost: round4(boost), ageDays };
}

/* ------------------------------------------------------------------ */
/* Farm plans                                                          */
/* ------------------------------------------------------------------ */

/** Capital for one farm position, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 20_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger runs get a longer window. */
function holdDaysFor(ageDays: number | null): number {
  if (ageDays === null) return 45;
  if (ageDays < 180) return 60;
  if (ageDays < 365) return 45;
  return 30;
}

/** Gas wording follows the farming chain: Solana is cents, EVM chains are dollars. */
function gasNote(chains: string[]): { first: string; weekly: string } {
  if (chains.length > 0 && chains[0]!.toLowerCase() === 'solana') {
    return { first: 'a few cents of SOL', weekly: 'a few cents of SOL a week' };
  }
  return { first: '$2-5 of gas', weekly: 'about $2 of gas a week' };
}

interface Play {
  core: string;
  weekly: string;
}

/**
 * One core action and one weekly action per category. Placeholders:
 * {name} the protocol, {cap} the capital in dollars, {chain} its first chain.
 * The match runs top to bottom, first hit wins.
 */
const PLAYS: Array<{ test: (category: string) => boolean; play: Play }> = [
  { test: (c) => c.includes('cdp'), play: {
    core: 'Lock ${cap} of collateral in a {name} vault on {chain} and mint a small amount of its stable asset, keeping the vault well above the liquidation line.',
    weekly: 'Top up or adjust the vault once so the position stays active, and check the collateral ratio while you are there.' } },
  { test: (c) => c.includes('yield aggregator'), play: {
    core: 'Deposit ${cap} of USDC into {name}\u2019s largest vault on {chain} and hold the vault shares.',
    weekly: 'Claim or compound the vault yield once a week and leave the principal in the vault.' } },
  { test: (c) => c.includes('risk curator') || c.includes('allocator') || c.includes('curator'), play: {
    core: 'Deposit ${cap} of USDC into a {name} vault on {chain} and hold the shares through at least one rebalance.',
    weekly: 'Review the vault allocation after each rebalance and keep the shares in place.' } },
  { test: (c) => c.includes('basis'), play: {
    core: 'Deposit ${cap} of USDC into {name}\u2019s basis vault on {chain} and keep the position open through a full funding cycle.',
    weekly: 'Check the funding rate and the vault performance once a week, and leave the position running.' } },
  { test: (c) => c.includes('leveraged'), play: {
    core: 'Open a ${cap} leveraged farming position on {name} on {chain} at low leverage and watch the health factor.',
    weekly: 'Check the health factor and rebalance once a week so the position never gets close to liquidation.' } },
  { test: (c) => c.includes('perpetual') || c.includes('derivative'), play: {
    core: 'Deposit ${cap} of USDC as margin on {name} on {chain} and open one small hedged position, then close it after a few days.',
    weekly: 'Open and close one small position a week so the account shows steady trading activity.' } },
  { test: (c) => c.includes('lending') || c.includes('lend'), play: {
    core: 'Supply ${cap} of USDC to {name} on {chain} and leave the supply position open as collateral.',
    weekly: 'Borrow $10-20 of a stablecoin against the collateral once, repay it the same week, and leave the supply in place.' } },
  { test: (c) => c.includes('dex'), play: {
    core: 'Swap ${cap} of USDC into the pool\u2019s other asset on {name} on {chain}, then add both sides as liquidity and leave the LP position open.',
    weekly: 'Swap $10-25 through {name} once a week so the wallet shows repeat volume instead of one deposit.' } },
  { test: (c) => c.includes('bridge'), play: {
    core: 'Bridge ${cap} of USDC to {chain} through {name}, then put the bridged funds to work in the destination app instead of bridging straight back.',
    weekly: 'Bridge a small amount ($10-25) in either direction once a week to keep the route active.' } },
  { test: (c) => c.includes('staking') || c.includes('restak'), play: {
    core: 'Stake ${cap} of the chain asset through {name} on {chain} and keep the staking receipt in the farming wallet.',
    weekly: 'Claim the staking rewards once a week and restake them.' } },
  { test: (c) => c.includes('prediction'), play: {
    core: 'Fund the wallet with ${cap} and place one small prediction position on {name}, then settle it and keep the history.',
    weekly: 'Place one small market position a week on {name} so the account stays active.' } },
  { test: (c) => c.includes('insurance'), play: {
    core: 'Buy ${cap} of cover from {name} on {chain} and keep the policy active.',
    weekly: 'Review the policy and the covered positions once a week, and renew before it lapses.' } },
  { test: (c) => c.includes('stable'), play: {
    core: 'Mint or hold ${cap} of the stable asset through {name} on {chain}, then use it in one on-chain action a week.',
    weekly: 'Use the stable asset in a swap or a deposit once a week so the wallet shows real usage.' } },
  { test: (c) => c.includes('rwa'), play: {
    core: 'Mint or buy ${cap} of {name}\u2019s yield-bearing asset on {chain} and hold it in the farming wallet.',
    weekly: 'Check the asset\u2019s yield accrual once a week and keep the holding untouched.' } },
  { test: (c) => c.includes('yield'), play: {
    core: 'Deposit ${cap} of USDC into {name}\u2019s highest-yield pool on {chain} and keep the position open.',
    weekly: 'Harvest the yield once a week and redeposit it so the balance compounds.' } },
  { test: (c) => c.includes('payment'), play: {
    core: 'Route ${cap} of USDC through {name} on {chain} for a real payment or transfer, and keep the receipt.',
    weekly: 'Make one small payment through {name} each week.' } },
];

const FALLBACK_PLAY: Play = {
  core: 'Deposit ${cap} of USDC into {name} on {chain} and keep the position open, then use the app\u2019s main feature once a week.',
  weekly: 'Use {name}\u2019s main feature once a week so the wallet shows repeat activity.',
};

function fill(template: string, name: string, cap: number, chain: string): string {
  return template.replaceAll('{name}', name).replaceAll('${cap}', () => `$${cap}`).replaceAll('{chain}', chain);
}

/** One step, kept inside the gate's 20..600 characters. */
function fitStep(text: string): string {
  if (text.length > 600) return `${text.slice(0, 597)}...`;
  if (text.length < 20) return `${text} Keep the position open and check the protocol's own page.`;
  return text;
}

/**
 * A protocol's farm plan: six steps, each an action with its cost and time.
 * Everything derives from the protocol's own record (category, chains, TVL,
 * age); no protocol name is ever special-cased.
 */
export function farmPlan(p: Proto, ageDays: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const cap = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(ageDays);
  const gas = gasNote(p.chains);
  const category = (p.category ?? '').toLowerCase();
  const play = PLAYS.find((entry) => entry.test(category))?.play ?? FALLBACK_PLAY;
  return [
    fitStep(`Set up a fresh wallet that holds only the funds you plan to farm, and store its seed phrase offline. Cost: ${gas.first} for the first transaction. Time: 5 minutes.`),
    fitStep(`${fill(play.core, p.name, cap, chain)} Cost: $${cap} of capital plus ${gas.first}. Time: 15 minutes to set up.`),
    fitStep(`${fill(play.weekly, p.name, cap, chain)} Cost: ${gas.weekly}. Time: 10 minutes a week.`),
    fitStep(`Open ${p.name}'s own points or rewards page once a week and write down the points balance; only follow links the protocol itself publishes. Cost: free to check. Time: 10 minutes a week.`),
    fitStep(`Hold the position for at least ${hold} days so the activity lands in more than one snapshot. Cost: the $${cap} stays in the position. Time: ${hold} days.`),
    fitStep(`When the token launches, claim only from the protocol's own page and never pay anyone to claim for you; write the wallet, the dates and every transaction in a farm log. Cost: gas to claim. Time: 15 minutes.`),
  ];
}

/* ------------------------------------------------------------------ */
/* Board, live set, payload                                            */
/* ------------------------------------------------------------------ */

const bySlugDesc = (a: Proto, b: Proto): number =>
  b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** The ranked board: every watchlist slug, plus every rankable protocol below the floor. */
export function buildBoard(snap: Snap): BoardRow[] {
  const index = new Map(snap.protocols.map((p) => [p.slug, p]));
  const picked = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) picked.set(slug, p);
  }
  const early = snap.protocols
    .filter((p) => !picked.has(p.slug) && rankable(p) && p.tvl_usd < snap.floor_usd)
    .sort(bySlugDesc);
  for (const p of early) picked.set(p.slug, p);

  const valued = [...picked.values()].map((p) => ({ p, v: impliedValue(p, snap.as_of) }));
  valued.sort((a, b) => b.v.value - a.v.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return valued.map((entry, i) => {
    const p = entry.p;
    const v = entry.v;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: v.ageDays,
      implied_value_usd: v.value,
      model: {
        fdv_usd: v.fdv,
        launch_odds: v.odds,
        growth_boost: v.boost,
        farmer_share: MODEL.farmerShare,
        age_days: v.ageDays,
      },
      farm_steps: farmPlan(p, v.ageDays),
    };
  });
}

/** The live-token comparison set: token-bearing protocols by market cap. */
export function liveSet(snap: Snap): LiveRow[] {
  return snap.protocols
    .filter((p) => hasToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot and the board. */
export function radarPayload(snap: Snap, board: BoardRow[], live: LiveRow[]): RadarData {
  const early = board.filter((r) => !snap.watchlist.includes(r.slug)).length;
  return {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    watchlist: snap.watchlist,
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      fdv_usd: r.model.fdv_usd,
      launch_odds: r.model.launch_odds,
      growth_boost: r.model.growth_boost,
      farm_steps: r.farm_steps,
    })),
    live,
  };
}

/** The dashboard's dataset as one script tag's worth of JavaScript, no fetch. */
export function dataScript(payload: RadarData): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}

/* ------------------------------------------------------------------ */
/* Snapshot parsing and board validation                               */
/* ------------------------------------------------------------------ */

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapError('snapshot.json has no watchlist of slugs');
  }
  const protocols: Proto[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapError(`snapshot.json protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, steps, values. */
export function boardProblems(board: BoardRow[], snap: Snap): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (typeof r.name !== 'string' || r.name.trim() === '') return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}
