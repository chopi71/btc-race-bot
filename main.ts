// cbBTC minute-bar trading bot for make.fun's bars-replay race.
//
// Strategy (long only, one position, sized at 60% of equity):
// Trend-follow, but only early in a leg and only while the tape's own
// trend agrees. Enter when the fast EMA is above the slow EMA, price is
// above the slow EMA, the slow EMA is rising versus two hours ago, and
// the 90-minute momentum is positive but not yet extended (<= 55 bps),
// with price still in the lower 85% of its six-hour range: strength,
// bought before the crowd has finished chasing it. Never buy the very
// top of a long leg.
// Exit on a trailing stop under the best close since entry (the trail
// tightens once the trade is up 45 bps, to lock the leg in), on a trend
// break, on momentum rolling over, or when a trade sits underwater for
// 45 minutes. After any exit, cool down 30 minutes before re-entering,
// so chop cannot bleed the account through repeated fees.
import { runBars, type BarsState, type Batch, type OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const EMA_FAST = 20;
const EMA_SLOW = 120;
const MOM_WIN = 90;
const MOM_MIN_BPS = 25;
const MOM_MAX_BPS = 55;
const RANGE_WIN = 360;
const RANGE_MAX = 0.85;
const TRAIL_BPS = 90;
const LOCK_AT_BPS = 45;
const LOCK_TRAIL_BPS = 25;
const UW_MINUTES = 45;
const SIZE_PCT = 60n;
const COOLDOWN = 30;
const MAX_SLIP = 150;

const closes: number[] = [];
const emaSHist: number[] = [];
let emaF: number | null = null;
let emaS: number | null = null;
let peak = 0;
let cool = 0;
let barsIn = 0;
let entryPx = 0;

function ema(prev: number | null, x: number, n: number): number {
  if (prev === null) return x;
  const k = 2 / (n + 1);
  return prev + k * (x - prev);
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] | null {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (!bar) return null;
  const price = Number(bar.c);
  closes.push(price);
  emaF = ema(emaF, price, EMA_FAST);
  emaS = ema(emaS, price, EMA_SLOW);
  emaSHist.push(emaS);
  if (cool > 0) cool -= 1;
  if (state.warmingUp || closes.length < EMA_SLOW + 10) return null;

  const held = state.positions.get(SYMBOL);
  if (held && held.qty > 0n) {
    if (price > peak) peak = price;
    barsIn += 1;
    if (entryPx === 0) entryPx = price;
    const mom = closes[closes.length - 1] / closes[closes.length - 1 - MOM_WIN] - 1;
    const gainBps = entryPx > 0 ? (price / entryPx - 1) * 10000 : 0;
    const trailBps = gainBps > LOCK_AT_BPS ? LOCK_TRAIL_BPS : TRAIL_BPS;
    const trailHit = price < peak * (1 - trailBps / 10000);
    const trendBreak = (emaF as number) < (emaS as number);
    const rolling = mom < -0.0015;
    const underwater = barsIn >= UW_MINUTES && gainBps < -5;
    if (trailHit || trendBreak || rolling || underwater) {
      peak = 0;
      barsIn = 0;
      entryPx = 0;
      cool = COOLDOWN;
      return [{ side: "sell", symbol: SYMBOL, qty: held.qty.toString(), max_slippage_bps: MAX_SLIP }];
    }
    return null;
  }

  if (cool > 0) return null;
  const n = closes.length;
  const mom = closes[n - 1] / closes[n - 1 - MOM_WIN] - 1;
  const momShort = closes[n - 1] / closes[n - 16] - 1;
  const slopeOk = emaSHist.length > 120 && (emaS as number) > emaSHist[emaSHist.length - 121];
  let hi = -Infinity, lo = Infinity;
  for (let i = Math.max(0, n - RANGE_WIN); i < n; i++) {
    if (closes[i] > hi) hi = closes[i];
    if (closes[i] < lo) lo = closes[i];
  }
  const rangePos = (price - lo) / (hi - lo);
  const uptrend = (emaF as number) > (emaS as number) && price > (emaS as number) && slopeOk;
  const strong = mom * 10000 > MOM_MIN_BPS && mom * 10000 <= MOM_MAX_BPS && momShort > 0 && rangePos <= RANGE_MAX;
  if (uptrend && strong) {
    let amount = (state.equity * SIZE_PCT) / 100n;
    const room = state.weightRoom(SYMBOL);
    if (room < amount) amount = room;
    if (state.cash < amount) amount = state.cash;
    // Thin-pool guard: if this size would move the price more than
    // ~14 bps against us, scale down toward a ~10 bps impact instead
    // of paying for size the pool cannot absorb.
    const imp = state.impactBps(SYMBOL, amount);
    if (imp !== null && imp > 14n) {
      amount = (amount * 10n) / imp;
      if (state.cash < amount) amount = state.cash;
    }
    if (amount >= 1_000_000n) {
      peak = price;
      barsIn = 0;
      entryPx = 0;
      return [{ side: "buy", symbol: SYMBOL, notional_quote_units: amount.toString(), max_slippage_bps: MAX_SLIP }];
    }
  }
  return null;
}

runBars({ onBatch });
