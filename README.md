# Candela Charts

A free, self-hosted charting app: live crypto, stocks, ETFs and forex, candles, drawing tools,
price alerts and **every indicator unlocked** — no account, no subscription, no limits
on how many indicators you stack.

## Windows app

Download one of these and run it:

- **Candela-Setup-1.0.0.exe**: installer (recommended). Installs for your user only, no administrator
  rights needed. Adds Start menu and desktop shortcuts and an entry under *Settings → Apps* to
  uninstall it.
- **Candela-1.0.0-portable.exe**: a single file you can run from anywhere (it starts a bit slower,
  since it unpacks itself each time).

Windows 10 or 11, 64-bit.

**"Windows protected your PC".** The app isn't signed with a paid code-signing certificate, so
Windows SmartScreen warns the first time. Click *More info → Run anyway*. (Signing certificates cost
money every year, which is the kind of subscription Candela is meant to avoid.)

The Windows app has the alert server built in, so alerts run while Candela is open:

- **Closing the window keeps Candela running** in the system tray (bottom-right, near the clock), so
  alerts keep working. Click the tray icon to open it again; right-click it → *Quit Candela* to exit.
- Right-click the tray icon → **Start with Windows** to have alerts running after you log in (Candela
  starts quietly in the tray).
- Alerts show up as **Windows notifications**, and on your phone or in chat if you set that up under
  *Alerts → Server*.
- Your charts, alerts, scripts and settings are stored in `%APPDATA%\Candela`. Uninstalling asks
  whether to delete them too.
- Keys: F11 full screen, Ctrl+R reload, F12 developer tools.

**Where to get it.** Every push to `main` builds the app on GitHub's Windows machines, tests it
(install, start, uninstall) and publishes both files on this repository's **Releases** page. You can
also start a build from the *Actions* tab → *Windows build* → *Run workflow*.

**Build it yourself**: on Windows (Node.js 18+), `npm install` then `npm run dist:win` puts both files
in `dist/`. On Linux, `npm run dist:win-linux` builds the portable app and `npm run installer:win-linux`
the installer (needs NSIS). Run it during development with `npm start`.

## Run it in a browser

It's plain HTML/JS with zero dependencies and no build step. The easiest way is the included server
(needs [Node.js](https://nodejs.org) 18 or newer), which also keeps your alerts running with the
browser closed:

```bash
cd candela
node server.js
```

Then open http://localhost:8000.

Without Node, any static web server works too (`python3 -m http.server 8000`), or open `index.html`
directly. Everything works the same, except alerts only run while the page is open.

## Alerts with the browser closed

`node server.js` serves the app and runs your alerts around the clock: price alerts and alerts on
custom-script markers. When you open the app from it, the **Alerts** panel shows a **Server** badge and
your existing alerts and scripts move to the server automatically.

**Get notified.** Click the badge (Alerts → Server) and set up one or more channels, then press
*Save & send test*:

- **ntfy** (phone push, free, no account): install the ntfy app on Android or iPhone, pick a topic
  name that is hard to guess (*Make one up* creates one), and subscribe to it in the app.
- **Telegram**: create a bot with @BotFather, send it a message, and enter the bot token and your
  chat ID.
- **Discord**: a channel's webhook URL (Edit channel → Integrations → Webhooks).
- **Slack**: an incoming-webhook URL for a channel.
- **Other webhook**: any URL that accepts a JSON POST (`{ title, message, source, time }`).

Each alert can use all of them or only some (*Notify via* in the alert's options).

Open Candela tabs also show fired alerts. Alerts on simulated (DEMO) or imported CSV data stay in the
browser, since only the browser has that data. If the server stops, open tabs take over until it is
back and then hand over what happened.

**Keep it running.** The server has to stay running for alerts to work. Some options:

```bash
# simplest: keep it running after you close the terminal (macOS / Linux)
nohup node server.js > candela.log 2>&1 &
```

On Linux you can run it as a service, `~/.config/systemd/user/candela.service`:

```ini
[Unit]
Description=Candela charts and alerts

[Service]
WorkingDirectory=%h/candela
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now candela
```

```bash
loginctl enable-linger "$USER"   # keep it running while you're logged out
```

On Windows, Task Scheduler can start `node server.js` at log-on. A cheap always-on machine
(Raspberry Pi, small VPS) works well too.

**Settings** (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on. The default only accepts connections from this computer. |
| `CANDELA_TOKEN` | (none) | Access token. Required if `HOST` is anything other than this computer; the app asks for it once. |
| `CANDELA_DATA` | `data/server-state.json` | Where alerts, scripts and notification settings are stored |

**Security.** By default the server only listens on your own computer. It never serves its data file
(which holds your notification tokens, readable only by your user account), refuses requests from
other websites, and won't listen on a network address without `CANDELA_TOKEN`. To reach it from
another device, prefer an SSH tunnel or a private VPN over opening a port to the internet; if you do
expose it, use a long random token and put it behind HTTPS.

**How it checks.** Crypto prices are fetched every 5 seconds; stocks within the Twelve Data budget
(see *Stocks, ETFs and forex*). Marker alerts are checked just after each bar
closes (or every 15 seconds for "as soon as it appears"). The server uses the app's own indicator and
script code, so alerts behave exactly as they do in the browser. Crypto data comes from the exchanges'
public APIs; no key needed.

## Crypto exchanges: Binance, Bybit, OKX, Bitget, KuCoin, Gate.io, MEXC, HTX, Kraken, Coinbase, Bitfinex, Hyperliquid (+ futures)

Binance is the default. Charts, watchlist, comparisons and alerts also work with **Bybit, OKX, Bitget,
KuCoin, Gate.io, MEXC, HTX, Kraken, Coinbase and Bitfinex** spot markets: public data, no account or key.

- **Symbol search**: the chips under the search box pick where to look: *All*, one exchange, or
  *Stocks & forex*. *All* shows the best matches on every exchange once you type. Exchange symbols show
  as `BTC/USD` with a small tag (`BY` Bybit, `OK` OKX, `BG` Bitget, `KC` KuCoin, `GT` Gate.io,
  `MX` MEXC, `HX` HTX, `KR` Kraken, `CB` Coinbase, `BF` Bitfinex, `HL` Hyperliquid, `HLS` Hyperliquid spot); the chart title
  names the exchange.
- **Across exchanges** (side panel, under the watchlist): the chart's coin on every exchange, with the
  last price, 24h change and the difference from the chart you're looking at, refreshed every 15
  seconds. Click a row to open that market. Handy for spotting premiums and gaps between exchanges.
- **Every timeframe works everywhere.** Where an exchange lacks one (Coinbase has no 4H, Kraken no 2H,
  Gate.io no 2H or weekly; HTX's daily candles start at 16:00 UTC, so its days and weeks are built too), Candela builds it from smaller candles. Weeks start on Monday on every exchange.
- **Live updates**: WebSocket on Bybit, OKX, Bitget, Gate.io, HTX, Kraken and Bitfinex; Coinbase builds the current candle from live trades;
  KuCoin and MEXC refresh every 3–4 seconds.
- **Alerts** (price, conditions, drawn lines and script markers) work on every exchange, in the browser and on the alert server.

Things to know:

- **KuCoin, MEXC and Bitfinex** don't let web pages load their data, so they work in the **Windows app** or when
  you open Candela from `node server.js` (the server relays their public market data, nothing else). In a
  plain browser tab it says so.
- **Bybit** blocks some countries, including the US. Where it's blocked, the search and the panel say
  so; elsewhere it works like the others.
- **Kraken** only gives the latest 720 candles of each timeframe (e.g. 30 days of 1H), and **HTX** the
  latest 2,000 (daily and weekly charts reach back about 330 days), so you can't scroll back further there.
- Bitfinex calls Tether **UST** and USD Coin **UDC**; Candela shows them as USDT and USDC.
- Coinbase's candle history can lag a minute behind; the live feed fills in the current candle.


### Perpetual futures: Binance and Bybit

USDT- and USDC-margined perpetual futures from **Binance Futures** and **Bybit Futures** (Binance's list
includes its stock and commodity "TradFi" perpetuals). Pick the *Binance Futures* or *Bybit Futures*
chip in the symbol search; they show as `BTC/USDT PERP`. Everything works on them as on spot: every
timeframe (custom ones too), indicators, watchlist, comparisons, alerts.

- Under the chart title: the **funding rate** and time to the next funding, **mark** and **index** price,
  and **open interest** (in dollars), refreshed every 15 seconds.
- The *Across exchanges* panel lists the perpetuals too ("Binance perp", "Bybit perp"), so you can see
  the premium of the perpetual over spot at a glance.
- Both exchanges block some countries, including the US. Where they're blocked, the search and the panel
  say so.
- If the live feed stops (some networks block it), Candela switches to refreshing every 4 seconds.

### Hyperliquid

Pick the *Hyperliquid* chip in the symbol search for its perpetuals, or *Hyperliquid Spot* for spot pairs
(HYPE/USDC and the rest). No account or key, it works in a plain browser tab too, with live updates.

- **Perpetuals** show as `BTC/USDC PERP`. Under the title: the funding rate (Hyperliquid pays funding
  **every hour**, so the rate is per hour), mark and oracle (index) price, and open interest.
- **HIP-3 markets**, the perpetuals other teams run on Hyperliquid (stocks, indexes and commodities
  such as TSLA, NVDA or GOLD), are included. They're written with the market's name in front, e.g.
  `XYZ.TSLA/USDC PERP` for Hyperliquid's `xyz:TSLA`; searching `TSLA` finds them.
- Coins Hyperliquid trades in thousands show their real names: `KPEPE` is Hyperliquid's kPEPE (1,000 PEPE);
  searching `PEPE` finds it.
- Hyperliquid gives the latest **5,000 candles** of each timeframe (about 3½ days of 1-minute candles,
  7 months of 1H, years of daily), so you can't scroll further back than that. 6H is built from smaller
  candles.
- Watchlist, comparisons, *Across exchanges* ("Hyperliquid perp" and "Hyperliquid spot"), alerts (also on
  the alert server), paper trading and every indicator work as on the other exchanges.
- **Order book and trades**: on a Hyperliquid chart the **Book** button (top bar) opens a column next to
  the chart with the live order book (12 levels a side, sizes, running totals and depth bars, the spread,
  and the bid/ask balance; group prices by 1, 2, 5, 10, 100…) and a **Trades** tab with every trade as it
  happens (buys green, sells red, big trades highlighted from a size you pick, and the last minute's buy
  and sell volume). Sizes in the coin or in dollars. Click a price in the book to place a paper order there.
- Hyperliquid limits how many requests one computer makes per minute; if a burst hits the limit, Candela
  waits a moment and tries again.

## Stocks, ETFs and forex

There are two sources, and the symbol search shows both.

### Binance bStocks: free, live, no key

Binance lists about 110 tokenized US stocks and ETFs ("bStocks", e.g. `NVDAB`, `TSLAB`, `AAPLB`, `SPYB`,
`QQQB`), each backed 1:1 by a real share. They trade as ordinary Binance pairs, so Candela charts them
like crypto: live over WebSocket, every timeframe, no key and no request limits. Search for the ticker
(`NVDA`) and pick the *bStocks* result.

What to keep in mind (measured for AAPL over six weeks):

- **Price**: during US market hours it tracks the real stock closely (typically within about 0.1%,
  at worst about 0.5%).
- **Nights and weekends**: bStocks keep trading while the stock market is closed, so those candles are
  Binance prices, not the stock's. They can drift a few percent before the market reopens.
- **Volume** is only Binance trading (a tiny fraction of the real stock's), so volume bars and
  volume-based indicators (VWAP, OBV, MFI) don't reflect the stock market.
- **History** starts at the Binance listing (mid-2026), so long averages like a 200-day MA aren't
  available yet.
- Only the listed tickers are covered. Binance restricts *trading* bStocks in some countries (including
  the US); the market data Candela reads is public.

### Twelve Data: the real exchange data (free key)

For the actual exchange prices and volume, any US stock or ETF, forex, and decades of history, use
[Twelve Data](https://twelvedata.com/pricing). Its free plan needs an API key:

1. Sign up at twelvedata.com (free) and copy your API key from the dashboard.
2. In Candela, search for a stock (e.g. `AAPL`, `SPY`, `EUR/USD`) and pick it; the first time, Candela
   asks for the key (also under *Symbol search → Stock data…*). *Check key* confirms it works.
3. Just trying it out? *Use the demo key* works for AAPL and EUR/USD only.

Stocks work everywhere crypto does: multi-chart layouts, indicators and scripts, comparison (e.g. AAPL
vs BTC), the watchlist, and alerts, including on the alert server.

**About the free plan.** It allows 8 requests a minute and 800 a day, so Candela budgets them:

- Loading a chart or older history costs one request (up to 5,000 bars).
- Open stock charts refresh every minute or two while the market is open (the status at the top
  right says how often), spread out so all open charts together stay within the daily limit, and only
  occasionally while the market is closed. Forex trades around the clock on weekdays.
- Chart loads come first; live updates next; watchlist prices and background alerts last.
- The alert server checks stock alerts every few minutes (marker alerts on closed bars every 2 minutes,
  price alerts against each minute's high and low, so a quick spike still counts).
- If you have a paid Twelve Data plan, raise the limits under *Stock data… → Plan limits*.

Timeframes for stocks: 1m, 5m, 15m, 30m, 1H, 2H, 4H, 1D, 1W (3m, 6H, 12H and 3D are crypto only).
US listings work on the free plan; other exchanges may need a paid Twelve Data plan. The free plan
is meant for personal use.

## Features

- **Live data**: every Binance spot pair (BTC, ETH, SOL, ~3,000 pairs), real-time via WebSocket,
  with a bar-close countdown; plus Bybit, OKX, Bitget, KuCoin, Gate.io, MEXC, HTX, Kraken, Coinbase and Bitfinex, and Binance and
  Bybit perpetual futures with funding rate and open interest (see above). **Stocks and ETFs** as Binance bStocks (free, live, no key) or via
  Twelve Data with forex too (free key); see above.
  Scroll or zoom left and older history loads automatically.
- **Timeframes**: 1m 3m 5m 15m 30m 1H 2H 4H 6H 8H 12H 1D 3D 1W 1M, plus **your own** (2D, 3H, 2W, 45m,
  3M…): see *Custom timeframes* below. Works on every exchange.
- **Indicators on another timeframe**: any built-in indicator can be calculated on a fixed timeframe
  (e.g. a 200-day SMA that stays the same on 4H, weekly or monthly charts); see below.
- **Multi-chart layouts**: 1 to 16 charts side by side, stacked, or in grids (2×2, 3×2, 4×2, 3×3, 4×3, 4×4, one large + two,
  and more). Each chart has its own symbol, timeframe, chart type, indicators and live feed. Optional
  sync of symbol, timeframe, crosshair and date range across charts. Click a chart (or `Alt+1`…`Alt+9`)
  to make it the one the top bar controls; drag the dividers between charts to resize them (double-click a
  divider to make its two sides equal); right-click → *Maximize this chart* to go back to one.
- **Symbol comparison**: overlay up to 5 other symbols on a chart (*Compare* button, or right-click →
  *Compare symbol…*). The price scale switches to percent change from the first visible bar so
  different-priced assets line up; each comparison has its own color and can be hidden or removed from
  the legend. Works with imported CSV data too (e.g. a stock vs BTC). The **%** button turns on the
  percent scale without comparing; click it again for a scale **indexed to 100** at the first bar on screen
  (shown as **100**), and once more to go back to prices.
- **Chart types**: candles, hollow candles, Heikin Ashi, bars, line, area, baseline (green above, red below
  the first bar on screen), step line, high-low, volume candles (wider candles for more volume), and
  **Renko, Kagi, Point & Figure, Line break and Range bars** (see below)
- **Custom indicators** with Candela Script, a small language with an editor, examples and reference
  (see below).
- **Indicators (78)**, all free:
  - *Moving averages and overlays*: SMA, EMA, WMA, Hull, DEMA, TEMA, VWMA, ALMA, SMMA, KAMA, Least Squares,
    McGinley Dynamic, MA Ribbon, MA Cross, Envelopes, Bollinger Bands, Keltner, Donchian, VWAP, Supertrend,
    Parabolic SAR, Ichimoku, Chandelier Exit, Williams Alligator, Williams Fractals, Zig Zag, Pivot Points
    (Traditional, Fibonacci, Woodie, Camarilla; daily/weekly/monthly/yearly), Volume.
  - *Oscillators*: RSI, Connors RSI, MACD, PPO, Stochastic, Stochastic RSI, CCI, Williams %R, MFI, ADX/DMI,
    Aroon, Awesome and Accelerator Oscillators, Ultimate Oscillator, TRIX, KST, Fisher Transform, Momentum,
    ROC, DPO, Coppock Curve, Vortex, True Strength Index, Chande Momentum, Balance of Power.
  - *Volume and volatility*: OBV, Accumulation/Distribution, Chaikin Money Flow, Chaikin Oscillator, Elder
    Force Index, Ease of Movement, Price Volume Trend, Volume Oscillator, ATR, Standard Deviation, Historical
    Volatility, Bollinger %B and BandWidth, Choppiness Index, Mass Index.
  - *Order flow and smart money*: Volume Delta, Cumulative Volume Delta, Volume Profile (Visible Range),
    Fair Value Gaps, Order Blocks, Liquidity Levels, Market Structure (BOS / CHoCH); see below.
  - *Derivatives*: Open Interest, Funding Rate, Long/Short Ratio; see below.
  Every input and color is editable; oscillators get their own resizable, reorderable panes.
- **Drawing tools (77)**: lines, channels, pitchforks, Fibonacci and Gann tools, chart patterns, Elliott
  waves, cycles, long/short positions, forecasts, volume profiles, fair value gap and order block zones, measurers, brushes, arrows and shapes;
  see *Drawing tools* below.
- **Alerts** with sound, on-screen and desktop notifications, and with the included server also when
  the browser is closed, via phone push (ntfy), Telegram or Discord/Slack webhooks:
  - *Price crossing* a level (either way, or only up / only down), for any symbol.
  - *Conditions* (Alert dialog, or the bell on any indicator's legend row): the price or any indicator line
    *crossing*, *crossing up*, *crossing down*, *greater than* or *less than* a value or another line. For
    example RSI crossing up 30, EMA 20 crossing EMA 50, price greater than SMA 200, MACD crossing its
    signal. Checked when the bar closes or as soon as it happens, every time (once per bar) or only once.
    Indicators set to another timeframe are calculated on the alert's timeframe.
  - *Drawn lines*: select a trend line, ray, extended line or parallel channel and click **Alert** in its
    toolbar: fires when the price crosses the line (or only up / only down). Moving the line moves the alert.
  - *Script markers*: fire when a custom script's `mark` appears, either when the bar closes (no false
    alarms) or as soon as it appears, every time or only once. Create one from the bell on the script's
    legend row or the Alert dialog. Each alert watches its own symbol and timeframe with the settings
    it was created with, even if the chart shows something else, and only new markers fire (not ones
    already on the chart).
  - *Zones*: select a rectangle and click **Alert**: fires when the price enters and/or leaves its price
    range. Moving or resizing the rectangle moves the alert.
  - *Options* for every alert (*Expiry, active hours* in the dialog, or right-click → *Edit alert*): an
    **expiry** (in 1 hour … 1 month, or a date), **active hours** (e.g. 09:00–17:00, Monday to Friday, in
    your time zone; outside them the alert doesn't fire) and, with the server, which channels to notify.
  - **Alert log** (*Log* next to the Alerts title): every alert that fired, here or on the server, with the
    message saying what happened (price, level, indicator values), and every expiry.
- **Paper trading** with virtual money: market, limit and stop orders, take profit and stop loss as
  draggable lines on the chart, a trade journal, and trading during Bar Replay; see below.
- **Watchlist** with live prices and 24h change.
- **CSV import** for anything else: Date, Open, High, Low, Close, Volume (Yahoo Finance-style exports
  work).
- Themes: Dark, Ocean (dark blue), Slate (dark grey), Light and Paper (warm light), in Chart settings; the moon button switches between your light and dark one. PNG snapshot of the whole layout, everything persisted in your browser.
- Offline fallback: if Binance is unreachable it switches to a simulated demo feed.

## Custom timeframes

Open the **⋯** timeframe menu → *Custom…*, or just type a number on the chart (`2` → `2D` → Enter).
Write a number and a unit: `m` minutes, `H` hours, `D` days, `W` weeks, `M` months; a plain number
means minutes. Examples: `2D`, `3H`, `12H`, `2W`, `45`, `1M`, `3M` (quarters). Your timeframes are
listed in the ⋯ menu; remove them in the same dialog.

When an exchange doesn't offer a timeframe, Candela builds it from smaller candles (a 2D candle from two
1D candles, a month from daily candles), live updates included. Days start at midnight UTC, weeks on
Monday, months on the 1st. Intraday lengths that don't divide a day evenly (5H, 7H…) restart at midnight,
so the last candle of each day is shorter. Stocks and forex can use custom timeframes of a day or more.

## Order flow and smart-money indicators

- **Volume Delta**: buy volume minus sell volume for each candle. **Cumulative Volume Delta (CVD)**: the
  running total, optionally restarting each day, week or month. On Binance (spot and futures) these use the
  exchange's real taker-buy volume. Other exchanges don't publish it per candle, so there it is estimated
  from where each candle closed in its range; that estimate only roughly follows real buying and selling.
- **Volume Profile (Visible Range)**: the volume traded at each price over the candles on screen, split into
  buying and selling, with the point of control (busiest price) and the value area (70% of the volume, set
  in its inputs). It updates as you scroll and zoom.
- **Fair Value Gaps**: three-candle gaps where the first candle's high and the third candle's low don't
  overlap (or the reverse). Shown as boxes until the price fills them (at the far edge, the middle or the
  near edge; your choice), with a minimum size and how many to show.
- **Order Blocks**: when a close breaks the last swing high, the lowest down candle since that swing is a
  bullish block (the reverse for bearish blocks). Shown until a candle closes through it.
- **Liquidity Levels**: swing highs (buy-side liquidity, BSL) and swing lows (sell-side, SSL) where stops
  tend to sit; equal highs and lows (EQH / EQL) highlighted; a level is marked ✓ swept once the price
  trades through it.
- **Market Structure**: breaks of a swing high or low in the trend's direction (BOS) and against it
  (CHoCH).

These are Candela's own versions of widely used ideas; settings and colors are in each indicator's dialog.

## Derivatives data and the Market window

- **Open Interest**, **Funding Rate** and **Long/Short Ratio** indicators (Indicators → search "open
  interest", "funding", "long/short"): their history under the chart, for any crypto chart. The data comes
  from the chart's own exchange when it's a perpetual (Binance Futures, Bybit Futures; Hyperliquid for
  funding, which it pays every hour), otherwise from the coin's USDT perpetual on Binance, then OKX, then
  Bybit, whichever answers (some block some countries). The legend names the source. Open interest is in
  dollars (or its change per candle); funding per payment, per 8 hours or per year; long/short is long
  accounts divided by short accounts. They refresh every minute. Binance keeps 30 days of open interest and
  long/short history, OKX and Bybit a few hundred periods, so older candles have no value.
- **Liquidations**: the **Book** button on any crypto chart opens a *Liquidations* tab: the coin's
  liquidations on Binance, Bybit and OKX as they happen (longs liquidated red, shorts green, big ones
  highlighted) and the last hour's total for each side.
- **Market** (top bar):
  - *Funding rates*: the current funding of your coins (the chart's, your watchlist's and 30 majors) on
    Binance, Bybit, OKX, Bitget, Gate.io, MEXC, HTX, KuCoin and Hyperliquid side by side, in % per 8 hours,
    with the average and what it comes to over a year; or the 30 highest and lowest across all coins.
    Click a row to open the coin. MEXC, HTX and KuCoin need the Windows app or `node server.js`.
  - *RSI heatmap*: RSI 14 of the top 40 coins on Binance (or your watchlist) on 15m, 1H, 4H or 1D, placed
    on a 0–100 scale with the overbought and oversold zones. Click a coin to open it.
  - *Fear & Greed*: the Crypto Fear & Greed Index (alternative.me) today, compared with yesterday, last
    week, last month and a year ago, with its history.

## Indicators on another timeframe

Every built-in indicator except Volume has a **Timeframe** setting (click its name in the legend):
*Same as chart* (the default), any standard timeframe, or a custom one.

Example: on a weekly Bitcoin chart, add *Moving Average (SMA)*, set Length to **200** and Timeframe
to **1D**. The line is the 200-day average, and it stays the 200-day average when you switch the chart
to 4H, 1D or 1M. The legend shows it as `SMA 200 · 1D`.

How it's placed on the chart: each chart candle shows the value of the latest indicator-timeframe
candle that started before it ended. On a 4H chart a daily SMA steps once a day; on a weekly chart each
week shows the daily SMA as of its last day. On a lower-timeframe chart the current day's value moves
with the live price until the day closes, as on other charting apps. It works for oscillators too
(an RSI on 1D below a 1H chart). Custom scripts always use the chart's timeframe.

## Working with charts

- **Undo / redo** (`Ctrl+Z`, `Ctrl+Y` or `Ctrl+Shift+Z`, or the arrows at the top): drawings and indicators,
  per chart.
- **Object tree** (list button in the left toolbar): every indicator and drawing on the chart. Show or hide,
  lock, delete, open an indicator's settings, or click a drawing to jump to it.
- **Bottom bar**: date ranges **1D 5D 1M 3M 6M YTD 1Y 5Y All** (each picks a fitting timeframe and loads
  the history it needs), **Go to date** (calendar button), the current time and the **time zone** of the time
  axis (your computer, UTC, or a market city).
- **Measure**: `Shift` + click on the chart (or the ruler in the left toolbar), move, click again: price change, %,
  candles and time. Nothing is saved; the next click or `Esc` removes it.
- **Alerts on the chart**: drag a price alert's dashed line to move it; right-click it (or the alert in the
  Alerts list) to edit or remove it.
- **Indicator colors with opacity**: every color in an indicator's *Style* tab has an opacity slider, from
  0% (invisible) to 100% (solid).
- **Chart settings** (gear at the top): (also in the chart's right-click menu) up/down candle colors, background, grid lines, symbol watermark,
  last price line, candle countdown, time zone. They apply to every chart; *Defaults* resets them.
- **Saved layouts** (layout menu → *Save this layout as…*): keep named sets of charts (symbols, timeframes,
  indicators, chart types and arrangement) and switch between them. **Export to file** saves the current
  layout with its drawings and the scripts it uses as a `.json` file; **Import file…** opens one (on another
  computer, say) and adds it to your saved layouts. Drawings you already have are kept.
- **Up to 16 charts**: the layout menu has 4×2, 3×3, 4×3 and 4×4 grids.
- **Several watchlists**: click the watchlist's name for your lists, *New list…*, *Copy this list…*,
  *Rename…* and *Delete*.
- **Watchlist**: *All / Gainers / Losers* tabs, a 24h volume column, and sorting by any column (click its
  header; again to reverse; a third time for your own order).
- **Keyboard shortcuts**: press `?` (or right-click the chart → *Keyboard shortcuts*) for the full list.
- **Indicator templates** (Indicators → *Templates*): save a chart's indicators under a name and apply them
  to any chart in one click.

## Bar Replay

**Replay** (top bar) plays history back as if it were live, to practise reading the chart. Click it, then
click the candle where the replay should start (scroll left first to start further back). Everything after
that candle disappears; the controls at the bottom play the candles back (0.5 to 30 per second), step one
candle at a time (or `Shift+→`), or pick a new start. Indicators, drawings and the Strategy Tester follow the
replay, and indicators set to another timeframe only see the past. Alerts don't fire during a replay.
**Exit replay** returns to live data.

## Paper trading

Practise trading with virtual money. Click **Trade** (top bar) to open the trading panel under the charts.
Each paper account starts with $100,000 (up to 5 accounts; rename, reset with any balance, or delete them in
the *Account* tab).

- **Orders**: *Buy* / *Sell* in the panel opens an order ticket: market, limit or stop, a quantity or an
  amount in dollars (or 10/25/50/100% of equity), and an optional take profit and stop loss. Right-click the
  chart at a price for *Buy limit / stop at …* and *Sell limit / stop at …* (a limit below the price buys
  cheaper, a stop above it buys on a breakout; the reverse for selling).
- **On the chart**: your position (with its open P&L), waiting orders, stop loss and take profit are lines
  with labels. Drag an order, stop loss or take profit line to move it; right-click a line to cancel the
  order, close the position or remove the stop.
- **Panel tabs**: *Positions* (close, edit TP/SL), *Orders* (cancel), *History* (every fill, with a note
  field for each), *Journal* (win rate, profit factor, best and worst trade, fees, and your own journal
  entries), *Account* (commission, leverage, starting balance, lines on/off).
- **Fills**: market orders fill at the last price; limit and stop orders, stops and targets fill when a price
  update reaches them (from the charts, the watchlist or alert feeds; Candela follows the symbols you have
  positions or orders in by itself). Commission defaults to 0.05% per fill. Leverage 1 means positions can be
  worth up to your equity; raise it in the Account tab. Buying while short reduces the short first.
- **In Bar Replay** the replaying chart trades on its own practice account (shown as *Replay practice*):
  orders, stops and targets fill candle by candle (at the order's price, or at the open if the candle gaps
  past it; a stop counts before a target in the same candle). When the replay ends you get the results:
  return, win rate, every fill, and a button to save the summary to your journal.

Everything is saved in the browser (or the Windows app). It is practice only: real fills differ (spread,
slippage, liquidity), and orders only fill while Candela is open.

## Strategy Tester (backtesting)

A strategy is a Candela Script with trading rules:

```
name "EMA cross strategy"
strategy capital 10000 size 100 commission 0.1 stop 5
fast = ema(close, 9)
slow = ema(close, 21)
buy crossover(fast, slow)
sell crossunder(fast, slow)
```

- `buy` opens a long position (or turns a short into a long), `sell` closes it; `sellshort` opens a short
  (or turns a long into a short), `cover` closes it.
- The optional `strategy` line sets defaults: starting `capital`, order `size` (% of equity), `commission`
  (% per order), `stop` loss and take profit `target` (% from the entry; 0 = off), and `slippage` (% per fill:
  buys fill that much higher, sells that much lower).
- Rules are checked when a candle closes and orders fill at the next candle's open, so the test never looks
  ahead. Stops and targets are checked inside each candle; if one candle touches both, the stop counts.

Add a strategy to a chart and the **Strategy Tester** opens below it (or click **Strategy** at the top):
*Overview* (net profit, win rate, profit factor, max drawdown, average trade, buy & hold, commission, and
the equity curve against buy & hold), *Long / short* (every statistic for all, long and short trades side
by side), *By day* (profit by weekday and day by day, in your time zone), *Monte Carlo* (1,000 made-up
histories drawn at random from the strategy's trades: the range of returns and drawdowns, and how often it
lost money), *List of trades* (click one to see it on the chart), and *Properties* (change capital, size,
commission, stop, target and slippage without editing the script). The trades are marked on the
chart. It tests the candles loaded on the chart: scroll left to load more history. Two examples are in the
script editor: *Strategy: EMA cross* and *Strategy: RSI long/short*.

## Renko, Kagi, Point & Figure, Line break and Range bars

Pick them in the chart-type menu. They ignore time: a new brick, line or column appears only when the
price moves enough, so quiet periods take no space. They're built from the closes of the chart's
timeframe (a 1H Renko chart uses 1-hour closes).

- **Renko**: a brick each time the close moves a full box beyond the last brick; two boxes to turn around.
- **Kagi**: a line that turns when price reverses by the reversal amount; thick and green (yang) after it
  rises above the previous high, thin and red (yin) after it falls below the previous low.
- **Point & Figure**: columns of X (rising) and O (falling), one mark per box; a new column after the
  reversal number of boxes (3 by default).
- **Line break**: a new line when the close goes beyond the last line in the trend's direction; the trend
  turns only when the close goes beyond the high or low of the last 3 lines (set the number in *Box…*).
- **Range bars**: every bar spans the same price range (ATR 14 or a fixed range). They're built from each
  candle's open, high, low and close, so the order of moves inside one candle is assumed.

**Box…** next to the menu sets the size: *Auto* uses the 14-bar Average True Range rounded to a round
number (shown in the title, e.g. `Renko · box 500 (ATR 14)`), or a fixed size; Kagi can also reverse by a
percentage. Indicators, comparisons and drawings follow the bricks, as on other charting apps. Alerts keep
using the real candles, so they behave the same whatever the chart type.

## Drawing tools

The left toolbar has five groups. Click a group to use the tool it shows; hover it and click the small
arrow on its right edge (or right-click it) for the whole menu. A group remembers the tool you picked.
Star tools (★ in the menus) to collect them under the **heart** button.

- **Magnet** (left toolbar): click once for *weak* (points snap to a candle's open, high, low or close when
  the mouse is close to one), again for *strong* (always snaps), again for off. The button shows W or S.
- **Shift** while drawing or dragging a point keeps the line horizontal, vertical or at 45°.
- **Visibility**: select a drawing, click *Visibility* in its toolbar and pick the timeframes it shows on
  (minutes, hours, days, weeks, months), e.g. weekly levels that stay off your 5-minute charts.
- **Fibonacci levels**: select a Fib retracement, extension or channel and click *Levels*: pick a set
  (classic, with extensions, OTE 0.5 / 0.618 / 0.705 / 0.79) or type your own ratios, extend the lines to
  the right, shade between levels or not.

- **Lines**: Trend line, Ray, Info line (change, %, bars and angle), Extended line, Trend angle, Horizontal
  line, Horizontal ray, Vertical line, Crossline. **Channels**: Parallel channel, Regression trend (with
  ±2 standard deviations), Flat top/bottom, Disjoint channel. **Pitchforks**: Pitchfork, Schiff, Modified
  Schiff, Inside pitchfork.
- **Fibonacci**: Retracement, Trend-based extension, Channel, Time zone, Speed resistance fan, Trend-based
  time, Circles, Spiral, Speed resistance arcs, Wedge, Pitchfan. **Gann**: Box, Square fixed, Square, Fan.
- **Patterns**: XABCD, Cypher, Head and shoulders, ABCD, Triangle, Three drives (with the ratios between
  legs). **Elliott waves**: Impulse (1-5), Correction (A-C), Triangle (A-E), Double combo (W-X-Y), Triple
  combo (W-X-Y-X-Z). **Cycles**: Cyclic lines, Time cycles, Sine line.
- **Forecasting**: Long and Short position (drag target, stop and end; shows risk/reward and whether the
  target or the stop was hit), Position forecast, Bars pattern (copies the candles of a range to where you
  click), Ghost feed (sketch future candles), Sector. **Volume**: Anchored VWAP, Fixed range volume
  profile, Anchored volume profile (with point of control and the 70% value area). **Smart money**: Fair
  value gap (click the middle candle of a three-candle gap; the box runs right until the price fills it) and
  Order block (click a candle; it holds until a close through its far side). **Measurers**: Price
  range, Date range, Date and price range.
- **Brushes**: Brush, Highlighter. **Arrows**: Arrow marker, Arrow, Arrow mark up/down (with optional text).
  **Shapes**: Rectangle, Rotated rectangle, Path, Circle, Ellipse, Polyline, Triangle, Arc, Curve, Double curve.
- **Text**.

How to draw: most tools take 2 clicks (or press, drag and release); tools with more points take one click
per point (a pitchfork 3, XABCD 5, head and shoulders 7). *Path*, *Polyline* and *Ghost feed* take as many
points as you like: double-click or press Enter to finish. Brushes draw while you hold the mouse button.
Long/Short position, horizontal and vertical lines, arrow marks and anchored tools take one click. `Esc`
cancels. Select a drawing to drag it or its points, change its color, width and dash, lock it, or delete it.
Shortcuts: `Alt+T` trend line, `Alt+H` horizontal line, `Alt+J` horizontal ray, `Alt+V` vertical line,
`Alt+C` crossline, `Alt+F` Fib retracement, `Alt+M` date and price range, `Alt+Shift+R` rectangle.

## Line style

In an indicator's settings, the **Style** tab has, for every line: its color, a **thickness** from 1 to 4,
and a line-type menu with **Price line** (a dotted line across the chart at the latest value) and the
line types *Line*, *Line with breaks*, *Step line*, *Step line with breaks* and *Step line with diamonds*.
Step lines suit indicators on another timeframe (a daily SMA on a 4H chart), and the diamonds mark each
new value. *Line* joins over missing values; the *with breaks* types leave a gap.

## Updates

The Windows app (and the page served by `node server.js`) checks GitHub for a newer release when it
starts and every 6 hours, and shows a small notice with what's new and a **Download** button. Install the
new version over the old one (quit Candela from the tray first); your charts and alerts are kept.
*Skip this version* hides the notice until the next release.

## Controls

| Action | How |
| --- | --- |
| Pan | drag the chart, or horizontal scroll |
| Zoom time | mouse wheel, or drag the time axis |
| Zoom price | drag / wheel on the price axis (double-click it to re-enable auto-scale) |
| Reset view | `Alt+R`, double-click time axis, or the **reset** button |
| Symbol search | just start typing a ticker |
| Indicators | `/` |
| Custom timeframe | type a number (`2`, then `D`, Enter = 2 days) |
| Tools | `Alt+T` trend, `Alt+H` horizontal, `Alt+J` horizontal ray, `Alt+V` vertical, `Alt+C` crossline, `Alt+F` fib, `Alt+M` measure, `Alt+Shift+R` rectangle |
| Finish a path / polyline | double-click or `Enter` |
| Bar Replay: next candle | `Shift+→` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) |
| Measure | `Shift` + click on the chart (or the ruler in the left toolbar), then click again; the next click removes it |
| Move a price alert | drag its dashed line up or down |
| Edit or remove an alert | right-click its line on the chart, or the alert in the Alerts list |
| Alert | `Alt+A`, or right-click the chart → *Add alert at …* |
| Paper order at a price | right-click the chart → *Buy limit / stop at …* or *Sell …* |
| Move a paper order, stop loss or take profit | drag its line on the chart |
| Delete drawing | select it, then `Del` |
| Focus chart N in a layout | `Alt+1` … `Alt+9` |
| All keyboard shortcuts | `?` |
| Keep a drawing line horizontal, vertical or at 45° | hold `Shift` while drawing or dragging a point |
| Cancel | `Esc` |

## Custom indicators: Candela Script

Click **Scripts** in the top bar (or *Write a new script…* in the Indicators dialog) to open the editor.
It has syntax highlighting, live error checking with line numbers, six example scripts, and a built-in
reference. Saved scripts appear under *My scripts* in the Indicators dialog, get a normal settings
dialog for their inputs and colors, and editing a script updates every chart that uses it.

```
// Fast/slow moving average cross with a trend-colored band
name "MA Cross"
overlay
input fast = 9 "Fast length" min 1
input slow = 21 "Slow length" min 1

f = ema(close, fast)
s = sma(close, slow)

fill f, s color f > s ? fade(green, 0.15) : fade(red, 0.15)
plot f "Fast" color blue width 2
plot s "Slow" color orange width 2
mark crossover(f, s) "Buy" below color green
mark crossunder(f, s) "Sell" above color red
```

**How it works.** Every value is a series (one number per bar), and operators work bar by bar:
`close - open`, `close > open ? green : red`, and `x[1]` for the previous bar. There are no loops, so
every script finishes, and scripts run in Candela's own interpreter: they can't touch the page, the
network or your data.

| Statement | Meaning |
| --- | --- |
| `name "Title"` / `short "Abbr"` | Name in the legend |
| `overlay` | Draw on the price chart (default: own pane) |
| `input len = 14 "Label" min 1 max 200` | A setting; defaults can be a number, `true`/`false`, or a source like `close` |
| `x = expression` | Name a calculation |
| `plot x "Label" color red width 2 style histogram` | Draw a series (`line`, `histogram`, `dots`); color can change per bar |
| `mark condition "Buy" below color green` | Marker on bars where the condition is true; can trigger alerts |
| `level 70` | Dashed horizontal line |
| `fill a, b color fade(blue, 0.1)` | Shade between two series or two levels |

Built-ins: `open high low close volume hl2 hlc3 ohlc4 time bar_index hour minute dayofweek dayofmonth
month year`, and functions `sma ema wma rma hma vwma linreg rsi stoch cci atr tr stdev highest lowest
change roc sum cum crossover crossunder cross rising falling barssince valuewhen if nz isna abs sqrt
log log10 exp floor ceil sign round pow min max avg clamp rgba rgb fade`. The editor's reference panel
documents each one.

## Adding a built-in indicator in JavaScript

Indicators live in `js/indicators.js` as plain objects. Add one to `DEFS`:

```js
{
  id: 'mom', name: 'Momentum', short: 'MOM', overlay: false,
  inputs: [{ key: 'length', label: 'Length', type: 'int', def: 10, min: 1 }],
  plots: [{ key: 'mom', name: 'Momentum', color: '#3D8BFD' }],
  levels: [0],
  calc: (bars, p) => ({ mom: bars.map((b, i) => i >= p.length ? b.c - bars[i - p.length].c : NaN) }),
}
```

It shows up in the Indicators dialog automatically, with a settings panel generated from `inputs`.

## Files

- `js/chart.js`: canvas chart engine (panes, axes, rendering, crosshair, interaction)
- `js/drawings.js`: the drawing tools (each tool's points and how it's drawn; also used for selecting them)
- `js/indicators.js`: indicator math + definitions
- `js/script.js`: Candela Script: lexer, parser, checker, interpreter, built-in functions
- `js/alerts-core.js`: alert rules shared by the browser and the server
- `js/backtest.js`: the Strategy Tester's backtest engine
- `js/paper.js`: paper trading: accounts, orders, fills, P&L
- `js/derivs.js`: open interest, funding and long/short history, liquidations, funding across exchanges
- `js/data.js`: Binance REST/WebSocket, Twelve Data, demo feed, CSV parser
- `js/exchanges.js`: Bybit, OKX, Bitget, KuCoin, Gate.io, MEXC, HTX, Kraken, Coinbase, Bitfinex, Binance and
  Bybit futures, and building missing timeframes
- `server.js`: the alert server (also serves the app)
- `desktop/`: the Windows app (Electron): `main.js` (window, tray, notifications), `preload.js`,
  `installer.nsi` (installer), icons
- `js/app.js`: UI: chart layouts and sync, toolbar, dialogs, watchlist, alerts, persistence

## Limits

- Stocks and forex need a free Twelve Data key, and its free plan limits how often charts can refresh
  (every minute or two, slower with many stock charts open). There is no pre-market or after-hours data.
- KuCoin, MEXC and Bitfinex need the Windows app or `node server.js`; Bybit is unavailable where Bybit
  blocks access (e.g. the US); Kraken charts stop at 720 candles back, HTX charts at 2,000.
- Without the server, alerts only run while the tab is open. With it, the server has to stay running.
