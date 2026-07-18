# orderflow-depth

Append-only **L2 order-book depth + tape** dataset for BTC / SOL / ETH,
sampled from Hyperliquid every ~15 s by an hourly GitHub Actions job.
This is the raw material of a *liquidity heatmap*: resting limit-order depth
(with per-level **order counts** — iceberg/wall signal) through time, plus
recent trades, enabling research into walls, pulls, absorption, and
depth-imbalance — at the minutes scale, not HFT microstructure (15 s
snapshots are not MBO/tick data; that honesty matters).

- `data/<COIN>-<YYYY-MM-DD>.jsonl` — today's live file (UTC), one JSON line
  per sample: `{"t":ms,"c":"BTC","b":[[px,sz,n]…],"a":[[px,sz,n]…],"tr":[[time,side,px,sz]…]}`
- `data/*.jsonl.gz` — completed days, gzipped at rollover.

Why Hyperliquid: no geo-block on CI runners (Binance/Bybit block them —
measured), deep real liquidity, and per-level order counts that CEX public
feeds don't expose. Public repo = public market data only.

Purpose: this dataset is the pre-registered reopen condition for two closed
research families in the owner's trading-firm records (order-flow cascade
data for mean-reversion; real footprint data for pattern-sequence work).
Collection first, hypotheses later — the alphabet is only as good as the tape
it's read from.
