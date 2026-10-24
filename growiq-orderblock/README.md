# GrowIQ Order Block engine

A self-contained, dependency-free module that turns intraday 5-minute candles into:

- a **strength-ranked board** of bullish and bearish stocks with market breadth and sector flow
- **order blocks**: last opposite candle → close-based break of structure → displacement proof
- **levels per setup**: Z, the stop (S1/R1), liquidity targets (R1/R2 or S1/S2), R:R, VWAP
- **picks**: top 3 per side, sector cap 2, event-risk excluded, with a reason on every row

It is a clean-room rebuild of OrderBlock's publicly described behaviour.
[SPEC.md](SPEC.md) separates what they state publicly from what we inferred,
and lists what is needed before going live.

## Use

```js
import { buildBoard, buildSetup, positionSize } from './src/orderblock.js';

const board = buildBoard([
  { symbol: 'SBIN', sector: 'Banks', prevClose: 818.9,
    dailyCloses: [/* last 51 daily closes */],
    candles: [/* today's finished 5-min candles: { t, o, h, l, c, v } */] },
  // ...every F&O stock
]);

board.breadth;   // { bullish, bearish, choppy, leadingSector, laggingSector, sectors }
board.bullish;   // ranked rows: percentile, rank, rule, pick, eventRisk, setup
board.picks;     // up to 3 per side

positionSize(1000, board.picks[0].setup.riskPerShare, /* lot */ 750);
```

## Run

```bash
npm test                         # node --test, 10 tests
python3 -m http.server 8765      # then open http://127.0.0.1:8765/demo/
```

The demo uses seeded synthetic prices from `src/sample-data.js`, not market data.

## Moving it into the GrowIQ app

Copy `src/orderblock.js` as-is. It runs in Node, in browsers and in serverless functions.
Feed it from your broker API on a 1-minute schedule during 09:15–15:30 IST,
and read SPEC.md §3 (data rights and SEBI) before you sell it.
