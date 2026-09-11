// quicklookup.js — runs server-side via GitHub Actions workflow_dispatch (no CORS issue at all,
// since Node has no browser same-origin restrictions). Takes ticker/date/time as CLI args or env
// vars, fetches Yahoo Finance directly, scores the matching bar, writes docs/quicklookup.json.
const fs = require('fs');
const path = require('path');
const https = require('https');
const S = require('./score.js');

const SYM = (process.env.LOOKUP_SYM || process.argv[2] || '').trim().toUpperCase();
const DATE = (process.env.LOOKUP_DATE || process.argv[3] || '').trim();
const TIME = (process.env.LOOKUP_TIME || process.argv[4] || '').trim();

function fetchJSON(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, function (res) {
      let data = '';
      res.on('data', function (d) { data += d; });
      res.on('end', function () { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function chart(sym, range, interval) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval;
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
function ptKey(t) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000)); }
function ptHM(t) { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t * 1000)); }

async function main() {
  const out = { sym: SYM, dateReq: DATE, timeReq: TIME, generatedAt: new Date().toISOString() };
  try {
    if (!SYM) throw new Error('no ticker given');
    const daily = await chart(SYM, '2y', '1d');
    if (!daily || daily.length < 210) throw new Error('not enough daily history for ' + SYM);
    const intraday = await chart(SYM, '60d', '30m');
    if (!intraday || !intraday.length) throw new Error('no intraday data for ' + SYM);
    const weekly = toWeekly(daily);
    const i = daily.length - 1;
    const dctx = S.dailyContext(daily, i);
    const wctx = S.weeklyContext(weekly);

    let bar = null;
    const timeNorm = TIME.length === 4 ? '0' + TIME : TIME;
    if (DATE || TIME) {
      bar = intraday.find(function (b) {
        const dOk = DATE ? ptKey(b.time) === DATE : true;
        const tOk = TIME ? ptHM(b.time) === timeNorm : true;
        return dOk && tOk;
      });
      if (!bar) throw new Error('no bar found for ' + SYM + ' at ' + (DATE || '(any date)') + ' ' + (TIME || '(any time)') + ' PT (60d history limit)');
    } else {
      bar = intraday[intraday.length - 2] || intraday[intraday.length - 1];
    }

    const rng = bar.high - bar.low;
    const trigLoose = rng / dctx.atr;
    const closeLoc = rng > 0 ? (bar.close - bar.low) / rng : 0.5;
    const cut20 = function (key) { return !/(^|[^0-9])20$/.test(key || ''); };
    const nearest = S.nearestLevel(bar.low, dctx, wctx).filter(function (a) { return cut20(a[0]); });
    if (!nearest.length) throw new Error('could not compute MA levels');
    const lvl = nearest[0], second = nearest[1];
    const pierce = (lvl[1] - bar.low) / dctx.atr;
    const cand = {
      trigLoose: trigLoose, pierce: pierce, sbar: 6, d3: dctx.d3, dst: 5,
      rsi2: dctx.rsi2, dv60: dctx.dv60, _dr: 1, _offHi: null, _wLo: closeLoc, _cLoc: closeLoc, slope50: dctx.slope50,
    };
    const res = S.admit(cand);
    Object.assign(out, {
      ok: true, barDate: ptKey(bar.time), barTime: ptHM(bar.time),
      open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      level: lvl[0], levelVal: +lvl[1].toFixed(2), levelDistATR: +lvl[2].toFixed(3),
      ambiguousWith: (second && second[2] <= 0.15) ? { key: second[0], distATR: +second[2].toFixed(3) } : null,
      trigLoose: +trigLoose.toFixed(3), slope50: dctx.slope50,
      pass: res.pass, score: +res.score.toFixed(2), nv4: res.nv4, reasons: res.reasons,
    });
  } catch (e) {
    out.ok = false; out.error = e.message;
  }
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'quicklookup.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
main();
