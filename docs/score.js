// score.js — portable (Node + browser) port of the "nV4-only CHAMPION" pullback-to-EMA
// long system from ll_backtest/bs_dU.js. Faithfully reproduces the locked nV4 scorer and
// the optimizer champion's admit() gate. Runs on a single "candidate" object you build
// from real OHLCV data — see buildCandidate() below for the required fields.
//
// This is NOT the full backtest engine (that has ~5k lines of multi-bar pullback/confirm
// detection). This module trusts the CALLER to have already identified a plausible trigger
// bar (tight pullback bar sitting near an MA level) and just grades/gates it. The auto-scan
// script (scan.js) does a best-effort simplified trigger-detection pass; the manual "type a
// bar" tool on the site lets you supply the trigger bar directly so the score is exact.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScoreLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ---- nV4 (locked, tent-shaped monotone scorer) — identical formula to bs_dU.js ----
  function nV4(c) {
    let s = 0;
    const tl = c.trigLoose;
    s += tl <= 0.10 ? 2 : tl <= 0.15 ? 1 : tl <= 0.20 ? 0 : tl <= 0.25 ? -1 : -2;
    s += c.pierce < -0.10 ? 1 : c.pierce <= 0.15 ? 0 : -1;
    s += c.sbar <= 3 ? -1 : c.sbar <= 6 ? 0 : c.sbar <= 13 ? 1 : 0;
    s += c.d3 < -3 ? 0 : c.d3 < -1 ? 2 : c.d3 < 0 ? 1 : c.d3 <= 1.5 ? 0 : -1;
    s += c.dst <= 3 ? -1 : c.dst < 8 ? 0 : c.dst <= 25 ? 2 : c.dst <= 45 ? 1 : 0;
    s += c.rsi2 > 85 ? -1 : c.rsi2 > 60 ? 0 : c.rsi2 > 40 ? 1 : c.rsi2 >= 15 ? 2 : c.rsi2 >= 5 ? 1 : 0;
    s += c.dv60 < 500e6 ? 1 : c.dv60 < 2e9 ? 0 : -1;
    s += c._dr === 0 ? -1 : c._dr === 1 ? 0 : c._dr <= 3 ? 1 : 0;
    s += (c._offHi != null && c._offHi >= 0.25 && c._offHi < 0.7) ? 1 : 0;
    return Math.max(-5, Math.min(10, s));
  }

  // ---- 10-signal weighted vector used by the champion gate (identical to _opt.js output) ----
  function sigs(c) {
    const tl = c.trigLoose;
    return [
      tl <= 0.10 ? 2 : tl <= 0.15 ? 1 : tl <= 0.20 ? 0 : tl <= 0.25 ? -1 : -2,
      c.pierce < -0.10 ? 1 : c.pierce <= 0.15 ? 0 : -1,
      c.sbar <= 3 ? -1 : c.sbar <= 6 ? 0 : c.sbar <= 13 ? 1 : 0,
      c.d3 < -3 ? 0 : c.d3 < -1 ? 2 : c.d3 < 0 ? 1 : c.d3 <= 1.5 ? 0 : -1,
      c.dst <= 3 ? -1 : c.dst < 8 ? 0 : c.dst <= 25 ? 2 : c.dst <= 45 ? 1 : 0,
      c.rsi2 > 85 ? -1 : c.rsi2 > 60 ? 0 : c.rsi2 > 40 ? 1 : c.rsi2 >= 15 ? 2 : c.rsi2 >= 5 ? 1 : 0,
      c.dv60 < 500e6 ? 1 : c.dv60 < 2e9 ? 0 : -1,
      c._dr === 0 ? -1 : c._dr === 1 ? 0 : c._dr <= 3 ? 1 : 0,
      (c._offHi != null && c._offHi >= 0.25 && c._offHi < 0.7) ? 1 : 0,
      (c._wLo != null && c._wLo >= 0.5 && c._cLoc >= 0.5) ? 1 : 0,
    ];
  }
  // champion weights (order matches sigs()): tight,pierce,tod,d3,dst,rsi2,$vol,dr,offHi,shakeout
  const W = [1.5, 0.5, 1.75, 0.5, 1.75, 0.5, 0.25, 0.75, 1.75, 0.25];
  const GATE = { A: 1, B: 6, Ta: 0.15, Tb: 0.20, Bs: 10, Bcap: 0.18, Cw: 0.5, Cs: 4, Ccap: 0.25 };

  function champScore(c) {
    return sigs(c).reduce((a, s, j) => a + s * W[j], 0);
  }

  // returns {pass, score, nv4, reasons:[why-pass-or-fail per path]}
  function admit(c) {
    const sc = champScore(c);
    const tl = c.trigLoose;
    const pathA = tl <= GATE.Ta && sc >= GATE.A;
    const pathAloose = tl > GATE.Ta && tl <= GATE.Tb && sc >= GATE.B;
    const pathB = sc >= GATE.Bs && tl <= GATE.Bcap;
    const pathC = (c._wLo != null && c._wLo >= GATE.Cw && c._cLoc >= 0.5 && sc >= GATE.Cs && tl <= GATE.Ccap);
    const pass = pathA || pathAloose || pathB || pathC;
    const reasons = [];
    reasons.push('champion weighted score = ' + sc.toFixed(2) + ' (raw signal sum, not nV4)');
    reasons.push('nV4 (0-9 grading scale) = ' + nV4(c));
    reasons.push('trigLoose (bar range / daily ATR) = ' + tl.toFixed(3));
    if (pathA) reasons.push('PASS via base path: trig<=' + GATE.Ta + ' & score>=' + GATE.A);
    else if (tl <= GATE.Ta) reasons.push('base path failed: trig ok (<=' + GATE.Ta + ') but score ' + sc.toFixed(2) + ' < ' + GATE.A);
    if (pathAloose) reasons.push('PASS via loose-trig path: ' + GATE.Ta + '<trig<=' + GATE.Tb + ' & score>=' + GATE.B);
    else if (tl > GATE.Ta && tl <= GATE.Tb) reasons.push('loose-trig path failed: score ' + sc.toFixed(2) + ' < ' + GATE.B);
    if (pathB) reasons.push('PASS via Path B: score>=' + GATE.Bs + ' & trig<=' + GATE.Bcap);
    else if (tl <= GATE.Bcap) reasons.push('Path B failed: score ' + sc.toFixed(2) + ' < ' + GATE.Bs);
    if (pathC) reasons.push('PASS via Path C (shakeout): wick>=' + GATE.Cw + ', closeLoc>=0.5, score>=' + GATE.Cs + ', trig<=' + GATE.Ccap);
    if (!pass) reasons.push('NO PATH QUALIFIES — rejected');
    if (tl > GATE.Tb && tl > GATE.Bcap && tl > GATE.Ccap) reasons.push('trigger bar too loose for ANY path (trig=' + tl.toFixed(3) + ')');
    return { pass, score: sc, nv4: nV4(c), reasons };
  }

  // ---- helpers to build a candidate from raw price series ----
  function EMA(vals, n) {
    const k = 2 / (n + 1);
    let e = vals[0];
    const out = [e];
    for (let i = 1; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
    return out;
  }
  function SMA(vals, n, i) {
    if (i < n - 1) return null;
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += vals[j];
    return s / n;
  }
  function RSI(closes, i, p) {
    let g = 0, l = 0;
    for (let j = i - p + 1; j <= i; j++) { const ch = closes[j] - closes[j - 1]; if (ch > 0) g += ch; else l -= ch; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  function ATR14(daily, i) {
    let atr = 0;
    for (let j = i - 13; j <= i; j++) atr += Math.max(daily[j].high - daily[j].low, Math.abs(daily[j].high - daily[j - 1].close), Math.abs(daily[j].low - daily[j - 1].close));
    return atr / 14;
  }

  const LVLS_DAILY = { e8: 8, e20: 20, e50: 50, e100: 100, e150: 150, e200: 200 };
  const LVLS_DAILY_S = { s8: 8, s20: 20, s50: 50, s100: 100, s150: 150, s200: 200 };
  const LVLS_WEEK = { we8: 8, we10: 10, we20: 20, we21: 21, we30: 30, we40: 40, we50: 50, we100: 100, we150: 150, we200: 200 };
  const LVLS_WEEK_S = { ws8: 8, ws10: 10, ws20: 20, ws40: 40, ws50: 50, ws100: 100, ws150: 150, ws200: 200 };

  // daily: array of {time,open,high,low,close,volume} ascending; weekly: same, ascending
  // returns { levels: {key: value}, atr, rsi2, d3, dv60, a50 }
  function dailyContext(daily, i) {
    const c = daily.map(function (b) { return b.close; });
    const atr = ATR14(daily, i);
    let dvs = 0, m = 0;
    for (let j = Math.max(0, i - 59); j <= i; j++) { dvs += (daily[j].volume || 0) * daily[j].close; m++; }
    const levels = {};
    Object.keys(LVLS_DAILY).forEach(function (k) { const vals = EMA(c.slice(0, i + 1), LVLS_DAILY[k]); levels[k] = vals[vals.length - 1]; });
    Object.keys(LVLS_DAILY_S).forEach(function (k) { levels[k] = SMA(c, LVLS_DAILY_S[k], i); });
    const e50v = EMA(c.slice(0, i + 1), 50); const e200v = EMA(c.slice(0, i + 1), 200);
    return {
      levels: levels, atr: atr, rsi2: RSI(c, i, 2), d3: (c[i] - c[i - 3]) / atr,
      dv60: m ? dvs / m : 0, a50: e50v[e50v.length - 1] > e200v[e200v.length - 1],
    };
  }
  function weeklyContext(weekly) {
    const c = weekly.map(function (b) { return b.close; });
    const i = c.length - 1;
    const levels = {};
    Object.keys(LVLS_WEEK).forEach(function (k) { const vals = EMA(c, LVLS_WEEK[k]); levels[k] = vals[vals.length - 1]; });
    Object.keys(LVLS_WEEK_S).forEach(function (k) { levels[k] = SMA(c, LVLS_WEEK_S[k], i); });
    return levels;
  }

  // find nearest level (daily+weekly combined) to a price, and the runner-up (for ambiguity flag)
  function nearestLevel(price, dctx, wctx) {
    const all = [];
    Object.keys(dctx.levels).forEach(function (k) { if (dctx.levels[k] != null) all.push([k, dctx.levels[k]]); });
    Object.keys(wctx).forEach(function (k) { if (wctx[k] != null) all.push([k, wctx[k]]); });
    all.forEach(function (a) { a[2] = Math.abs(price - a[1]) / dctx.atr; });
    all.sort(function (a, b) { return a[2] - b[2]; });
    return all; // sorted array of [key, value, distATR]
  }

  return { nV4: nV4, sigs: sigs, W: W, GATE: GATE, champScore: champScore, admit: admit,
    EMA: EMA, SMA: SMA, RSI: RSI, ATR14: ATR14, dailyContext: dailyContext, weeklyContext: weeklyContext,
    nearestLevel: nearestLevel, LVLS_DAILY: LVLS_DAILY, LVLS_DAILY_S: LVLS_DAILY_S, LVLS_WEEK: LVLS_WEEK, LVLS_WEEK_S: LVLS_WEEK_S };
});
