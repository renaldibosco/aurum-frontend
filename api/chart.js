// Reno's BOF data proxy: fetches live candles from Yahoo Finance for the iPhone web app.
// Browsers can't call Yahoo directly (CORS), so this tiny function does it.
const ALLOWED = new Set([
  "^NSEI", "^NSEBANK", "^BSESN", "CL=F",
  "GC=F", "BTC-USD", "EURUSD=X", "GBPUSD=X", "JPY=X", "INR=X",
  // BlazeFX
  "AUDUSD=X", "CAD=X", "CHF=X", "NZDUSD=X", "EURJPY=X", "GBPJPY=X", "SI=F", "ETH-USD"
]);
const INTERVALS = new Set(["1m", "5m", "15m", "60m", "1d"]);
const RANGES = new Set(["5d", "1mo", "3mo"]);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const symbol = String(req.query.symbol || "");
  const interval = String(req.query.interval || "5m");
  const range = RANGES.has(String(req.query.range)) ? String(req.query.range) : "5d";
  if (!ALLOWED.has(symbol) || !INTERVALS.has(interval)) {
    res.status(400).json({ error: "Symbol not allowed" });
    return;
  }
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  let lastStatus = 502;
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com${path}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
          "Accept": "application/json"
        }
      });
      lastStatus = r.status;
      if (!r.ok) continue;
      const body = await r.text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");
      res.status(200).send(body);
      return;
    } catch (e) {
      lastStatus = 502;
    }
  }
  res.status(lastStatus).json({ error: "Market data unavailable (" + lastStatus + ")" });
};
