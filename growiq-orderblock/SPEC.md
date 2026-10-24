# Order Block feature: reverse-engineering notes

**Target:** OrderBlock (https://order-block.com, "a product of Options Oracle"): a live
order-block and liquidity screener for Indian F&O stocks, ₹7,999/year (shown as ₹22/day).

**Method:** The site was not reachable directly from the build environment. These notes
come from its public pages, read on 24 Oct 2026: the home page, the blog posts
*What is an order block?* and *How to read an Order Block popup in 10 seconds*, and
search snippets of *Order Block For Indian Traders*. No logged-in terminal, API
traffic, JavaScript bundle or data feed was inspected. Everything about their
internals is therefore either **stated** in public material or **inferred** by us.
The code in `src/` is our own clean-room implementation of the stated behaviour.

## 1. What the product does (stated)

| Area | Public description |
| --- | --- |
| Universe | Every Indian F&O stock (200+), scanned every minute, 09:15–15:30 IST. Last session's board on holidays. |
| Timeframe | Finished 5-minute candles only. A block and its levels change at most every 5 min. Levels are re-checked against live price every minute. |
| Strength | Today's move compared with the stock's own last 50 sessions ("a 2% move means different things in different counters"). |
| Side | Bullish / Bearish / Choppy. Choppy stocks "score zero". The FAQ says the liquidity score also uses OI and momentum. |
| Board | The 20 strongest per side, ranked. Each row shows rank `p99.8 · #1/130` (percentile of the whole board · rank within the side). |
| Picks | Top 3 per side, at most 2 from one sector, no event-risk stocks. Each row explains itself: `PICK · BULLISH #1`, `NOT PICKED · sector cap`, `NOT PICKED · outside top 3`. |
| Event risk | An "unusually large" move is marked amber and gets no levels. |
| Order block | The last opposite-colour candle before a forceful move that **closes** beyond an earlier swing high/low **or the first-15-minute range**. A wick does not count. |
| Displacement proof | The move away must leave a fair value gap, or close beyond the block by at least one average candle. |
| Invalidation | The block is dead if any 5-min candle has closed through it since. |
| Levels (bullish) | **Z** = zone level. **S1** = just beyond the far edge (where the setup is wrong). **R1, R2** = liquidity ahead: unvisited swing highs, the day high or an opposing block. Bearish is the mirror: Z, R1 stop, S1/S2 targets. |
| R:R | (Z → second level) ÷ (Z → stop), e.g. `1 : 2.7`. They suggest a floor of 1 : 1.5. |
| Chart extras | VWAP (dashed). Earlier setups stay drawn without labels. Amber dotted S2–S4 "levels met on the way": unclosed swings, the day open, open gaps. |
| Market picture | Bullish/bearish counts, leading/lagging sector, a scatter of every stock's move. |
| Extras | Trading journal, learning videos, community, light/dark themes, works in a phone browser. |

## 2. Our implementation choices (inferred)

These are our own decisions where the public material gives no detail. Each one is a
setting in `DEFAULTS`.

- **Strength** = today's % change ÷ standard deviation of the last 50 daily returns.
  OrderBlock might use ATR or a percentile instead.
- **Side threshold** = |strength| ≥ 0.5. **Event risk** = |strength| ≥ 5.
- **Swing points** = 2-bar fractals. A swing only counts once its right-hand bars have closed.
- **The block's leg**: we take the lowest low between the broken reference and the break,
  then the last red candle at or before it.
- **Z** = the block's near edge (the high of a bullish block). **S1** = far edge − 0.1 × average range.
- **Targets**: unclosed swing highs and lows (equal highs and lows are grouped and flagged),
  the day high or low, and the edges of opposing valid blocks. When fewer than two exist,
  we add risk-multiple projections (1.5R, 3R) and label them `projection`.
- **Added beyond the original**: `rrFromPrice` (R:R if you enter at the current price),
  `vwapAligned`, and a `positionSize()` helper.
- **Not built yet**: OI and volume-profile inputs, open-gap levels, the journal,
  the 1-minute refresh scheduler and the live data feed.

## 3. What GrowIQ needs to go live

1. **Data feed.** 5-minute OHLCV for the F&O list plus 50 days of daily closes,
   from a broker API you have rights to (Zerodha Kite Connect, Upstox, Dhan or Angel
   SmartAPI). Keep NSE's redistribution terms in mind if you show data to subscribers.
2. **Scheduler.** Each minute during market hours: append finished candles, call
   `buildBoard()`, then cache and push the result (WebSocket/SSE) to clients.
3. **Compliance.** Ranked "picks" with entry, stop and target levels sold to the public
   can count as research or recommendations under SEBI (Research Analysts)
   Regulations, 2014. GrowIQ currently works through distributor partners
   (Wealthy, Zfunds). Confirm registration and disclosure needs with a SEBI
   compliance advisor before you charge for this. Show an "education only, not
   advice" disclaimer, as the demo does.
4. **Back-test** the defaults on real past sessions before showing R:R numbers to clients.

## 4. Not to copy

Do not copy OrderBlock's name, logo, screenshots, blog images, testimonials or wording.
Order blocks, liquidity, FVG and VWAP are public trading concepts. Their branding and
content are not.
