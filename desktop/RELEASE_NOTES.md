## New in 1.18.0

- **Alerts**: an expiry date, active hours (e.g. 09:00–17:00 Mon–Fri), zone alerts on rectangles (price enters or leaves), an **alert log** of everything that fired and why, and dedicated **Discord** and **Slack** channels on the alert server (each alert can pick its channels).
- **Strategy Tester**: Long / short breakdown, profit by weekday and by day, **Monte Carlo** (1,000 resampled histories: range of returns and drawdowns), and **slippage**.

To update the alert server too, restart `node server.js` (or the Windows app) after updating.

## In 1.17.0

- **Up to 16 charts** (4×2, 3×3, 4×3 and 4×4 grids) and **layout files**: export the current layout with its drawings and scripts, import it anywhere.
- **Drawings**: show a drawing only on some timeframes (Visibility); weak or strong magnet; hold Shift for horizontal, vertical or 45° lines; Fibonacci level sets (classic, extensions, OTE) and your own levels.
- **Watchlist**: All / Gainers / Losers tabs, 24h volume column, sort by any column.
- Press **?** for all keyboard shortcuts.

## In 1.16.0

- **Order flow**: Volume Delta and Cumulative Volume Delta (real taker volume on Binance, estimated elsewhere), and a **Volume Profile** of the visible range with point of control and value area.
- **Smart-money indicators**: Fair Value Gaps, Order Blocks, Liquidity Levels (buy/sell-side, equal highs/lows, swept levels) and Market Structure (BOS / CHoCH).
- **Fair value gap and Order block drawing tools** (Forecasting menu → Smart money): click a candle and the zone runs until it is filled or broken.

## In 1.15.0

- **Paper trading**: practise with a virtual $100,000 account (Trade button). Market, limit and stop orders with take profit and stop loss; up to 5 accounts; commission and leverage settings.
- Positions, orders, stops and targets are **lines on the chart**: drag them to move, right-click to cancel or close. Right-click the chart at a price to place a limit or stop order there.
- **Trade journal**: notes on each fill, journal entries, and stats (win rate, profit factor, best and worst trade).
- **Trade during Bar Replay** on a practice account, filled candle by candle, with a results card when the replay ends.

## In 1.14.0

- **Measure**: Shift + click on the chart (or the ruler in the toolbar) for a quick price/%/time measurement.
- **Alerts**: drag a price alert's line to move it; right-click an alert (on the chart or in the list) to edit or remove it.
- **Opacity** for every indicator color (0–100%), in the indicator's Style tab.
- Chart settings (background, colors) are also in the chart's right-click menu.

## In 1.13.0

- **45 more indicators (68 in all)**: Hull, DEMA, TEMA, VWMA, ALMA, KAMA, McGinley and other moving averages, Pivot Points (Traditional/Fibonacci/Woodie/Camarilla), Zig Zag, Williams Alligator and Fractals, MA Cross, Chandelier Exit, Envelopes, Awesome/Accelerator Oscillators, Aroon, Ultimate Oscillator, TRIX, KST, Fisher Transform, PPO, Connors RSI, Coppock, Vortex, TSI, Chaikin Money Flow and Oscillator, Accumulation/Distribution, Force Index, Ease of Movement, Choppiness, Historical Volatility, Bollinger %B and BandWidth, Mass Index and more.

## In 1.12.0

- **Condition alerts**: price or any indicator line crossing, crossing up/down, greater or less than a value or another line (RSI crossing 30, EMA 20 crossing EMA 50, price above SMA 200…). The bell on every indicator's legend opens them.
- **Alerts on drawn lines**: trend lines, rays, extended lines and parallel channels (Alert in the line's toolbar). Moving the line moves the alert.
- Price alerts can fire only when crossing up or only when crossing down.
- All of them also run on the alert server, with the app closed.

## In 1.11.0

- **Undo / redo** for drawings and indicators (Ctrl+Z / Ctrl+Y).
- **Object tree**: list, hide, lock and delete the indicators and drawings on a chart.
- **Bottom bar**: 1D 5D 1M 3M 6M YTD 1Y 5Y All date ranges, Go to date, clock and **time zone** setting.
- **Chart settings**: candle colors, background, grid, watermark, price line, countdown.
- **Saved layouts** and **indicator templates**.

## In 1.10.0

- **Bar Replay**: play history back candle by candle (Replay, top bar), with play/pause, speed and step.
- **Strategy Tester**: write a strategy in Candela Script (buy / sell / sellshort / cover rules, optional stop and target) and backtest it: net profit, win rate, profit factor, drawdown, equity curve vs buy & hold, list of trades, trades marked on the chart. Two example strategies are in the script editor.

## In 1.9.0

- **Renko, Kagi and Point & Figure** chart types (with Auto/fixed box size and reversal under *Box…*). Heikin Ashi was already there.

## In 1.8.0

- **75 drawing tools** in five toolbar menus: lines, channels and pitchforks; Fibonacci and Gann; chart patterns, Elliott waves and cycles; long/short positions, forecasts, volume profiles and measurers; brushes, arrows and shapes. Star your favorites to keep them under the heart button.

## In 1.7.0

- **Line style for indicator lines**: thickness 1–4, Line / Line with breaks / Step line / Step line with breaks / Step line with diamonds, and a Price line option (indicator settings → Style).
- **New version notice**: Candela tells you when a newer release is out, with what's new and a Download button.

## In 1.6.0

- **Perpetual futures from Binance and Bybit**: charts (every timeframe, custom ones too), indicators, watchlist, comparisons and alerts. Under the chart title: funding rate and next funding time, mark and index price, open interest. The *Across exchanges* panel shows the perpetuals next to spot. Both exchanges block some countries, including the US.

## In 1.5.0

- **Indicators on another timeframe**: every built-in indicator (SMA, EMA, WMA, Bollinger Bands, RSI, MACD…) has a *Timeframe* setting. Set an SMA 200 to 1D and it shows the 200-day average on any chart: 4H, weekly, monthly.
- **Custom timeframes**: 2D, 3H, 12H, 2W, 45m, 1M, 3M… from the ⋯ timeframe menu → *Custom…*, or type a number on the chart. They work on every exchange, live.
- New standard timeframes: 8H and 1M (monthly).

## In 1.4.0

- **HTX and Bitfinex** added, for eleven crypto exchanges in all: charts with every timeframe, live updates, watchlist, comparisons, alerts, and the *Across exchanges* panel. Bitfinex, like KuCoin and MEXC, works in this app but not in a plain browser tab. HTX keeps only its latest 2,000 candles per timeframe.

## In 1.3.0

- **Bitget and MEXC** added, for nine crypto exchanges in all: charts with every timeframe, live updates, watchlist, comparisons, alerts, and the *Across exchanges* panel. MEXC, like KuCoin, works in this app but not in a plain browser tab.

## In 1.2.0

- **OKX and Gate.io** join Binance, Bybit, KuCoin, Kraken and Coinbase: charts with every timeframe, live updates, watchlist, comparisons, alerts, and the *Across exchanges* panel.

## In 1.1.0

- **More crypto exchanges**: Bybit, KuCoin, Kraken and Coinbase, next to Binance. Pick an exchange with the chips in the symbol search. Charts, every timeframe, watchlist, comparisons and alerts all work on them.
- **Across exchanges** panel: the chart's coin on every exchange, with price, 24h change and the gap to your chart.
- Bybit is blocked in some countries (for example the US); KuCoin works in this app but not in a plain browser tab.

## Download

- **Candela-Setup-x.y.z.exe**: installer (recommended). Installs for your user only, no administrator rights needed.
- **Candela-x.y.z-portable.exe**: a single file you can run from anywhere, no install.

Windows 10 or 11, 64-bit.

**"Windows protected your PC"**: the app isn't signed with a paid certificate, so Windows SmartScreen warns the first time. Click **More info → Run anyway**.

Closing the window keeps Candela running in the system tray so your alerts keep working; right-click the tray icon to quit or to turn on *Start with Windows*. See the README for everything else.

This build was made and tested (install, start, uninstall) on GitHub's Windows machines.
