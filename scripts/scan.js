// scan.js — runs headless on a schedule (GitHub Actions cron). Pulls free Yahoo Finance data
// for the universe, finds today's most-recent pullback-ish 30m bar near a key MA for each
// symbol, scores it with score.js, and writes docs/data.json for the static site to read.
//
// NOTE: this is a SIMPLIFIED trigger-bar finder (tight range + near a level + green close +
// prior down-move), not the full multi-thousand-line confirm/pullback logic from bs_dU.js.
// It's meant to surface "worth a manual look" candidates, not to be bit-for-bit identical to
// the backtest engine. The manual "type a bar" tool on the site uses the exact same score.js
// gate, so once you've identified the real trigger bar off a chart, that score IS exact.

const fs = require('fs');
const path = require('path');
const https = require('https');
const S = require('./score.js');

const UNIVERSE = fs.readFileSync(path.join(__dirname, 'universe.txt'), 'utf8')
  .split('\n').map(function (s) { return s.trim(); }).filter(Boolean);

function fetchJSON(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, function (res) {
      let data = '';
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function chart(sym, range, interval) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) +
    '?range=' + range + '&interval=' + interval;
  const j = await fetchJSON(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) return null;
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    out.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  return out;
}

function toWeekly(daily) {
  const byWeek = {};
  daily.forEach(function (b) {
    const d = new Date(b.time * 1000);
    const day = d.getUTCDay();
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!byWeek[key]) byWeek[key] = [];
    byWeek[key].push(b);
  });
  return Object.keys(byWeek).sort().map(function (k) {
    const bars = byWeek[k];
    return {
      time: bars[0].time, open: bars[0].open, high: Math.max.apply(null, bars.map(function (b) { return b.high; })),
      low: Math.min.apply(null, bars.map(function (b) { return b.low; })), close: bars[bars.length - 1].close,
      volume: bars.reduce(function (a, b) { return a + b.volume; }, 0),
    };
  });
}

async function scanOne(sym) {
  try {
    const daily = await chart(sym, '2y', '1d');
    if (!daily || daily.length < 210) return null;
    const intraday = await chart(sym, '5d', '30m');
    if (!intraday || intraday.length < 5) return null;
    const weekly = toWeekly(daily);
    const i = daily.length - 1;
    const dctx = S.dailyContext(daily, i);
    if (!dctx.a50) return null; // regime filter: daily 50>200
    const wctx = S.weeklyContext(weekly);

    // last completed 30m bar (skip the still-forming one if market is open — use second-to-last as "last closed")
    const bars = intraday.slice(-8); // recent bars to scan for a candidate trigger
    // mark which bars are the LAST bar of their (Pacific) trading day -- never buy the close, no fill/follow-through room
    const ptDay = function (t) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(t * 1000)); };
    const isLastOfDay = bars.map(function (b, k) { return k === bars.length - 1 || ptDay(bars[k + 1].time) !== ptDay(b.time); });
    // pay-up slippage: real fills don't happen exactly at the bar low, and higher-priced names need more
    // room to actually get filled -- roughly 4bps of price, e.g. ~$0.10 on a $250 stock.
    const slip = function (price) { return Math.max(0.01, +(price * 0.0004).toFixed(2)); };
    let best = null;
    for (let k = bars.length - 2; k >= 1; k--) { // skip the very last (likely forming) bar
      if (isLastOfDay[k]) continue; // don't buy the last bar of the day
      const b = bars[k];
      const rng = b.high - b.low;
      const trigLoose = rng / dctx.atr;
      if (trigLoose > 0.30) continue; // too loose to ever pass any gate
      const closeLoc = rng > 0 ? (b.close - b.low) / rng : 0.5;
      if (closeLoc < 0.35) continue; // want a green-ish / solid close, not a big red bar
      const nearest = S.nearestLevel(b.low, dctx, wctx);
      if (!nearest.length) continue;
      const lvl = nearest[0];
      if (lvl[2] > 0.6) continue; // not actually near any MA
      const pierce = (lvl[1] - b.low) / dctx.atr; // + = pierced below the level
      const sbar = k; // rough session-bar-index proxy within the recent window
      const cand = {
        trigLoose: trigLoose, pierce: pierce, sbar: sbar, d3: dctx.d3, dst: 10, // dst unknown live -> neutral default
        rsi2: dctx.rsi2, dv60: dctx.dv60, _dr: 2, _offHi: null, _wLo: closeLoc, _cLoc: closeLoc,
      };
      const res = S.admit(cand);
      if (!best || res.score > best.res.score) best = { bar: b, lvl: lvl, res: res, cand: cand };
    }
    if (!best) return null;
    const payUp = slip(best.bar.low);
    return {
      sym: sym, time: best.bar.time, level: best.lvl[0], levelVal: +best.lvl[1].toFixed(2),
      levelDistATR: +best.lvl[2].toFixed(3), entry: +(best.bar.low + payUp).toFixed(2), rawLow: +best.bar.low.toFixed(2), payUp: payUp,
      trigLoose: +best.cand.trigLoose.toFixed(3), score: +best.res.score.toFixed(2), nv4: best.res.nv4,
      pass: best.res.pass, reasons: best.res.reasons,
    };
  } catch (e) {
    return null;
  }
}

async function main() {
  const results = [];
  const CONC = 8;
  let idx = 0;
  async function worker() {
    while (idx < UNIVERSE.length) {
      const sym = UNIVERSE[idx++];
      const r = await scanOne(sym);
      if (r) results.push(r);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  results.sort(function (a, b) { return b.score - a.score; });
  const out = { generatedAt: new Date().toISOString(), universe: UNIVERSE.length, scanned: results.length, results: results };
  const docsDir = path.join(__dirname, '..', 'docs');
  fs.writeFileSync(path.join(docsDir, 'data.json'), JSON.stringify(out, null, 1));

  // --- history: snapshot today's (Pacific calendar day) scan, overwritten on each intraday run ---
  const ptDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const histDir = path.join(docsDir, 'history');
  if (!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, ptDate + '.json'), JSON.stringify(out, null, 1));

  const idxPath = path.join(histDir, 'index.json');
  let dates = [];
  try { dates = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (e) {}
  if (!dates.includes(ptDate)) dates.push(ptDate);
  dates.sort();
  fs.writeFileSync(idxPath, JSON.stringify(dates, null, 1));

  console.log('wrote data.json + history/' + ptDate + '.json:', results.length, 'candidates,', results.filter(function (r) { return r.pass; }).length, 'passing');
}

main();
