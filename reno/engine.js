/* Reno's BOF engine for the web (same logic as the Android app's Engine.kt).
 * Exposes window.Android so the shared screen code works unchanged. */
(function () {
  const SYMBOLS = {
    NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", SENSEX: "^BSESN", CRUDE: "CL=F",
    GOLD: "GC=F", BTC: "BTC-USD", EURUSD: "EURUSD=X", GBPUSD: "GBPUSD=X", USDJPY: "JPY=X", USDINR: "INR=X"
  };
  const TFS = { "1m": ["1m", "5m"], "5m": ["5m", "15m"], "15m": ["15m", "60m"] };
  const TOL = 0.0002;
  const IST = 19800;

  async function fetchSeries(sym, interval) {
    const r = await fetch(`/api/chart?symbol=${encodeURIComponent(sym)}&interval=${interval}`, { cache: "no-store" });
    if (!r.ok) throw new Error("Market data error " + r.status);
    const j = await r.json();
    const res = j.chart.result[0];
    const meta = res.meta;
    const ts = res.timestamp || [];
    const q = res.indicators.quote[0];
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
      candles.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: (q.volume && q.volume[i]) || 0 });
    }
    const now = Date.now() / 1000;
    const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
    return {
      candles,
      gmt: meta.gmtoffset != null ? meta.gmtoffset : IST,
      price: meta.regularMarketPrice != null ? meta.regularMarketPrice : (candles.length ? candles[candles.length - 1].c : 0),
      open: !!reg && now >= reg.start && now <= reg.end,
      hasVolume: candles.length > 0 && candles.filter(c => c.v > 0).length > candles.length / 2
    };
  }

  function rsiArr(cs, p = 14) {
    const r = new Array(cs.length).fill(50);
    let g = 0, l = 0;
    for (let i = 1; i < cs.length; i++) {
      const ch = cs[i].c - cs[i - 1].c, up = Math.max(ch, 0), dn = Math.max(-ch, 0);
      if (i <= p) {
        g += up; l += dn;
        if (i === p) { g /= p; l /= p; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
      } else {
        g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p;
        r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
      }
    }
    return r;
  }

  function atrArr(cs, p = 14) {
    const a = new Array(cs.length).fill(0);
    let cur = 0;
    for (let i = 0; i < cs.length; i++) {
      const tr = i === 0 ? cs[i].h - cs[i].l :
        Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
      cur = i < p ? (cur * i + tr) / (i + 1) : (cur * (p - 1) + tr) / p;
      a[i] = cur;
    }
    return a;
  }

  function detect(cs, i, L, bull, dayFirst) {
    const c = cs[i];
    if (!bull) {
      if (c.h > L * (1 + TOL) && c.c < L && cs[i - 1].c < L) return i;
      if (c.c < L) {
        for (let k = 1; k <= 3; k++) {
          const j = i - k;
          if (j - 1 < dayFirst) break;
          let held = true;
          for (let m = j; m < i; m++) if (cs[m].c <= L) { held = false; break; }
          if (held && cs[j].c > L * (1 + TOL / 2) && cs[j - 1].c <= L) return j;
        }
      }
    } else {
      if (c.l < L * (1 - TOL) && c.c > L && cs[i - 1].c > L) return i;
      if (c.c > L) {
        for (let k = 1; k <= 3; k++) {
          const j = i - k;
          if (j - 1 < dayFirst) break;
          let held = true;
          for (let m = j; m < i; m++) if (cs[m].c >= L) { held = false; break; }
          if (held && cs[j].c < L * (1 - TOL / 2) && cs[j - 1].c >= L) return j;
        }
      }
    }
    return -1;
  }

  function score(cs, i, bo, lv, bull, rsi, atr, vwap, hasVolume, htf, h4, l4) {
    const c = cs[i], L = lv.price;
    let ext = bull ? Infinity : -Infinity, extI = bo;
    for (let k = bo; k <= i; k++) {
      if (!bull && cs[k].h > ext) { ext = cs[k].h; extI = k; }
      if (bull && cs[k].l < ext) { ext = cs[k].l; extI = k; }
    }
    let f1 = false;
    if (htf) {
      let hc = null;
      for (let k = htf.candles.length - 1; k >= 0; k--) if (htf.candles[k].t <= c.t) { hc = htf.candles[k]; break; }
      if (hc) f1 = bull ? (hc.l < L && hc.c > L) : (hc.h > L && hc.c < L);
    }
    let f2;
    if (hasVolume) {
      const from = Math.max(0, bo - 20);
      let s = 0; for (let k = from; k < bo; k++) s += cs[k].v;
      const avg = bo > from ? s / (bo - from) : 0;
      f2 = avg > 0 && cs[bo].v < avg;
    } else {
      f2 = Math.abs(ext - L) < 0.5 * atr[i];
    }
    let f3 = bull ? rsi[extI] <= 30 : rsi[extI] >= 70;
    if (!f3) {
      const a = Math.max(0, extI - 30), b = extI - 3;
      if (b > a) {
        let p = a;
        for (let k = a; k <= b; k++) {
          if (!bull && cs[k].h > cs[p].h) p = k;
          if (bull && cs[k].l < cs[p].l) p = k;
        }
        f3 = bull ? (cs[extI].l <= cs[p].l && rsi[extI] > rsi[p] + 1) : (cs[extI].h >= cs[p].h && rsi[extI] < rsi[p] - 1);
      }
    }
    const body = Math.abs(c.c - c.o), rng = c.h - c.l;
    let f4 = false;
    if (rng > 0) {
      if (bull) { const w = Math.min(c.o, c.c) - c.l; f4 = (w >= 0.5 * rng && w >= 1.5 * body) || (c.c > c.o && body >= 0.6 * rng); }
      else { const w = c.h - Math.max(c.o, c.c); f4 = (w >= 0.5 * rng && w >= 1.5 * body) || (c.c < c.o && body >= 0.6 * rng); }
    }
    const rf = Math.max(0, i - 2);
    let f5;
    if (bull) { let lo = Infinity; for (let k = rf; k <= i; k++) lo = Math.min(lo, cs[k].l); f5 = c.c > vwap[i] && lo <= vwap[i] * 1.0005; }
    else { let hi = -Infinity; for (let k = rf; k <= i; k++) hi = Math.max(hi, cs[k].h); f5 = c.c < vwap[i] && hi >= vwap[i] * 0.9995; }
    const f6 = bull ? (lv.name === "L3" || lv.name === "L4" || (ext < l4 && c.c > l4))
      : (lv.name === "H3" || lv.name === "H4" || (ext > h4 && c.c < h4));
    const factors = [
      { name: "Higher timeframe rejected", ok: f1 },
      { name: hasVolume ? "Weak breakout volume" : "Weak breakout push", ok: f2 },
      { name: "RSI divergence / extreme", ok: f3 },
      { name: "Rejection candle", ok: f4 },
      { name: "VWAP rejection", ok: f5 },
      { name: "Camarilla H4/L4 failure", ok: f6 }
    ];
    const buffer = 0.1 * atr[i];
    const stop = bull ? ext - buffer : ext + buffer;
    const risk = Math.abs(c.c - stop);
    return {
      t: c.t, bull, level: lv, factors, score: factors.filter(f => f.ok).length,
      entry: c.c, stop, target: bull ? c.c + 2 * risk : c.c - 2 * risk
    };
  }

  function analyze(s, htf) {
    const cs = s.candles, n = cs.length;
    const vwap = new Array(n).fill(0);
    if (n < 20) return { vwap, todayStart: 0, levels: [], signals: [], prevClose: n ? cs[0].o : s.price };
    const rsi = rsiArr(cs), atr = atrArr(cs);
    const dayKey = t => Math.floor((t + s.gmt) / 86400);
    const days = [];
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || dayKey(cs[i].t) !== dayKey(cs[start].t)) { days.push([start, i - 1]); start = i; }
    }
    const signals = [];
    let todayLevels = [], prevClose = cs[0].o;
    for (let d = 0; d < days.length; d++) {
      const [f, lst] = days[d];
      let pv = 0, vv = 0;
      for (let i = f; i <= lst; i++) {
        const tp = (cs[i].h + cs[i].l + cs[i].c) / 3, w = s.hasVolume ? Math.max(cs[i].v, 1) : 1;
        pv += tp * w; vv += w; vwap[i] = pv / vv;
      }
      if (d === 0) continue;
      const [pf, pl] = days[d - 1];
      let pH = -Infinity, pL = Infinity;
      for (let i = pf; i <= pl; i++) { pH = Math.max(pH, cs[i].h); pL = Math.min(pL, cs[i].l); }
      const pC = cs[pl].c, rng = pH - pL;
      prevClose = pC;
      const levels = [
        { name: "PDH", price: pH, from: 0 }, { name: "PDL", price: pL, from: 0 },
        { name: "H4", price: pC + rng * 1.1 / 2, from: 0 }, { name: "L4", price: pC - rng * 1.1 / 2, from: 0 },
        { name: "H3", price: pC + rng * 1.1 / 4, from: 0 }, { name: "L3", price: pC - rng * 1.1 / 4, from: 0 }
      ];
      const t0 = cs[f].t;
      const orb = [];
      for (let i = f; i <= lst; i++) if (cs[i].t < t0 + 900) orb.push(i);
      if (orb.length && orb[orb.length - 1] < lst) {
        levels.push({ name: "ORH", price: Math.max(...orb.map(i => cs[i].h)), from: orb[orb.length - 1] + 1 });
        levels.push({ name: "ORL", price: Math.min(...orb.map(i => cs[i].l)), from: orb[orb.length - 1] + 1 });
      }
      if (d === days.length - 1) todayLevels = levels;
      const h4 = levels[2].price, l4 = levels[3].price;
      const lastSig = {};
      for (let i = f; i <= lst; i++) {
        if (i < 5) continue;
        const cands = levels.filter(lv => i >= lv.from).map(lv => [lv, 0]);
        const a = Math.max(0, i - 30), b = i - 3;
        if (b > a) {
          let sh = -Infinity, sl = Infinity;
          for (let k = a; k <= b; k++) { sh = Math.max(sh, cs[k].h); sl = Math.min(sl, cs[k].l); }
          cands.push([{ name: "Swing H", price: sh, from: 0 }, -1]);
          cands.push([{ name: "Swing L", price: sl, from: 0 }, 1]);
        }
        for (const [lv, dir] of cands) {
          for (const bull of [false, true]) {
            if (dir === -1 && bull) continue;
            if (dir === 1 && !bull) continue;
            const bo = detect(cs, i, lv.price, bull, f);
            if (bo < 0) continue;
            const key = lv.name + bull;
            if (lastSig[key] != null && i - lastSig[key] < 6) continue;
            lastSig[key] = i;
            signals.push(score(cs, i, bo, lv, bull, rsi, atr, vwap, s.hasVolume, htf, h4, l4));
          }
        }
      }
    }
    const best = {};
    for (const g of signals) {
      const k = g.t + "-" + g.bull;
      if (!best[k] || g.score > best[k].score) best[k] = g;
    }
    const out = Object.values(best).sort((a, b) => a.t - b.t);
    return { vwap, todayStart: days[days.length - 1][0], levels: todayLevels, signals: out, prevClose };
  }

  function toData(name, tf, s, an) {
    const cs = s.candles;
    const todayT = cs.length ? cs[an.todayStart].t : 0;
    return {
      name, tf, open: s.open, hasVolume: s.hasVolume,
      price: cs.length ? cs[cs.length - 1].c : s.price,
      prevClose: an.prevClose, updated: Date.now(),
      candles: cs.map(c => ({ time: c.t + IST, open: c.o, high: c.h, low: c.l, close: c.c })),
      vwap: cs.slice(an.todayStart).map((c, k) => ({ time: c.t + IST, value: an.vwap[an.todayStart + k] })),
      levels: an.levels.map(l => ({ name: l.name, price: l.price })),
      signals: an.signals.map(g => ({
        time: g.t + IST, bull: g.bull, level: g.level.name, levelPrice: g.level.price, score: g.score,
        factors: g.factors, entry: g.entry, stop: g.stop, target: g.target, today: g.t >= todayT
      }))
    };
  }

  async function build(name, tf) {
    const sym = SYMBOLS[name];
    if (!sym) throw new Error("Unknown symbol");
    const [iv, hv] = TFS[tf] || TFS["5m"];
    const [s, htf] = await Promise.all([fetchSeries(sym, iv), fetchSeries(sym, hv).catch(() => null)]);
    return toData(name, tf, s, analyze(s, htf));
  }

  window.WEB_APP = true;
  window.Android = {
    load(name, tf, cb) {
      build(name, tf)
        .then(d => window.onData(cb, d))
        .catch(e => window.onData(cb, { error: (e && e.message) || "No internet" }));
    },
    alertsOn() { return false; }, setAlerts() {}, threshold() { return 4; }, setThreshold() {},
    forexAlertsOn() { return false; }, setForexAlerts() {}, batterySettings() {}
  };
})();
