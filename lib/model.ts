// Token Radar — model radar-2.
//
// Written from scratch for the token-radar-01 bounty. The sealed snapshot is
// the only data source: no live fetch, no hardcoded list of protocol names.
// Every number on the board follows from the snapshot's own figures.
//
// Method: fit a market-cap/TVL multiple per category on the traded comps
// (protocols whose token has a positive market cap), take the median, and
// price each pre-token protocol as TVL x multiple, adjusted for its 7-day
// TVL growth and for how long it has run. Multiples are rounded to 4 dp
// ONCE, at fit time, so the number a row carries is exactly the number its
// implied value was computed from — the dashboard recomputes from the same
// rounded multiple and agrees to the dollar.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface CategoryMultiple {
  category: string;
  n: number;
  multiple: number;
  source: "category" | "global";
}

export interface BlindTest {
  held_out: number;
  fitted_on: number;
  median_abs_error_pct: number;
  within_2x_pct: number;
  within_3x_pct: number;
}

export interface ModelInfo {
  name: string;
  as_of: string;
  floor_usd: number;
  snapshot_protocols: number;
  comps_n: number;
  global_multiple: number;
  multiples: CategoryMultiple[];
  blind: BlindTest;
  formula: string;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  listed_at: string | null;
  implied_value_usd: number;
  multiple: number;
  multiple_source: "category" | "global";
  multiple_n: number;
  growth_factor: number;
  maturity_factor: number;
  verdict: "Farm" | "Thin" | "Skip";
  farm_steps: string[];
  risks: string[];
  watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  symbol: string | null;
  multiple: number;
}

export interface BoardData {
  model: ModelInfo;
  rows: BoardRow[];
  live: LiveRow[];
  counts: { rows: number; watchlist: number; farm: number; thin: number; skip: number; live: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error("snapshot: expected protocols[] and watchlist[]");
  }
  for (const p of raw.protocols) {
    if (typeof p.slug !== "string" || typeof p.name !== "string" || typeof p.tvl_usd !== "number") {
      throw new Error("snapshot: bad protocol row");
    }
  }
  return raw;
}

/** Median of a non-empty list; null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Days from listed_at to the snapshot date; null when unlisted. */
export function ageDays(listedAt: string | null, asOf: string): number | null {
  if (!listedAt) return null;
  const listed = Date.parse(listedAt + "T00:00:00Z");
  const asOfMs = Date.parse(asOf + "T00:00:00Z");
  if (Number.isNaN(listed) || Number.isNaN(asOfMs)) return null;
  return Math.max(0, Math.round((asOfMs - listed) / DAY_MS));
}

/** Growth adjustment: half the 7-day move, clamped to -60%..+120%. */
export function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  return 1 + (clamp(change7d, -60, 120) / 100) * 0.5;
}

/** Maturity adjustment: 0.6 for a brand-new protocol, rising to 1.0 at 3 years. */
export function maturityFactor(age: number | null): number {
  const days = age === null ? UNKNOWN_AGE_DAYS : age;
  return 0.6 + (Math.min(days, MAX_AGE_DAYS) / MAX_AGE_DAYS) * 0.4;
}

export function impliedValue(tvl: number, multiple: number, change7d: number | null, age: number | null): number {
  const v = tvl * multiple * growthFactor(change7d) * maturityFactor(age);
  return Math.max(1, Math.round(v));
}

/**
 * Traded comps: the protocol records a token with a positive market cap and
 * positive TVL, and is not a CEX (exchange tokens price on the exchange, not
 * on TVL). A token recorded at $0 market cap is not a traded comp — $0 is a
 * dead or unpriced token, not a valuation.
 */
export function tradedComps(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== "CEX",
  );
}

export interface Fit {
  globalMultiple: number;
  byCategory: Map<string, CategoryMultiple>;
}

/** Fit per-category median multiples. Rounded to 4 dp once, at fit time. */
export function fitMultiples(comps: SnapshotProtocol[]): Fit {
  const ratios = comps.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const global = median(ratios);
  if (global === null) throw new Error("fit: no comps");
  const globalMultiple = round4(global);
  const byCategory = new Map<string, CategoryMultiple>();
  const cats = new Map<string, SnapshotProtocol[]>();
  for (const p of comps) {
    const cat = p.category ?? "Uncategorised";
    const list = cats.get(cat) ?? [];
    list.push(p);
    cats.set(cat, list);
  }
  for (const [cat, list] of [...cats.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length >= 5) {
      const m = median(list.map((p) => (p.mcap_usd as number) / p.tvl_usd));
      byCategory.set(cat, { category: cat, n: list.length, multiple: round4(m as number), source: "category" });
    }
  }
  return { globalMultiple, byCategory };
}

export function multipleFor(fit: Fit, category: string | null): CategoryMultiple {
  const hit = category === null ? undefined : fit.byCategory.get(category);
  if (hit) return hit;
  return { category: category ?? "Uncategorised", n: 0, multiple: fit.globalMultiple, source: "global" };
}

/**
 * Blind test: hold out every 5th traded comp by slug, fit on the rest, and
 * predict the held-out tokens' market caps from their TVL with the same
 * formula. Reports the honest error — the model ranks, it does not price.
 */
export function blindTest(comps: SnapshotProtocol[], asOf: string): BlindTest {
  const sorted = [...comps].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const held = sorted.filter((_, i) => i % 5 === 4);
  const train = sorted.filter((_, i) => i % 5 !== 4);
  const fit = fitMultiples(train);
  const errors: number[] = [];
  let within2 = 0;
  let within3 = 0;
  for (const p of held) {
    const m = multipleFor(fit, p.category);
    const pred = impliedValue(p.tvl_usd, m.multiple, p.change_7d, ageDays(p.listed_at, asOf));
    const actual = p.mcap_usd as number;
    const err = Math.abs(pred - actual) / actual;
    errors.push(err);
    const ratio = pred / actual;
    if (ratio >= 0.5 && ratio <= 2) within2 += 1;
    if (ratio >= 1 / 3 && ratio <= 3) within3 += 1;
  }
  const med = median(errors) ?? 0;
  const pct = (x: number): number => Math.round(x * 1000) / 10;
  return {
    held_out: held.length,
    fitted_on: train.length,
    median_abs_error_pct: pct(med),
    within_2x_pct: held.length === 0 ? 0 : pct(within2 / held.length),
    within_3x_pct: held.length === 0 ? 0 : pct(within3 / held.length),
  };
}

// ---------------------------------------------------------------- board rule

const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

const EXCHANGE_PREFIXES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * The house rule's visible half, applied from the snapshot's own fields: the
 * protocol records no token (both gecko_id and symbol null), its category is
 * not a bridge / liquid-staking / CEX bucket, its name carries no version
 * marker and no whole word wrapped / staked / staking, and it does not begin
 * with an exchange's name. parentProtocol is NOT one of the snapshot's ten
 * fields, so it cannot be checked here — that is exactly why protocols at or
 * above the floor that are not on the watchlist are left out: only the
 * watchlist vouches for them. Below the floor, the visible rule is all there
 * is, and it is applied in full.
 */
export function passesNoTokenRule(p: SnapshotProtocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

export function verdictFor(implied: number, change7d: number | null): "Farm" | "Thin" | "Skip" {
  if (implied >= 100_000_000 && (change7d === null || change7d >= -25)) return "Farm";
  if (implied >= 25_000_000) return "Thin";
  return "Skip";
}

// ---------------------------------------------------------------- farm plans

const GAS_USD: Record<string, number> = {
  Ethereum: 25,
  Solana: 2,
  Base: 3,
  Arbitrum: 5,
  Optimism: 5,
  Unichain: 3,
  Binance: 3,
  Avalanche: 5,
  Polygon: 3,
  "Hyperliquid L1": 2,
  Monad: 2,
};

const money = (n: number): string => "$" + n.toLocaleString("en-US");

function positionSize(tvl: number): number {
  if (tvl >= 1_000_000_000) return 1000;
  if (tvl >= 250_000_000) return 500;
  if (tvl >= 50_000_000) return 250;
  return 100;
}

function weeksFor(age: number | null): number {
  if (age === null) return 6;
  if (age >= 365) return 8;
  if (age >= 180) return 6;
  return 4;
}

interface CategoryPlay {
  core: string;
  second: string;
  risk: string;
}

/** Generic on-chain actions per category — verbs, never protocol names. */
function categoryPlay(category: string | null): CategoryPlay {
  switch (category) {
    case "Lending":
    case "Uncollateralized Lending":
    case "Collateral Markets":
      return {
        core: "supply the stablecoins to the lending market as collateral and leave the position earning",
        second: "borrow a small amount against the supplied collateral, then repay it, so the position shows both sides of the market",
        risk: "Liquidation: a sharp fall in the collateral's price can close the position below what was deposited.",
      };
    case "Dexs":
      return {
        core: "swap into the pool's assets and add liquidity to a pool on the main chain, keeping the position in range",
        second: "stake the LP receipt or collect the trading fees weekly instead of letting them sit unclaimed",
        risk: "Impermanent loss: if the paired assets drift apart, the withdrawn value can trail simply holding them.",
      };
    case "Yield":
    case "Yield Aggregator":
    case "Leveraged Farming":
    case "Farm":
      return {
        core: "deposit the stablecoins into the vault or strategy so the position is earning yield from day one",
        second: "compound the yield back into the same vault each week rather than withdrawing it",
        risk: "Strategy risk: the vault's underlying strategy can lose money, and advertised yields fall as more capital arrives.",
      };
    case "RWA":
      return {
        core: "deposit into the tokenised-asset vault and hold the receipt token in the same wallet for the whole period",
        second: "check the vault's underlying holdings and redemption terms before adding a second deposit",
        risk: "Counterparty risk: the tokenised asset depends on an off-chain issuer honouring redemptions.",
      };
    case "Risk Curators":
    case "Onchain Capital Allocator":
      return {
        core: "deposit the stablecoins into a curated vault and leave the allocation to the curator's strategy",
        second: "split the second deposit across a different vault from the same curator so one bad allocation does not take the whole position",
        risk: "Curator risk: a curator's allocation can underperform or concentrate in one venue that fails.",
      };
    case "Derivatives":
    case "Basis Trading":
    case "Interest Rate Derivatives":
      return {
        core: "open a small hedged position — long the spot leg and short the matching perpetual — and keep it delta-neutral",
        second: "rebalance the hedge weekly so funding payments do not quietly eat the position",
        risk: "Funding and liquidation risk: a funding spike or a fast move can close a leveraged hedge at a loss.",
      };
    case "CDP":
    case "Dual-Token Stablecoin":
    case "Stablecoin Wrapper":
      return {
        core: "lock collateral and mint the protocol's stablecoin against it, keeping the collateral ratio well above the minimum",
        second: "use the minted stablecoin in the protocol's own pools instead of selling it outright",
        risk: "Peg and liquidation risk: if the stablecoin depegs or the collateral falls, the position can be liquidated.",
      };
    case "Chain":
      return {
        core: "bridge the stablecoins onto the chain and use its native apps — swap, lend and stake — so the wallet shows real activity",
        second: "stake a small part of the native token with a validator and leave it staked for the whole period",
        risk: "Chain risk: a new chain's bridge, sequencer or validator set is less battle-tested than an established one.",
      };
    case "Staking Pool":
    case "Restaking":
    case "Anchor BTC":
    case "Decentralized BTC":
      return {
        core: "stake the assets through the protocol and hold the receipt token in the same wallet for the whole period",
        second: "restake the receipt token where the protocol offers it, rather than leaving it idle",
        risk: "Slashing and lock-up risk: staked assets can be cut for validator faults and may take days to unstake.",
      };
    case "Liquidity Manager":
      return {
        core: "deposit the stablecoins into a managed liquidity position and let the manager keep the range in place",
        second: "review the manager's range and fee collection weekly and top up only when the range is active",
        risk: "Range risk: a managed position out of range stops earning fees while still carrying price exposure.",
      };
    case "CeDeFi":
      return {
        core: "deposit through the protocol's on-ramp, then move the balance into its on-chain product the same day",
        second: "withdraw a test amount back to self-custody first, so the exit path is proven before the full position goes in",
        risk: "Custody risk: funds held by a centralised party depend on that party staying solvent and honest.",
      };
    case "Payments":
    case "Crypto Card Issuer":
      return {
        core: "top up the account and use it for real payments — a card spend or a transfer — at least once a week",
        second: "keep a standing balance rather than topping up and draining it in one day",
        risk: "Counterparty risk: a payments balance is a claim on the issuer, not self-custodied funds.",
      };
    case "Insurance":
      return {
        core: "buy cover for a position already held elsewhere, so the wallet shows a real policy, not a test transaction",
        second: "provide cover capital to a pool if the protocol offers it, and track the premiums earned",
        risk: "Cover risk: a policy pays only on the events its terms name, and claims can be disputed.",
      };
    case "Prediction Market":
      return {
        core: "take small positions on markets that resolve over weeks, not minutes, and hold them to resolution",
        second: "provide liquidity to a market's order book instead of only betting on outcomes",
        risk: "Resolution risk: a market can resolve on a disputed outcome, and thin markets move on small trades.",
      };
    case "Indexes":
      return {
        core: "buy the index token and hold it as the core position for the whole period",
        second: "rebalance into the index after any large single-asset move rather than chasing the mover",
        risk: "Composition risk: the index is only as good as its constituents and its rebalancing rules.",
      };
    case "Governance Incentives":
      return {
        core: "lock the governance asset and vote on live proposals from the same wallet each voting round",
        second: "delegate the locked voting power to an active delegate if the protocol allows it",
        risk: "Lock-up risk: locked governance tokens cannot be sold quickly if the price falls.",
      };
    default:
      return {
        core: "open a real position in the protocol's app on its main chain and keep it open for the whole period",
        second: "repeat the protocol's core action weekly — deposit, swap or stake — so the wallet shows sustained use, not one transaction",
        risk: "Smart-contract risk: the protocol's contracts are unaudited or young, and a bug can take deposited funds.",
      };
  }
}

const fmtPct = (x: number): string => (x > 0 ? "+" + x.toFixed(1) : x.toFixed(1)) + "%";

/**
 * Six concrete steps per row, derived from the protocol's own snapshot
 * fields — its chains, its category, its TVL and its age. No step names a
 * protocol from a hardcoded list; every figure comes from the row.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains[0] ?? "Ethereum";
  const chain2 = p.chains.length > 1 ? p.chains[1] : chain;
  const gas = GAS_USD[chain] ?? 10;
  const size = positionSize(p.tvl_usd);
  const weeks = weeksFor(age);
  const play = categoryPlay(p.category);
  const ageNote =
    age === null
      ? "no listing date is recorded for it, so treat its track record as unproven"
      : age < 180
        ? `it has only been tracked ${age} days, so treat its track record as short`
        : `it has been tracked ${age} days`;
  const steps = [
    `Set up a fresh wallet for ${chain} and fund it with about ${money(gas * 5)} of the chain's native token for gas — roughly ${money(gas)} a transaction, enough for a month of moves.`,
    `Move about ${money(size)} of USDC onto ${chain} by bridge or on-ramp; keep the transfer receipt, and never send the whole amount in one untested transaction.`,
    `On ${chain}, ${play.core} — this is the position the farm is built on, and it should stay open for at least ${weeks} weeks.`,
    `Then ${play.second}; budget another ${money(Math.max(5, Math.round(gas * 2)))} of gas for the extra transactions and do it in the same week.`,
    `Come back once a week for ${weeks} weeks: top the position up or compound any rewards, and check the protocol's app for points, quests or snapshot notices. ${p.name} records no token, and ${ageNote}.`,
    `To exit, unwind in quiet hours and keep ${money(gas * 2)} of gas aside — withdrawals can queue, and a position closed in a rush pays the worst price. Never deposit money needed back this month.`,
  ];
  void chain2;
  return steps;
}

export function risksFor(p: SnapshotProtocol, age: number | null, blindMedianErrorPct: number): string[] {
  const play = categoryPlay(p.category);
  const second =
    p.change_7d !== null && p.change_7d < -10
      ? `TVL fell ${fmtPct(p.change_7d)} in the last 7 days — a protocol losing deposits can keep falling, and the farm may be catching a falling knife.`
      : age !== null && age < 180
        ? `Only ${age} days of track record — the protocol has not survived a full market cycle, so its contracts and incentives are unproven.`
        : age === null
          ? `No listing date is recorded, so the protocol's age cannot be checked — treat its history as unknown, not as long.`
          : p.chains.length === 1
            ? `All of its TVL sits on one chain (${p.chains[0]}) — a chain outage or a bridge failure hits the whole position at once.`
            : `The implied value is a model estimate, not a price: the blind test misses the true market cap by a median ${blindMedianErrorPct}% — use it to rank, not to size a bet.`;
  return [play.risk, second];
}

// ---------------------------------------------------------------- board build

export function buildBoard(snapshot: Snapshot): BoardData {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const comps = tradedComps(snapshot.protocols);
  const fit = fitMultiples(comps);
  const blind = blindTest(comps, snapshot.as_of);

  const chosen: SnapshotProtocol[] = [];
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p) chosen.push(p);
  }
  for (const p of snapshot.protocols) {
    if (p.tvl_usd >= snapshot.floor_usd) continue; // at/above floor: only the watchlist vouches
    if (watch.has(p.slug)) continue;
    if (passesNoTokenRule(p)) chosen.push(p);
  }

  const rows: BoardRow[] = chosen.map((p) => {
    const age = ageDays(p.listed_at, snapshot.as_of);
    const m = multipleFor(fit, p.category);
    const implied = impliedValue(p.tvl_usd, m.multiple, p.change_7d, age);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      listed_at: p.listed_at,
      implied_value_usd: implied,
      multiple: m.multiple,
      multiple_source: m.source,
      multiple_n: m.n,
      growth_factor: growthFactor(p.change_7d),
      maturity_factor: maturityFactor(age),
      verdict: verdictFor(implied, p.change_7d),
      farm_steps: farmPlan(p, age),
      risks: risksFor(p, age, blind.median_abs_error_pct),
      watchlist: watch.has(p.slug),
    };
  });

  rows.sort((a, b) =>
    b.implied_value_usd - a.implied_value_usd !== 0
      ? b.implied_value_usd - a.implied_value_usd
      : a.slug < b.slug
        ? -1
        : 1,
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const live: LiveRow[] = [...comps]
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      symbol: p.symbol,
      multiple: round4((p.mcap_usd as number) / p.tvl_usd),
    }));

  const multiples: CategoryMultiple[] = [...fit.byCategory.values()].sort((a, b) =>
    a.category < b.category ? -1 : 1,
  );

  const model: ModelInfo = {
    name: "radar-2",
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    snapshot_protocols: snapshot.protocols.length,
    comps_n: comps.length,
    global_multiple: fit.globalMultiple,
    multiples,
    blind,
    formula:
      "implied = max(1, round(TVL x multiple x (1 + clamp(change_7d, -60, 120) / 100 x 0.5) x (0.6 + min(age_days, 1095) / 1095 x 0.4))); multiple is the per-category median mcap/TVL of traded comps (global median when the category has fewer than 5 comps), rounded to 4 dp once at fit time; unknown age counts as 365 days.",
  };

  return {
    model,
    rows,
    live,
    counts: {
      rows: rows.length,
      watchlist: rows.filter((r) => r.watchlist).length,
      farm: rows.filter((r) => r.verdict === "Farm").length,
      thin: rows.filter((r) => r.verdict === "Thin").length,
      skip: rows.filter((r) => r.verdict === "Skip").length,
      live: live.length,
    },
  };
}

/** The dashboard's data file: one global, written beside the page. */
export function dataJs(data: BoardData): string {
  return "window.TOKEN_RADAR_DATA = " + JSON.stringify(data) + ";\n";
}

/** Gate-shaped checks on a finished board; returns error strings, empty when valid. */
export function validateBoard(data: BoardData, snapshot: Snapshot): string[] {
  const errors: string[] = [];
  const rows = data.rows;
  if (rows.length < 100 || rows.length > 4000) errors.push(`rows ${rows.length} outside 100..4000`);
  const slugs = new Set<string>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  rows.forEach((r, i) => {
    if (!known.has(r.slug)) errors.push(`row ${i}: unknown slug ${r.slug}`);
    if (slugs.has(r.slug)) errors.push(`row ${i}: duplicate slug ${r.slug}`);
    slugs.add(r.slug);
    if (r.rank !== i + 1) errors.push(`row ${i}: rank ${r.rank} != ${i + 1}`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      errors.push(`row ${i}: bad implied value`);
    }
    if (i > 0 && rows[i - 1].implied_value_usd < r.implied_value_usd) {
      errors.push(`row ${i}: implied value rises with rank`);
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      errors.push(`row ${i}: ${r.farm_steps.length} farm steps`);
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) errors.push(`row ${i}: farm step length ${t.length}`);
    }
  });
  if (new Set(rows.map((r) => r.implied_value_usd)).size < 2) errors.push("all implied values equal");
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) errors.push(`watchlist slug missing: ${slug}`);
  }
  return errors;
}
