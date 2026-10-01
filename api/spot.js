// BlazeFX real-time spot proxy (Swissquote public quotes) for the iPhone web app.
const ALLOWED = new Set([
  "XAU/USD", "XAG/USD", "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD",
  "USD/CAD", "USD/CHF", "NZD/USD", "EUR/JPY", "GBP/JPY", "USD/INR"
]);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const inst = String(req.query.i || "");
  if (!ALLOWED.has(inst)) { res.status(400).json({ error: "Instrument not allowed" }); return; }
  try {
    const r = await fetch("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/" + inst, {
      headers: { "User-Agent": "Mozilla/5.0 BlazeFX", "Accept": "application/json" }
    });
    if (!r.ok) { res.status(502).json({ error: "Feed error " + r.status }); return; }
    const arr = await r.json();
    const first = arr[0];
    const p = first.spreadProfilePrices[0];
    res.status(200).json({ price: (p.bid + p.ask) / 2, bid: p.bid, ask: p.ask, ts: first.ts });
  } catch (e) {
    res.status(502).json({ error: "Feed unavailable" });
  }
};
