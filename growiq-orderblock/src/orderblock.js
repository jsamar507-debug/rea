// GrowIQ Order Block engine — clean-room implementation.
//
// Rebuilt only from OrderBlock's (order-block.com) published description of
// its behaviour. No code, data or assets were taken from that product.
// See ../SPEC.md for the observed-vs-inferred breakdown behind each rule.
//
// Pure ES module, no dependencies. Every function is deterministic given its
// inputs so it can run in a browser, a Node worker or a serverless function.
//
// Candle shape: { t: epoch ms, o, h, l, c, v }  (finished candles only)

export const DEFAULTS = Object.freeze({
  swingStrength: 2, // bars on each side of a fractal swing point
  openingRangeBars: 3, // 3 x 5-min = first 15 minutes
  avgRangeBars: 20, // lookback for "average candle" size
  stopBufferFrac: 0.1, // S1 sits this many avg ranges beyond the block
  equalLevelTolFrac: 0.15, // equal highs/lows tolerance, in avg ranges
  sideThreshold: 0.5, // |strength| below this = choppy (score 0)
  eventRiskStrength: 5, // |strength| at/above this = event risk, no levels
  boardSize: 20, // stocks analysed per side
  picksPerSide: 3,
  sectorCap: 2, // max picks from one sector per side
  projectionMultiples: [1.5, 3], // fallback R1/R2 in risk multiples
  minRR: 1.5,
});

// ---------------------------------------------------------------- helpers

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export function averageRange(candles, bars = DEFAULTS.avgRangeBars) {
  const tail = candles.slice(-bars);
  return mean(tail.map((k) => k.h - k.l));
}

export function vwap(candles) {
  let pv = 0;
  let vol = 0;
  for (const k of candles) {
    pv += ((k.h + k.l + k.c) / 3) * k.v;
    vol += k.v;
  }
  return vol ? pv / vol : null;
}

// Mirror prices so bearish detection reuses the bullish code path.
function mirror(candles) {
  return candles.map((k) => ({ ...k, o: -k.o, h: -k.l, l: -k.h, c: -k.c }));
}

// Fractal swing points: a high with `n` lower highs on each side.
export function swingPoints(candles, n = DEFAULTS.swingStrength) {
  const highs = [];
  const lows = [];
  for (let i = n; i < candles.length - n; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= n; j++) {
      if (!(candles[i].h > candles[i - j].h && candles[i].h > candles[i + j].h)) isHigh = false;
      if (!(candles[i].l < candles[i - j].l && candles[i].l < candles[i + j].l)) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].h });
    if (isLow) lows.push({ index: i, price: candles[i].l });
  }
  return { highs, lows };
}

// ------------------------------------------------------- strength & board

/**
 * Strength = today's % move divided by the stock's own typical daily move
 * (stdev of the last 50 daily returns). A 2% move in a quiet stock scores
 * higher than a 2% move in a volatile one.
 */
export function strengthScore({ prevClose, last, dailyCloses }) {
  const rets = [];
  for (let i = 1; i < dailyCloses.length; i++) {
    rets.push((dailyCloses[i] - dailyCloses[i - 1]) / dailyCloses[i - 1]);
  }
  const sigma = stdev(rets.slice(-50));
  const change = (last - prevClose) / prevClose;
  return { change, sigma, strength: sigma ? change / sigma : 0 };
}

function classify(strength, cfg) {
  if (strength >= cfg.sideThreshold) return 'bullish';
  if (strength <= -cfg.sideThreshold) return 'bearish';
  return 'choppy';
}

// ------------------------------------------------------- order blocks

/**
 * Bullish order blocks on finished candles.
 *  1. Break of structure: a candle CLOSES above an unbroken swing high or the
 *     opening-range high (a wick does not count).
 *  2. The block is the last red candle before the leg that made the break.
 *  3. Displacement proof: the leg left a fair value gap, or the breaking close
 *     is at least one average candle beyond the block's high.
 *  4. A block dies once any later candle closes below its low.
 */
function detectBullishBlocks(candles, cfg) {
  const n = candles.length;
  if (n < cfg.openingRangeBars + 2) return [];
  const avgR = averageRange(candles, cfg.avgRangeBars) || 1e-9;
  const { highs } = swingPoints(candles, cfg.swingStrength);

  const orHigh = Math.max(...candles.slice(0, cfg.openingRangeBars).map((k) => k.h));
  const refs = [
    { index: cfg.openingRangeBars - 1, price: orHigh, kind: 'opening-range' },
    ...highs.map((s) => ({ ...s, kind: 'swing' })),
  ];
  const broken = new Set();
  const blocks = [];

  for (let i = 1; i < n; i++) {
    for (const ref of refs) {
      // A swing is only known once its right-hand bars have printed.
      const confirmedAt = ref.kind === 'swing' ? ref.index + cfg.swingStrength : ref.index;
      if (broken.has(ref) || confirmedAt >= i) continue;
      if (!(candles[i].c > ref.price && candles[i - 1].c <= ref.price)) continue;
      broken.add(ref);

      // Lowest point of the leg between the reference and the break.
      let m = ref.index;
      for (let k = ref.index; k < i; k++) if (candles[k].l < candles[m].l) m = k;
      let j = m;
      while (j >= 0 && !(candles[j].c < candles[j].o)) j--;
      if (j < 0) continue;

      let fvg = false;
      for (let k = j + 1; k + 1 <= i; k++) {
        if (k - 1 >= 0 && candles[k + 1].l > candles[k - 1].h) fvg = true;
      }
      const displaced = fvg || candles[i].c - candles[j].h >= avgR;
      if (!displaced) continue;

      let invalidatedAt = null;
      for (let k = i + 1; k < n; k++) {
        if (candles[k].c < candles[j].l) {
          invalidatedAt = k;
          break;
        }
      }
      blocks.push({
        side: 'bullish',
        blockIndex: j,
        breakIndex: i,
        brokeLevel: ref.price,
        brokeKind: ref.kind,
        low: candles[j].l,
        high: candles[j].h,
        proof: fvg ? 'fvg' : 'range',
        invalidatedAt,
        valid: invalidatedAt === null,
      });
    }
  }
  return blocks;
}

export function detectOrderBlocks(candles, side, cfg = DEFAULTS) {
  if (side === 'bullish') return detectBullishBlocks(candles, cfg);
  return detectBullishBlocks(mirror(candles), cfg).map((b) => ({
    ...b,
    side: 'bearish',
    low: -b.high,
    high: -b.low,
    brokeLevel: -b.brokeLevel,
  }));
}

// ---------------------------------------------------------- liquidity

/**
 * Resting liquidity: swing highs/lows no later candle has CLOSED beyond,
 * plus equal highs/lows (two or more swings within tolerance).
 */
export function liquidityLevels(candles, cfg = DEFAULTS) {
  const { highs, lows } = swingPoints(candles, cfg.swingStrength);
  const tol = averageRange(candles, cfg.avgRangeBars) * cfg.equalLevelTolFrac;
  const unclosed = (pts, beyond) =>
    pts.filter((p) => !candles.slice(p.index + 1).some((k) => beyond(k.c, p.price)));
  const groupEqual = (pts) => {
    const out = [];
    for (const p of pts) {
      const g = out.find((x) => Math.abs(x.price - p.price) <= tol);
      if (g) {
        g.touches++;
        g.price = Math.max(g.price, p.price);
      } else out.push({ price: p.price, touches: 1 });
    }
    return out;
  };
  return {
    above: groupEqual(unclosed(highs, (c, p) => c > p)).map((x) => ({ ...x, equal: x.touches > 1 })),
    below: groupEqual(unclosed(lows, (c, p) => c < p)).map((x) => ({ ...x, equal: x.touches > 1 })),
  };
}

// ------------------------------------------------------------- setup

/**
 * Builds the popup levels for one side. Bullish names; bearish is mirrored:
 *   zone  — Z, the block's near edge
 *   stop  — S1 (bull) / R1 (bear): just beyond the far edge; a close past it
 *           means the setup is wrong
 *   targets — R1, R2 (bull) / S1, S2 (bear): liquidity ahead, else projections
 *   rr    — (Z → 2nd target) / (Z → stop)
 */
export function buildSetup(candles, side, cfg = DEFAULTS) {
  const blocks = detectOrderBlocks(candles, side, cfg);
  const current = [...blocks].reverse().find((b) => b.valid) || null;
  const last = candles.at(-1);
  const avgR = averageRange(candles, cfg.avgRangeBars);
  const vw = vwap(candles);
  const base = {
    side,
    last: last?.c ?? null,
    vwap: round2(vw),
    history: blocks.filter((b) => b !== current),
  };
  if (!current) return { ...base, block: null };

  const bull = side === 'bullish';
  const dir = bull ? 1 : -1;
  const zone = bull ? current.high : current.low;
  const farEdge = bull ? current.low : current.high;
  const stop = farEdge - dir * avgR * cfg.stopBufferFrac;
  const risk = Math.abs(zone - stop);

  const liq = liquidityLevels(candles, cfg);
  const dayHigh = Math.max(...candles.map((k) => k.h));
  const dayLow = Math.min(...candles.map((k) => k.l));
  const opposing = detectOrderBlocks(candles, bull ? 'bearish' : 'bullish', cfg)
    .filter((b) => b.valid)
    .map((b) => (bull ? b.low : b.high));
  // Targets must lie beyond both the zone and the current price.
  const from = bull ? Math.max(zone, last.c) : Math.min(zone, last.c);
  const ahead = [
    ...(bull ? liq.above : liq.below).map((x) => ({ price: x.price, source: x.equal ? 'equal-liquidity' : 'swing-liquidity' })),
    { price: bull ? dayHigh : dayLow, source: bull ? 'day-high' : 'day-low' },
    ...opposing.map((p) => ({ price: p, source: 'opposing-block' })),
  ]
    .filter((x) => dir * (x.price - from) > 0)
    .sort((a, b) => dir * (a.price - b.price));

  const targets = [];
  for (const lvl of ahead) {
    if (targets.length === 2) break;
    if (!targets.some((t) => Math.abs(t.price - lvl.price) < avgR * cfg.equalLevelTolFrac)) targets.push(lvl);
  }
  // Not enough liquidity in range: projections in risk multiples fill the
  // remaining slots, always beyond the last real level.
  for (const m of cfg.projectionMultiples) {
    if (targets.length === 2) break;
    const p = zone + dir * risk * m;
    const floor = targets.at(-1)?.price ?? from;
    if (dir * (p - floor) > 0) targets.push({ price: p, source: 'projection' });
  }
  while (targets.length < 2) {
    const prev = targets.at(-1)?.price ?? from;
    targets.push({ price: prev + dir * risk * 1.5, source: 'projection' });
  }

  // Levels price met on the way (behind the zone): swings it never closed
  // back through, and the day's open.
  const behind = [
    ...(bull ? liq.below : liq.above).map((x) => ({ price: x.price, source: 'swing' })),
    { price: candles[0].o, source: 'day-open' },
  ]
    .filter((x) => dir * (stop - x.price) > 0)
    .sort((a, b) => dir * (b.price - a.price))
    .slice(0, 3);

  const reward = Math.abs(targets[1].price - zone);
  const names = bull ? ['S1', 'R1', 'R2'] : ['R1', 'S1', 'S2'];
  return {
    ...base,
    block: { ...current, low: round2(current.low), high: round2(current.high) },
    levels: {
      Z: round2(zone),
      [names[0]]: round2(stop),
      [names[1]]: { price: round2(targets[0].price), source: targets[0].source },
      [names[2]]: { price: round2(targets[1].price), source: targets[1].source },
      onTheWay: behind.map((x) => ({ ...x, price: round2(x.price) })),
    },
    riskPerShare: round2(risk),
    rr: round2(reward / risk),
    // The same ratio if entered at the current price instead of at Z: shows
    // how much a late entry costs.
    rrFromPrice: dir * (last.c - stop) > 0
      ? round2(Math.max(0, dir * (targets[1].price - last.c)) / Math.abs(last.c - stop))
      : null,
    distanceToZone: round2(last.c - zone),
    vwapAligned: vw == null ? null : bull ? last.c > vw : last.c < vw,
  };
}

// ------------------------------------------------------------- board

/**
 * universe: [{ symbol, sector, prevClose, dailyCloses: number[], candles: Candle[] }]
 * Returns the ranked board, picks with reasons, setups and market breadth.
 */
export function buildBoard(universe, cfg = DEFAULTS) {
  const rows = universe
    .filter((s) => s.candles?.length)
    .map((s) => {
      const last = s.candles.at(-1).c;
      const sc = strengthScore({ prevClose: s.prevClose, last, dailyCloses: s.dailyCloses });
      return {
        symbol: s.symbol,
        sector: s.sector,
        last,
        changePct: round2(sc.change * 100),
        strength: round2(sc.strength),
        side: classify(sc.strength, cfg),
        eventRisk: Math.abs(sc.strength) >= cfg.eventRiskStrength,
        candles: s.candles,
      };
    });

  // Percentile against the whole board (strongest bearish sits near p0).
  const sorted = [...rows].sort((a, b) => a.strength - b.strength);
  for (const r of rows) {
    const below = sorted.filter((x) => x.strength < r.strength).length;
    r.percentile = rows.length > 1 ? round2((below / (rows.length - 1)) * 100) : 100;
  }

  const sides = {};
  for (const side of ['bullish', 'bearish']) {
    const list = rows
      .filter((r) => r.side === side)
      .sort((a, b) => (side === 'bullish' ? b.strength - a.strength : a.strength - b.strength));
    list.forEach((r, i) => {
      r.rank = i + 1;
      r.sideCount = list.length;
    });
    const board = list.slice(0, cfg.boardSize);
    const perSector = {};
    let picked = 0;
    for (const r of board) {
      if (r.eventRisk) r.rule = 'NOT PICKED · event risk';
      else if (picked >= cfg.picksPerSide) r.rule = `NOT PICKED · outside top ${cfg.picksPerSide}`;
      else if ((perSector[r.sector] || 0) >= cfg.sectorCap) r.rule = 'NOT PICKED · sector cap';
      else {
        perSector[r.sector] = (perSector[r.sector] || 0) + 1;
        picked++;
        r.pick = true;
        r.rule = `PICK · ${side.toUpperCase()} #${picked}`;
      }
      r.setup = r.eventRisk ? null : buildSetup(r.candles, side, cfg);
    }
    sides[side] = board;
  }

  const sectorMap = {};
  for (const r of rows) (sectorMap[r.sector] ||= []).push(r.strength);
  const sectors = Object.entries(sectorMap)
    .map(([sector, xs]) => ({ sector, avgStrength: round2(mean(xs)), count: xs.length }))
    .sort((a, b) => b.avgStrength - a.avgStrength);

  const strip = ({ candles, ...r }) => r;
  return {
    breadth: {
      bullish: rows.filter((r) => r.side === 'bullish').length,
      bearish: rows.filter((r) => r.side === 'bearish').length,
      choppy: rows.filter((r) => r.side === 'choppy').length,
      leadingSector: sectors[0]?.sector ?? null,
      laggingSector: sectors.at(-1)?.sector ?? null,
      sectors,
    },
    bullish: sides.bullish.map(strip),
    bearish: sides.bearish.map(strip),
    picks: [...sides.bullish, ...sides.bearish].filter((r) => r.pick).map(strip),
  };
}

// ------------------------------------------------------------- sizing

/** Shares to trade so a stop-out loses at most `riskAmount` (e.g. ₹1,000). */
export function positionSize(riskAmount, riskPerShare, lotSize = 1) {
  if (!(riskPerShare > 0)) return 0;
  const shares = Math.floor(riskAmount / riskPerShare);
  return Math.floor(shares / lotSize) * lotSize;
}
