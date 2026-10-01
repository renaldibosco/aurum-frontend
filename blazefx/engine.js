/* BlazeFX engine for the web — same logic as the Android app (Engine.kt + Live.kt).
 * Exposes window.Android so the shared screen code works unchanged. */
(function () {
  const YAHOO = {
    EURUSD: "EURUSD=X", GBPUSD: "GBPUSD=X", USDJPY: "JPY=X", AUDUSD: "AUDUSD=X",
    USDCAD: "CAD=X", USDCHF: "CHF=X", NZDUSD: "NZDUSD=X", EURJPY: "EURJPY=X",
    GBPJPY: "GBPJPY=X", USDINR: "INR=X", XAUUSD: "GC=F", XAGUSD: "SI=F",
    BTCUSD: "BTC-USD", ETHUSD: "ETH-USD"
  };
  const SWISS = {
    XAUUSD: "XAU/USD", XAGUSD: "XAG/USD", EURUSD: "EUR/USD", GBPUSD: "GBP/USD",
    USDJPY: "USD/JPY", AUDUSD: "AUD/USD", USDCAD: "USD/CAD", USDCHF: "USD/CHF",
    NZDUSD: "NZD/USD", EURJPY: "EUR/JPY", GBPJPY: "GBP/JPY", USDINR: "USD/INR"
  };
  const BINANCE = { BTCUSD: "BTCUSDT", ETHUSD: "ETHUSDT" };
  const FUTURES = new Set(["XAUUSD", "XAGUSD"]);
  // tf: [interval, range, htf interval, htf range, seconds]
  const TFS = { "5m": ["5m", "5d", "15m", "5d", 300], "15m": ["15m", "1mo", "60m", "1mo", 900], "1h": ["60m", "1mo", "1d", "3mo", 3600] };
  const TOL = 0.00005, IST = 19800;
  const MAJOR = new Set(["PWH", "PWL", "PDH", "PDL", "ASH", "ASL", "H4", "L4"]);

  function pip(name) {
    if (name.endsWith("JPY")) return 0.01;
    if (name === "XAUUSD") return 0.1;
    if (name === "XAGUSD" || name === "USDINR") return 0.01;
    if (name === "BTCUSD" || name === "ETHUSD") return 1;
    return 0.0001;
  }

  /* ---------- data ---------- */
  async function yahoo(sym, interval, range) {
    const r = await fetch(`/api/chart?symbol=${encodeURIComponent(sym)}&interval=${interval}&range=${range}`, { cache: "no-store" });
    if (!r.ok) throw new Error("Market data error " + r.status);
    const res = (await r.json()).chart.result[0];
    const meta = res.meta, ts = res.timestamp || [], q = res.indicators.quote[0];
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
      candles.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: (q.volume && q.volume[i]) || 0 });
    }
    const now = Date.now() / 1000;
    const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
    const recent = candles.length && now - candles[candles.length - 1].t < 75 * 60;
    return { candles, gmt: meta.gmtoffset || 0, price: meta.regularMarketPrice, open: !!recent || (!!reg && now >= reg.start && now <= reg.end) };
  }

  async function binanceKlines(name, interval) {
    const sym = BINANCE[name]; if (!sym) return null;
    const iv = interval === "60m" ? "1h" : interval;
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=1000`);
      if (!r.ok) return null;
      const arr = await r.json();
      const candles = arr.map(k => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      return candles.length ? { candles, gmt: 0, price: candles[candles.length - 1].c, open: true } : null;
    } catch (e) { return null; }
  }

  const ticks = {}, cache = {}, offsets = {};
  function toSpot(name, s) {
    if (!s || !FUTURES.has(name) || offsets[name] == null) return s;
    const off = offsets[name];
    return { candles: s.candles.map(c => ({ t: c.t, o: c.o + off, h: c.h + off, l: c.l + off, c: c.c + off, v: c.v })), gmt: s.gmt, price: s.price + off, open: s.open };
  }
  async function spot(name) {
    const now = Date.now();
    if (cache[name] && now - cache[name][0] < 1500) return cache[name][1];
    let p = null;
    try {
      if (BINANCE[name]) {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${BINANCE[name]}`);
        if (r.ok) p = +(await r.json()).price;
      } else if (SWISS[name]) {
        const r = await fetch(`/api/spot?i=${encodeURIComponent(SWISS[name])}`, { cache: "no-store" });
        if (r.ok) { const j = await r.json(); if (j.price && now - j.ts < 10 * 60 * 1000) p = j.price; }
      }
    } catch (e) { p = null; }
    if (p == null || !isFinite(p)) return null;
    cache[name] = [now, p];
    const q = ticks[name] || (ticks[name] = []);
    q.push([Math.floor(now / 1000), p]);
    while (q.length > 6000 || (q.length && q[0][0] < now / 1000 - 8 * 3600)) q.shift();
    return p;
  }

  async function patch(name, s, tfSec) {
    const price = await spot(name);
    if (price == null || !s.candles.length) return [s, false];
    let cs = s.candles;
    if (FUTURES.has(name)) {
      const off = price - cs[cs.length - 1].c;
      offsets[name] = off;
      cs = cs.map(c => ({ t: c.t, o: c.o + off, h: c.h + off, l: c.l + off, c: c.c + off, v: c.v }));
    }
    const out = cs.slice();
    const since = out[out.length - 1].t;
    for (const [t, p] of (ticks[name] || [])) {
      if (t < since) continue;
      const start = Math.floor(t / tfSec) * tfSec, last = out[out.length - 1];
      if (start <= last.t) out[out.length - 1] = { t: last.t, o: last.o, h: Math.max(last.h, p), l: Math.min(last.l, p), c: p, v: last.v };
      else out.push({ t: start, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v: 0 });
    }
    return [{ candles: out, gmt: s.gmt, price, open: true }, true];
  }

  /* ---------- engine ---------- */
  const dayKey = (t, g) => Math.floor((t + g) / 86400);
  const weekKey = d => Math.floor((d + 3) / 7);
  const utcHour = t => Math.floor((((t % 86400) + 86400) % 86400) / 3600);
  function session(t) {
    const h = utcHour(t);
    if (h >= 7 && h <= 9) return "London killzone";
    if (h >= 12 && h <= 14) return "New York killzone";
    if (h >= 7 && h <= 15) return "London";
    if (h >= 12 && h <= 20) return "New York";
    if (h <= 8) return "Tokyo";
    return "Sydney";
  }

  function rsiArr(cs, p = 14) {
    const r = new Array(cs.length).fill(50); let g = 0, l = 0;
    for (let i = 1; i < cs.length; i++) {
      const ch = cs[i].c - cs[i - 1].c, up = Math.max(ch, 0), dn = Math.max(-ch, 0);
      if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return r;
  }
  function atrArr(cs, p = 14) {
    const a = new Array(cs.length).fill(0); let cur = 0;
    for (let i = 0; i < cs.length; i++) {
      const tr = i === 0 ? cs[i].h - cs[i].l : Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
      cur = i < p ? (cur * i + tr) / (i + 1) : (cur * (p - 1) + tr) / p; a[i] = cur;
    }
    return a;
  }
  function detect(cs, i, L, bull, dayFirst) {
    const c = cs[i];
    if (!bull) {
      if (c.h > L * (1 + TOL) && c.c < L && cs[i - 1].c < L) return i;
      if (c.c < L) for (let k = 1; k <= 3; k++) {
        const j = i - k; if (j - 1 < dayFirst) break;
        let held = true; for (let m = j; m < i; m++) if (cs[m].c <= L) { held = false; break; }
        if (held && cs[j].c > L * (1 + TOL / 2) && cs[j - 1].c <= L) return j;
      }
    } else {
      if (c.l < L * (1 - TOL) && c.c > L && cs[i - 1].c > L) return i;
      if (c.c > L) for (let k = 1; k <= 3; k++) {
        const j = i - k; if (j - 1 < dayFirst) break;
        let held = true; for (let m = j; m < i; m++) if (cs[m].c >= L) { held = false; break; }
        if (held && cs[j].c < L * (1 - TOL / 2) && cs[j - 1].c >= L) return j;
      }
    }
    return -1;
  }
  function score(cs, i, bo, lv, bull, rsi, atr, htf, h4, l4) {
    const c = cs[i], L = lv.price;
    let ext = bull ? Infinity : -Infinity, extI = bo;
    for (let k = bo; k <= i; k++) {
      if (!bull && cs[k].h > ext) { ext = cs[k].h; extI = k; }
      if (bull && cs[k].l < ext) { ext = cs[k].l; extI = k; }
    }
    let f1 = false;
    if (htf) { let hc = null; for (let k = htf.candles.length - 1; k >= 0; k--) if (htf.candles[k].t <= c.t) { hc = htf.candles[k]; break; }
      if (hc) f1 = bull ? (hc.l < L && hc.c > L) : (hc.h > L && hc.c < L); }
    const f2 = Math.abs(ext - L) < 0.5 * atr[i];
    let f3 = bull ? rsi[extI] <= 30 : rsi[extI] >= 70;
    if (!f3) { const a = Math.max(0, extI - 30), b = extI - 3;
      if (b > a) { let p = a; for (let k = a; k <= b; k++) { if (!bull && cs[k].h > cs[p].h) p = k; if (bull && cs[k].l < cs[p].l) p = k; }
        f3 = bull ? (cs[extI].l <= cs[p].l && rsi[extI] > rsi[p] + 1) : (cs[extI].h >= cs[p].h && rsi[extI] < rsi[p] - 1); } }
    const body = Math.abs(c.c - c.o), rng = c.h - c.l;
    let f4 = false;
    if (rng > 0) {
      if (bull) { const w = Math.min(c.o, c.c) - c.l; f4 = (w >= 0.5 * rng && w >= 1.5 * body) || (c.c > c.o && body >= 0.6 * rng); }
      else { const w = c.h - Math.max(c.o, c.c); f4 = (w >= 0.5 * rng && w >= 1.5 * body) || (c.c < c.o && body >= 0.6 * rng); }
    }
    const sess = session(c.t), f5 = sess.endsWith("killzone");
    const f6 = MAJOR.has(lv.name) || (bull ? (ext < l4 && c.c > l4) : (ext > h4 && c.c < h4));
    const factors = [
      { name: "Higher timeframe rejected", ok: f1 }, { name: "Weak sweep (< 0.5 ATR)", ok: f2 },
      { name: "RSI divergence / extreme", ok: f3 }, { name: "Rejection candle", ok: f4 },
      { name: "Killzone timing", ok: f5 }, { name: "Major level (PW/PD/Asian/H4L4)", ok: f6 }
    ];
    const stop = bull ? ext - 0.1 * atr[i] : ext + 0.1 * atr[i], risk = Math.abs(c.c - stop);
    return { t: c.t, bull, level: lv, factors, score: factors.filter(f => f.ok).length, entry: c.c, stop,
      target: bull ? c.c + 2 * risk : c.c - 2 * risk, session: sess };
  }

  function analyze(s, htf, daily) {
    const cs = s.candles, n = cs.length;
    if (n < 20) return { todayStart: 0, levels: [], signals: [], prevClose: n ? cs[0].o : s.price };
    const rsi = rsiArr(cs), atr = atrArr(cs);
    let days = []; let start = 0;
    for (let i = 1; i <= n; i++) if (i === n || dayKey(cs[i].t, s.gmt) !== dayKey(cs[start].t, s.gmt)) { days.push([start, i - 1]); start = i; }
    const td = days.filter(d => d[1] - d[0] + 1 >= 6); if (td.length) days = td;
    const signals = []; let todayLevels = [], prevClose = cs[0].o;
    for (let d = 1; d < days.length; d++) {
      const [f, lst] = days[d], [pf, pl] = days[d - 1];
      let pH = -Infinity, pL = Infinity;
      for (let i = pf; i <= pl; i++) { pH = Math.max(pH, cs[i].h); pL = Math.min(pL, cs[i].l); }
      const pC = cs[pl].c, rng = pH - pL; prevClose = pC;
      const levels = [
        { name: "PDH", price: pH, from: 0 }, { name: "PDL", price: pL, from: 0 },
        { name: "H4", price: pC + rng * 1.1 / 2, from: 0 }, { name: "L4", price: pC - rng * 1.1 / 2, from: 0 },
        { name: "H3", price: pC + rng * 1.1 / 4, from: 0 }, { name: "L3", price: pC - rng * 1.1 / 4, from: 0 }
      ];
      if (daily && daily.candles.length) {
        const wk = weekKey(dayKey(cs[f].t, s.gmt)); let wH = -Infinity, wL = Infinity;
        for (const dc of daily.candles) if (weekKey(dayKey(dc.t, daily.gmt)) === wk - 1) { wH = Math.max(wH, dc.h); wL = Math.min(wL, dc.l); }
        if (isFinite(wH) && isFinite(wL)) levels.push({ name: "PWH", price: wH, from: 0 }, { name: "PWL", price: wL, from: 0 });
      }
      const asian = []; let firstAfter = -1;
      for (let i = f; i <= lst; i++) { if (utcHour(cs[i].t) < 7) asian.push(i); else if (firstAfter < 0) firstAfter = i; }
      if (asian.length >= 3 && firstAfter >= 0) {
        levels.push({ name: "ASH", price: Math.max(...asian.map(i => cs[i].h)), from: firstAfter });
        levels.push({ name: "ASL", price: Math.min(...asian.map(i => cs[i].l)), from: firstAfter });
      }
      if (d === days.length - 1) todayLevels = levels;
      const h4 = levels[2].price, l4 = levels[3].price, lastSig = {};
      for (let i = f; i <= lst; i++) {
        if (i < 5) continue;
        const cands = levels.filter(lv => i >= lv.from).map(lv => [lv, 0]);
        const a = Math.max(0, i - 30), b = i - 3;
        if (b > a) { let sh = -Infinity, sl = Infinity; for (let k = a; k <= b; k++) { sh = Math.max(sh, cs[k].h); sl = Math.min(sl, cs[k].l); }
          cands.push([{ name: "Swing H", price: sh, from: 0 }, -1], [{ name: "Swing L", price: sl, from: 0 }, 1]); }
        for (const [lv, dir] of cands) for (const bull of [false, true]) {
          if ((dir === -1 && bull) || (dir === 1 && !bull)) continue;
          const bo = detect(cs, i, lv.price, bull, f); if (bo < 0) continue;
          const key = lv.name + bull; if (lastSig[key] != null && i - lastSig[key] < 6) continue;
          lastSig[key] = i; signals.push(score(cs, i, bo, lv, bull, rsi, atr, htf, h4, l4));
        }
      }
    }
    const best = {};
    for (const g of signals) { const k = g.t + "-" + g.bull; if (!best[k] || g.score > best[k].score) best[k] = g; }
    return { todayStart: days[days.length - 1][0], levels: todayLevels, signals: Object.values(best).sort((a, b) => a.t - b.t), prevClose };
  }

  function toData(name, tf, s, an, live) {
    const cs = s.candles, todayT = cs.length ? cs[an.todayStart].t : 0;
    return {
      name, tf, open: s.open, pip: pip(name), live,
      price: cs.length ? cs[cs.length - 1].c : s.price, prevClose: an.prevClose, updated: Date.now(),
      candles: cs.map(c => ({ time: c.t + IST, open: c.o, high: c.h, low: c.l, close: c.c })),
      levels: an.levels.map(l => ({ name: l.name, price: l.price })),
      signals: an.signals.map(g => ({ time: g.t + IST, bull: g.bull, level: g.level.name, levelPrice: g.level.price,
        score: g.score, factors: g.factors, session: g.session, entry: g.entry, stop: g.stop, target: g.target, today: g.t >= todayT }))
    };
  }

  async function build(name, tf) {
    const [iv, rg, hiv, hrg, sec] = TFS[tf] || TFS["5m"];
    const crypto = !!BINANCE[name], y = YAHOO[name];
    const raw = (crypto ? await binanceKlines(name, iv) : null) || await yahoo(y, iv, rg);
    const [s, live] = await patch(name, raw, sec);
    let htf = null;
    try { htf = (crypto ? await binanceKlines(name, hiv) : null) || await yahoo(y, hiv, hrg); } catch (e) {}
    if (htf && hiv !== "1d") htf = (await patch(name, htf, hiv === "60m" ? 3600 : 900))[0];
    else htf = toSpot(name, htf);
    let daily = null;
    try { daily = toSpot(name, (crypto ? await binanceKlines(name, "1d") : null) || await yahoo(y, "1d", "3mo")); } catch (e) {}
    return toData(name, tf, s, analyze(s, htf, daily), live);
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
  };
  window.WEB_APP = true;
  window.Android = {
    load(name, tf, cb) { build(name, tf).then(d => window.onData(cb, d)).catch(e => window.onData(cb, { error: (e && e.message) || "No internet" })); },
    tick(name, cb) { spot(name).then(p => window.onTick(cb, p)).catch(() => window.onTick(cb, null)); },
    threshold() { return +store.get("thr", 4); }, setThreshold(n) { store.set("thr", n); },
    alertsOn() { return false; }, setAlerts() {}, killzoneOnly() { return false; }, setKillzoneOnly() {},
    tvOn() { return false; }, setTvOn() {}, topic() { return ""; }, setTopic() { return false; }, tvList() { return "[]"; },
    copy(t) { try { navigator.clipboard.writeText(t); } catch (e) {} }, batterySettings() {}
  };
})();
