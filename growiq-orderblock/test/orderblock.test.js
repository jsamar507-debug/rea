import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  buildBoard,
  buildSetup,
  detectOrderBlocks,
  positionSize,
  strengthScore,
  vwap,
} from '../src/orderblock.js';
import { sampleUniverse } from '../src/sample-data.js';

const k = (o, h, l, c, v = 1000) => ({ t: 0, o, h, l, c, v });

// Opening range high 101.5; last red candle (#4) before a rally that closes
// above it with a fair value gap; then a pullback that holds the block.
const bullDay = [
  k(100, 101, 99.5, 100.5),
  k(100.5, 101.2, 100, 101),
  k(101, 101.5, 100.6, 100.8),
  k(100.8, 101, 100, 100.2),
  k(100.2, 100.4, 99.6, 99.8),
  k(99.8, 101, 99.7, 100.9),
  k(100.9, 102.5, 100.8, 102.3),
  k(102.3, 103, 102, 102.8),
  k(102.8, 102.9, 101.5, 101.7),
  k(101.7, 102, 101, 101.6),
];
const flip = (cs) => cs.map((x) => ({ ...x, o: 200 - x.o, h: 200 - x.l, l: 200 - x.h, c: 200 - x.c }));

test('bullish block is the last red candle before a close-based break', () => {
  const [b] = detectOrderBlocks(bullDay, 'bullish');
  assert.equal(b.blockIndex, 4);
  assert.equal(b.breakIndex, 6);
  assert.equal(b.brokeKind, 'opening-range');
  assert.equal(b.proof, 'fvg');
  assert.deepEqual([b.low, b.high], [99.6, 100.4]);
  assert.equal(b.valid, true);
});

test('a wick through the level is not a break of structure', () => {
  const wickOnly = bullDay.slice(0, 6).concat(k(100.9, 102.5, 100.8, 101.4));
  assert.equal(detectOrderBlocks(wickOnly, 'bullish').length, 0);
});

test('a later close below the block invalidates it', () => {
  const failed = bullDay.concat(k(101.6, 101.6, 99, 99.2));
  const [b] = detectOrderBlocks(failed, 'bullish');
  assert.equal(b.valid, false);
  assert.equal(b.invalidatedAt, bullDay.length);
  assert.equal(buildSetup(failed, 'bullish').block, null);
});

test('bullish setup levels: Z at the near edge, S1 beyond the far edge, R1 at liquidity', () => {
  const s = buildSetup(bullDay, 'bullish');
  assert.equal(s.levels.Z, 100.4);
  assert.ok(s.levels.S1 < 99.6);
  assert.equal(s.levels.R1.price, 103);
  assert.ok(s.levels.R2.price > s.levels.R1.price);
  assert.ok(s.rr > 0);
  assert.equal(s.riskPerShare, Math.round((100.4 - s.levels.S1) * 100) / 100);
});

test('bearish detection mirrors bullish exactly', () => {
  const bull = buildSetup(bullDay, 'bullish');
  const bear = buildSetup(flip(bullDay), 'bearish');
  assert.equal(bear.block.blockIndex, bull.block.blockIndex);
  assert.equal(bear.levels.Z, Math.round((200 - bull.levels.Z) * 100) / 100);
  assert.ok(bear.levels.R1 > bear.levels.Z);
  assert.ok(bear.levels.S1.price < bear.levels.Z);
  assert.equal(bear.rr, bull.rr);
});

test('strength normalises the move by the stock\'s own daily volatility', () => {
  const quiet = [100, 100.5, 100, 100.5, 100, 100.5];
  const wild = [100, 105, 100, 105, 100, 105];
  const a = strengthScore({ prevClose: 100, last: 102, dailyCloses: quiet });
  const b = strengthScore({ prevClose: 100, last: 102, dailyCloses: wild });
  assert.ok(a.strength > b.strength * 5);
});

test('vwap weights typical price by volume', () => {
  assert.equal(vwap([k(10, 12, 8, 10, 1), k(20, 23, 17, 20, 3)]), 17.5);
});

test('board ranks sides, enforces sector cap and pick count', () => {
  const board = buildBoard(sampleUniverse(7));
  const { breadth } = board;
  assert.equal(breadth.bullish + breadth.bearish + breadth.choppy, 36);
  for (const side of ['bullish', 'bearish']) {
    const picks = board[side].filter((r) => r.pick);
    assert.ok(picks.length <= DEFAULTS.picksPerSide);
    const bySector = {};
    for (const p of picks) bySector[p.sector] = (bySector[p.sector] || 0) + 1;
    assert.ok(Object.values(bySector).every((n) => n <= DEFAULTS.sectorCap));
    board[side].forEach((r, i) => assert.equal(r.rank, i + 1));
    for (const r of board[side]) assert.ok(r.rule);
  }
});

test('event-risk stocks get no levels and are never picked', () => {
  const uni = sampleUniverse(3);
  uni[0].candles.at(-1).c = uni[0].prevClose * 1.3;
  const row = buildBoard(uni).bullish.find((r) => r.symbol === uni[0].symbol);
  assert.equal(row.eventRisk, true);
  assert.equal(row.setup, null);
  assert.equal(row.rule, 'NOT PICKED · event risk');
});

test('position size rounds down to whole lots', () => {
  assert.equal(positionSize(1000, 0.8), 1250);
  assert.equal(positionSize(1000, 0.8, 500), 1000);
  assert.equal(positionSize(1000, 0), 0);
});
