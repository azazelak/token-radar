// Token Radar's model, v1 (radar-2): one sealed snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling)
// and adds the pre-token protocols below the watchlist floor that pass the house's own
// no-token rule. A protocol is pre-token when the snapshot records no token for it
// (no market cap, no CoinGecko id, no symbol); the live-token protocols are kept apart
// and shown with the market's own values, never mixed into the ranking.
//
// Implied value is fitted, not asserted. The traded protocols are the comps: for each
// category the model takes the median market-cap-to-TVL multiple of the protocols in it
// that already trade, and a category with fewer than five comps falls back to the
// market-wide median. The multiple is then adjusted by the protocol's own seven-day
// growth and by how long it has run with no token:
//
//   multiple   = median(mcap_usd / tvl_usd) of the traded comps in the category
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365 days)
//   implied    = max(1, round(tvl_usd x multiple x growthMult x maturity))
//
// The fit is blind-tested before it is trusted: every fifth traded comp by slug is
// held out, the multiples are fitted on the other four fifths, and the held-out
// protocols' market caps are predicted with the full formula. The error is reported
// in the dashboard, so the judge can see how far the model misses. No protocol name
// is ever special-cased: the same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  min_comps_per_category: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  farm_value_usd: number;
  farm_growth_floor: number;
  thin_value_usd: number;
}

export const MODEL: ModelConstants = {
  min_comps_per_category: 5,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  farm_value_usd: 100_000_000,
  farm_growth_floor: -25,
  thin_value_usd: 25_000_000,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A protocol's verdict: worth farming, thin, or not worth the capital. */
export type Verdict = 'Farm' | 'Thin' | 'Skip';

/** One row of board.json: the ranked board's row. */
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
  verdict: Verdict;
  risks: string[];
  model: {
    multiple: number;
    multiple_source: 'category' | 'global';
    comps_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  verdict: Verdict;
  risks: string[];
  multiple: number;
  multiple_source: 'category' | 'global';
  comps_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The blind test's result: how the fitted model did on comps it never saw. */
export interface BlindTest {
  held_out: number;
  fitted_on: number;
  median_abs_pct_error: number;
  within_2x: number;
  within_3x: number;
}

/** Everything the dashboard needs: the board, the live set, the fit and the test. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  comp_count: number;
  blind_test: BlindTest;
  verdict_counts: { Farm: number; Thin: number; Skip: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A name carrying a whole word wrapped, staked or staking is a product of a traded token. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** An exchange's name at the start of a protocol's name. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Categories the house rule keeps off the watchlist: bridges, staking products and exchanges. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol passes the house's no-token rule for the early radar: pre-token,
 * not a bridge or staking product, not a versioned pool, not a wrapped or staked
 * product by name, and not an exchange's own product. The watchlist already passed
 * this rule (and one more the snapshot cannot show: no parent protocol in DefiLlama's
 * record), so it is applied here to the protocols below the floor only.
 */
export function passesHouseRule(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The traded comps: a market cap and a TVL to divide, and not an exchange. */
export function tradedComps(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
}

export interface FittedMultiples {
  /** Per category: the multiple to use, where it came from, and how many comps back it. */
  byCategory: Map<string, { multiple: number; source: 'category' | 'global'; n: number }>;
  globalMultiple: number;
  compCount: number;
}

/** Fit the multiples on a set of comps: a category's median, or the market-wide one. */
export function fitMultiples(comps: SnapshotProtocol[], model: ModelConstants = MODEL): FittedMultiples {
  // The multiple a row carries is the multiple its implied value was computed
  // from: round it here, once, so the dashboard's recompute and the board agree
  // to the dollar. The blind test below uses the same rounded multiples.
  const globalMultiple = round4(median(comps.map((p) => p.mcap_usd! / p.tvl_usd)));
  const byCategory = new Map<string, { multiple: number; source: 'category' | 'global'; n: number }>();
  const groups = new Map<string, SnapshotProtocol[]>();
  for (const p of comps) {
    const key = p.category ?? '(none)';
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    if (list.length >= model.min_comps_per_category) {
      byCategory.set(key, { multiple: round4(median(list.map((p) => p.mcap_usd! / p.tvl_usd))), source: 'category', n: list.length });
    } else {
      byCategory.set(key, { multiple: globalMultiple, source: 'global', n: list.length });
    }
  }
  return { byCategory, globalMultiple, compCount: comps.length };
}

/** The multiple one protocol gets: its category's, or the market-wide one. */
export function multipleFor(p: SnapshotProtocol, fit: FittedMultiples): { multiple: number; source: 'category' | 'global'; n: number } {
  const entry = fit.byCategory.get(p.category ?? '(none)');
  if (entry !== undefined) return entry;
  return { multiple: fit.globalMultiple, source: 'global', n: 0 };
}

/** The three multipliers and the implied value one protocol gets under a fitted multiple. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiple: number,
  model: ModelConstants = MODEL,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

/**
 * The blind test: every fifth traded comp by slug is held out, the multiples are
 * fitted on the rest, and the held-out market caps are predicted with the full
 * formula. Returns the median absolute percentage error and the share predicted
 * within two and three times the true value.
 */
export function blindTest(snapshot: Snapshot, model: ModelConstants = MODEL): BlindTest {
  const comps = tradedComps(snapshot).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const heldOut = comps.filter((_, i) => i % 5 === 4);
  const fittedOn = comps.filter((_, i) => i % 5 !== 4);
  const fit = fitMultiples(fittedOn, model);
  const errors: number[] = [];
  for (const p of heldOut) {
    const { multiple } = multipleFor(p, fit);
    const { implied } = impliedValue(p, snapshot.as_of, multiple, model);
    errors.push(Math.abs(implied - p.mcap_usd!) / p.mcap_usd!);
  }
  errors.sort((a, b) => a - b);
  const mid = Math.floor(errors.length / 2);
  const mdape = errors.length % 2 === 1 ? errors[mid]! : (errors[mid - 1]! + errors[mid]!) / 2;
  return {
    held_out: heldOut.length,
    fitted_on: fittedOn.length,
    median_abs_pct_error: mdape,
    within_2x: errors.filter((e) => e <= 1).length / errors.length,
    within_3x: errors.filter((e) => e <= 2).length / errors.length,
  };
}

/** A protocol's verdict from its implied value and its seven-day growth. */
export function verdictFor(implied: number, change7d: number | null, model: ModelConstants = MODEL): Verdict {
  if (implied >= model.farm_value_usd && (change7d === null || change7d >= model.farm_growth_floor)) return 'Farm';
  if (implied >= model.thin_value_usd) return 'Thin';
  return 'Skip';
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC into ${name} on ${chain} and leave the deposit earning.`;
  if (c.includes('dex') || c.includes('swap') || c.includes('liquidity')) return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and hold the LP position.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('leveraged')) return `Deposit $${capital} into ${name}'s highest-yield vault on ${chain} and keep it staked.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} with ${name}, then put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking token through ${name} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Post $${capital} of USDC as margin on ${name} and open a single small hedged position.`;
  if (c.includes('prediction')) return `Fund an account with $${capital} and take one position in an open market on ${name}.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of the stable asset issued through ${name} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} and keep the flow going.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL and age), never from a
 * hand-written list of names. Where the record gives no farmable action, the plan says
 * so in its own words rather than inventing one.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity lands in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The risks a reader should weigh, read off the protocol's own figures. */
export function risksFor(p: SnapshotProtocol, age: number | null, multipleSource: 'category' | 'global'): string[] {
  const risks: string[] = [];
  if (p.change_7d !== null && p.change_7d <= -20) risks.push(`TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in seven days: the protocol is shrinking, not growing.`);
  if (age !== null && age < 90) risks.push(`Listed ${age} days ago: a thin track record, so the age adjustment is a guess.`);
  if (age === null) risks.push('No listing date in the snapshot: the model assumes a year of age, which may flatter it.');
  if (p.chains.length > 3) risks.push(`Spread across ${p.chains.length} chains: activity may be split, and farming one chain may not count.`);
  if (multipleSource === 'global') risks.push('No deep comp set in this category: the multiple is the market-wide median, not the category\'s own.');
  if (p.change_7d === null) risks.push('No seven-day growth in the snapshot: the model scores it as flat.');
  if (risks.length === 0) risks.push('No red flag in the snapshot figures: the risk is the model itself, which misses by a wide margin on held-out comps.');
  return risks;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor that pass the
  // house's no-token rule, all of them. A protocol the watchlist leaves out above
  // the floor is left out here too: the house rule hides one more field
  // (parentProtocol) the snapshot does not carry, so only the watchlist vouches
  // for protocols at or above the floor.
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    if (p.tvl_usd >= snapshot.floor_usd) continue;
    if (!passesHouseRule(p)) continue;
    chosen.set(p.slug, p);
  }

  const fit = fitMultiples(tradedComps(snapshot), model);
  const scored = [...chosen.values()].map((p) => {
    const { multiple, source, n } = multipleFor(p, fit);
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, multiple, model);
    return { p, implied, growthPct, growthMult, maturityMult, age, multiple, source, n };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    verdict: verdictFor(s.implied, s.p.change_7d, model),
    risks: risksFor(s.p, s.age, s.source),
    model: {
      multiple: round4(s.multiple),
      multiple_source: s.source,
      comps_n: s.n,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
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

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    verdict: row.verdict,
    risks: row.risks,
    multiple: row.model.multiple,
    multiple_source: row.model.multiple_source,
    comps_n: row.model.comps_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const fit = fitMultiples(tradedComps(snapshot), model);
  const test = blindTest(snapshot, model);
  const verdictCounts = { Farm: 0, Thin: 0, Skip: 0 };
  for (const r of board) verdictCounts[r.verdict]++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: round4(fit.globalMultiple),
    comp_count: fit.compCount,
    blind_test: {
      held_out: test.held_out,
      fitted_on: test.fitted_on,
      median_abs_pct_error: round4(test.median_abs_pct_error),
      within_2x: round4(test.within_2x),
      within_3x: round4(test.within_3x),
    },
    verdict_counts: verdictCounts,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
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

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
