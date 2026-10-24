// Deterministic synthetic market for demos and tests. Not real prices.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTORS = {
  Banks: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK'],
  IT: ['INFY', 'TCS', 'WIPRO', 'HCLTECH', 'TECHM', 'LTIM'],
  Auto: ['MARUTI', 'TATAMOTORS', 'M&M', 'BAJAJ-AUTO', 'EICHERMOT', 'HEROMOTOCO'],
  Pharma: ['SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'LUPIN', 'AUROPHARMA'],
  Energy: ['RELIANCE', 'ONGC', 'BPCL', 'IOC', 'NTPC', 'POWERGRID'],
  Metals: ['TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'VEDL', 'SAIL', 'NMDC'],
};

/**
 * @param {number} seed
 * @param {Date} [sessionStart] 09:15 IST of the session (any Date works)
 * @param {number} [bars] number of finished 5-minute candles (max 75)
 */
export function sampleUniverse(seed = 7, sessionStart = new Date('2026-10-23T03:45:00Z'), bars = 40) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  const sectorBias = Object.fromEntries(Object.keys(SECTORS).map((s) => [s, gauss() * 0.6]));
  const out = [];

  for (const [sector, symbols] of Object.entries(SECTORS)) {
    for (const symbol of symbols) {
      const base = 200 + rand() * 2800;
      const dailyVol = 0.01 + rand() * 0.02;
      const dailyCloses = [base];
      for (let d = 0; d < 50; d++) dailyCloses.push(dailyCloses.at(-1) * (1 + gauss() * dailyVol));
      const prevClose = dailyCloses.at(-1);

      // Intraday drift in units of the stock's daily volatility.
      const drift = (sectorBias[sector] + gauss() * 0.8) * dailyVol / bars;
      const barVol = dailyVol / Math.sqrt(75);
      const candles = [];
      let px = prevClose * (1 + gauss() * barVol);
      for (let i = 0; i < bars; i++) {
        const o = px;
        const c = o * (1 + drift + gauss() * barVol);
        const h = Math.max(o, c) * (1 + Math.abs(gauss()) * barVol * 0.5);
        const l = Math.min(o, c) * (1 - Math.abs(gauss()) * barVol * 0.5);
        const v = Math.round(5e4 + rand() * 2e5);
        candles.push({ t: sessionStart.getTime() + i * 300_000, o, h, l, c, v });
        px = c;
      }
      out.push({ symbol, sector, prevClose, dailyCloses, candles });
    }
  }
  return out;
}
