/**
 * orderflow-depth collector (2026-07-18) — the liquidity-heatmap dataset.
 *
 * Samples Hyperliquid L2 order-book depth (top 20 levels/side, each level
 * {px, sz, n} where n = resting order COUNT — iceberg/wall signal) plus the
 * recent-trades tape for BTC, SOL, ETH every SAMPLE_SEC seconds, for
 * RUN_MINUTES per invocation (designed for an hourly GitHub Actions job:
 * ~53 min of sampling, then commit).
 *
 * Why Hyperliquid: decentralized, no geo-block on CI runners (Binance 451s,
 * Bybit 403s — measured); deep real liquidity; includes per-level order count
 * which CEX L2 feeds don't give. Honest resolution note: 15s snapshots are
 * NOT MBO/tick data — they support wall/absorption/imbalance research at the
 * minutes scale our systems trade, not HFT microstructure.
 *
 * Output: data/<COIN>-<YYYY-MM-DD>.jsonl (UTC), one line per sample:
 *   {"t":ms,"c":"BTC","b":[[px,sz,n]..],"a":[[px,sz,n]..],"tr":[[time,side,px,sz]..]}
 * "tr" holds trades from the recentTrades window NEW since the prior sample
 * (deduped by hash within the run). At each run start, any PREVIOUS day's
 * .jsonl files are gzipped (rollover) and the plain files removed.
 *
 * This dataset is the pre-registered reopen condition for two closed firm
 * research families (mean-reversion via order-flow cascade data; sequence
 * words via real footprint data — see trading-firm VERDICTS_INDEX).
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { gzipSync } from "zlib";
import { join } from "path";

const COINS = ["BTC", "SOL", "ETH"];
const SAMPLE_SEC = parseInt(process.env.SAMPLE_SEC || "15");
const RUN_MINUTES = parseFloat(process.env.RUN_MINUTES || "53");
const DATA = "data";
if (!existsSync(DATA)) mkdirSync(DATA);

const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const log = m => console.log(`[${new Date().toISOString()}] ${m}`);

async function info(body) {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// rollover: gzip completed (non-today) day files
const today = dayOf(Date.now());
for (const f of readdirSync(DATA).filter(f => f.endsWith(".jsonl"))) {
  const day = f.slice(-16, -6);
  if (day < today) {
    const p = join(DATA, f);
    writeFileSync(p + ".gz", gzipSync(readFileSync(p)));
    unlinkSync(p);
    log(`rolled over ${f} -> ${f}.gz`);
  }
}

const seenTrades = new Set();          // per-run tape dedupe (hash)
let samples = 0, errors = 0;
const endAt = Date.now() + RUN_MINUTES * 60 * 1000;
log(`sampling ${COINS.join("/")} every ${SAMPLE_SEC}s for ${RUN_MINUTES} min`);

while (Date.now() < endAt) {
  const t0 = Date.now();
  for (const c of COINS) {
    try {
      const [book, trades] = await Promise.all([
        info({ type: "l2Book", coin: c }),
        info({ type: "recentTrades", coin: c }),
      ]);
      const compact = side => (side || []).map(l => [+l.px, +l.sz, l.n]);
      const tr = (Array.isArray(trades) ? trades : [])
        .filter(x => x.hash && !seenTrades.has(x.hash))
        .map(x => { seenTrades.add(x.hash); return [x.time, x.side, +x.px, +x.sz]; });
      const line = JSON.stringify({ t: book.time || t0, c, b: compact(book.levels?.[0]), a: compact(book.levels?.[1]), tr });
      appendFileSync(join(DATA, `${c}-${dayOf(t0)}.jsonl`), line + "\n");
      samples++;
    } catch (e) { errors++; if (errors <= 5) log(`${c}: ${e.message}`); }
  }
  if (seenTrades.size > 50000) seenTrades.clear();     // bound memory; cross-clear dupes are rare and harmless
  const wait = SAMPLE_SEC * 1000 - (Date.now() - t0);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}
log(`done: ${samples} snapshots, ${errors} errors`);
if (samples === 0) { log("zero samples collected - failing the run"); process.exit(1); }
