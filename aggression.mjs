/**
 * aggression.mjs — the layer-3 (AGGRESSION) analyzer.
 *
 * Valentini's framework is Direction -> Location -> Aggression. Direction and
 * Location are computable from bars (TradingView / Firm VP). AGGRESSION is not:
 * it needs to know WHO HIT WHOM. This reads the depth+tape archive, which has
 * exactly that (per-trade aggressor side, and resting depth WITH order counts),
 * and computes the aggression metrics as numbers:
 *
 *   - TRUE CVD (cumulative volume delta from real aggressor sides, not the
 *     candle-direction proxy that Firm VP is forced to use)
 *   - tape speed (trades/min, volume/min vs the session baseline)
 *   - large prints (top-percentile sizes)
 *   - depth imbalance at the touch (resting bid vs ask size)
 *   - ABSORPTION candidates: heavy one-sided aggression that produced almost
 *     no price progress — i.e. someone passive ate it
 *
 * SELF-VALIDATION: the side field's meaning ("B" = buyer aggressed?) is an
 * ASSUMPTION, so the tool tests it — per-minute delta should correlate
 * POSITIVELY with per-minute price change. It reports that correlation; a
 * negative number means the mapping is inverted and every metric flips.
 *
 * DISCIPLINE: this is measurement + monitoring infrastructure, NOT hypothesis
 * testing. The archive carries a pre-registered 60-day no-testing gate
 * (DATA_MANIFEST); nothing here proposes a trade rule.
 *
 * Usage: node aggression.mjs [COIN=BTC] [date=latest]
 */
import { readFileSync, readdirSync } from "fs";
import { gunzipSync } from "zlib";
import { join } from "path";

const COIN = (process.argv[2] || "BTC").toUpperCase();
const DIR = "data";
const files = readdirSync(DIR).filter(f => f.startsWith(COIN + "-"));
const arg = process.argv[3];
const pick = arg ? files.filter(f => f.includes(arg)) : files.sort().slice(-1);
if (!pick.length) { console.error(`no data for ${COIN} ${arg || ""}`); process.exit(1); }
const file = pick[pick.length - 1];

const raw = file.endsWith(".gz")
  ? gunzipSync(readFileSync(join(DIR, file))).toString("utf8")
  : readFileSync(join(DIR, file), "utf8");
const snaps = raw.trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// ── flatten tape (dedupe by time+px+sz, since snapshots overlap) ─────────────
const seen = new Set();
const trades = [];
for (const s of snaps) for (const [t, side, px, sz] of s.tr || []) {
  const k = `${t}|${px}|${sz}|${side}`;
  if (seen.has(k)) continue;
  seen.add(k);
  trades.push({ t, side, px, sz });
}
trades.sort((a, b) => a.t - b.t);
if (!trades.length) { console.error("no trades in file"); process.exit(1); }

// ── per-minute buckets ───────────────────────────────────────────────────────
const min = new Map();   // minuteKey -> bucket
for (const x of trades) {
  const m = Math.floor(x.t / 60000);
  let b = min.get(m);
  if (!b) { b = { m, buy: 0, sell: 0, n: 0, first: x.px, last: x.px, hi: x.px, lo: x.px, maxPrint: 0 }; min.set(m, b); }
  if (x.side === "B") b.buy += x.sz; else b.sell += x.sz;
  b.n++; b.last = x.px; b.hi = Math.max(b.hi, x.px); b.lo = Math.min(b.lo, x.px);
  b.maxPrint = Math.max(b.maxPrint, x.sz);
}
const buckets = [...min.values()].sort((a, b) => a.m - b.m);
for (const b of buckets) { b.delta = b.buy - b.sell; b.vol = b.buy + b.sell; b.move = b.last - b.first; }

// ── self-validation: does delta agree with price? ────────────────────────────
const corr = (a, b) => {
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : NaN;
};
const rho = corr(buckets.map(b => b.delta), buckets.map(b => b.move));

// ── depth imbalance at the touch (top 5 levels) ──────────────────────────────
let imbSum = 0, imbN = 0, wallMax = { sz: 0 };
for (const s of snaps) {
  const b5 = (s.b || []).slice(0, 5).reduce((a, l) => a + l[1], 0);
  const a5 = (s.a || []).slice(0, 5).reduce((a, l) => a + l[1], 0);
  if (b5 + a5 > 0) { imbSum += (b5 - a5) / (b5 + a5); imbN++; }
  for (const side of ["b", "a"]) for (const l of (s[side] || [])) if (l[1] > wallMax.sz) wallMax = { sz: l[1], px: l[0], n: l[2], side };
}

// ── stats ────────────────────────────────────────────────────────────────────
const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const sizes = trades.map(t => t.sz);
const bigCut = q(sizes, 0.99);
const big = trades.filter(t => t.sz >= bigCut);
const bigBuy = big.filter(t => t.side === "B").reduce((a, t) => a + t.sz, 0);
const bigSell = big.filter(t => t.side !== "B").reduce((a, t) => a + t.sz, 0);
const totBuy = trades.filter(t => t.side === "B").reduce((a, t) => a + t.sz, 0);
const totSell = trades.reduce((a, t) => a + t.sz, 0) - totBuy;

// absorption: top-quartile volume, bottom-quartile |move|, one-sided delta
const volHi = q(buckets.map(b => b.vol), 0.75);
const moveLo = q(buckets.map(b => Math.abs(b.move)), 0.25);
const absorb = buckets.filter(b => b.vol >= volHi && Math.abs(b.move) <= moveLo && Math.abs(b.delta) > 0.3 * b.vol);

const fmt = n => n.toLocaleString(undefined, { maximumFractionDigits: 3 });
const hhmm = m => new Date(m * 60000).toISOString().slice(11, 16);

console.log(`\n=== AGGRESSION (layer 3) — ${COIN} — ${file} ===`);
console.log(`${trades.length.toLocaleString()} unique prints over ${buckets.length} minutes  (${hhmm(buckets[0].m)}–${hhmm(buckets[buckets.length - 1].m)} UTC)`);
console.log(`\nSIDE-CONVENTION CHECK  corr(per-min delta, per-min price move) = ${rho.toFixed(3)}` +
  `  ->  ${rho > 0.15 ? "PASS: 'B' = buyer aggression, metrics are correctly signed" : rho < -0.15 ? "INVERTED: flip the side mapping!" : "WEAK: ambiguous, treat delta with caution"}`);
console.log(`\nTRUE CVD   buy ${fmt(totBuy)} / sell ${fmt(totSell)}  ->  net ${totBuy - totSell >= 0 ? "+" : ""}${fmt(totBuy - totSell)} ${COIN}` +
  `  (${(100 * totBuy / (totBuy + totSell)).toFixed(1)}% buy-side)`);
console.log(`TAPE SPEED median ${q(buckets.map(b => b.n), 0.5)} prints/min, peak ${Math.max(...buckets.map(b => b.n))}/min` +
  `  |  volume median ${fmt(q(buckets.map(b => b.vol), 0.5))}/min`);
console.log(`LARGE PRINTS  top-1% cut ${fmt(bigCut)} ${COIN}; ${big.length} prints, ${fmt(bigBuy)} buy vs ${fmt(bigSell)} sell` +
  `  (largest single ${fmt(Math.max(...sizes))})`);
console.log(`DEPTH IMBALANCE (top5) mean ${(100 * imbSum / (imbN || 1)).toFixed(1)}% ${imbSum >= 0 ? "bid-heavy" : "ask-heavy"}` +
  `  |  biggest resting wall ${fmt(wallMax.sz)} @ ${wallMax.px} across ${wallMax.n} orders (${wallMax.side === "b" ? "bid" : "ask"})`);

console.log(`\nABSORPTION CANDIDATES: ${absorb.length} minutes with heavy one-sided flow but ~no price progress`);
for (const b of absorb.sort((x, y) => y.vol - x.vol).slice(0, 6)) {
  console.log(`  ${hhmm(b.m)}  vol ${fmt(b.vol)}  delta ${b.delta >= 0 ? "+" : ""}${fmt(b.delta)}` +
    `  move ${b.move >= 0 ? "+" : ""}${b.move.toFixed(1)}  -> ${b.delta > 0 ? "buyers absorbed by passive sellers" : "sellers absorbed by passive buyers"}`);
}
console.log(`\n(measurement only — the archive's 60-day no-testing gate governs any hypothesis work)`);
