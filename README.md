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
- **Webhook**: a Discord or Slack incoming-webhook URL, or any URL that accepts a JSON POST
  (`{ title, message, source, time }`).

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
script code, so alerts behave exactly as they do in the browser. Data comes from Binance's public API;
no key needed.

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
  with a bar-close countdown. **Stocks and ETFs** as Binance bStocks (free, live, no key) or via
  Twelve Data with forex too (free key); see above.
  Scroll or zoom left and older history loads automatically.
- **Timeframes**: 1m 3m 5m 15m 30m 1H 2H 4H 6H 12H 1D 3D 1W
- **Multi-chart layouts**: 1 to 6 charts side by side, stacked, or in grids (2×2, 3×2, one large + two,
  and more). Each chart has its own symbol, timeframe, chart type, indicators and live feed. Optional
  sync of symbol, timeframe, crosshair and date range across charts. Click a chart (or `Alt+1`…`Alt+6`)
  to make it the one the top bar controls; drag the dividers between charts to resize them (double-click a
  divider to make its two sides equal); right-click → *Maximize this chart* to go back to one.
- **Symbol comparison**: overlay up to 5 other symbols on a chart (*Compare* button, or right-click →
  *Compare symbol…*). The price scale switches to percent change from the first visible bar so
  different-priced assets line up; each comparison has its own color and can be hidden or removed from
  the legend. Works with imported CSV data too (e.g. a stock vs BTC). The **%** button turns on the
  percent scale without comparing.
- **Chart types**: candles, hollow candles, Heikin Ashi, OHLC bars, line, area. Log scale.
- **Custom indicators** with Candela Script, a small language with an editor, examples and reference
  (see below).
- **Indicators (22)**: Volume, SMA, EMA, WMA, MA Ribbon, Bollinger Bands, Keltner, Donchian, VWAP,
  Supertrend, Parabolic SAR, Ichimoku, RSI, MACD, Stochastic, Stochastic RSI, CCI, Williams %R,
  MFI, ADX/DMI, ATR, OBV, ROC. Every input and color is editable; oscillators get their own
  resizable, reorderable panes.
- **Drawing tools**: trend line, ray, extended line, arrow, horizontal/vertical line, rectangle,
  Fibonacci retracement, measure (Δprice, %, bars, time), text. Magnet snapping, color/width/dash,
  lock, drag to edit. Drawings are saved per symbol.
- **Alerts** with sound, on-screen and desktop notifications, and with the included server also when
  the browser is closed, via phone push (ntfy), Telegram or Discord/Slack webhooks:
  - *Price crossing* a level, for any symbol.
  - *Script markers*: fire when a custom script's `mark` appears, either when the bar closes (no false
    alarms) or as soon as it appears, every time or only once. Create one from the bell on the script's
    legend row or the Alert dialog. Each alert watches its own symbol and timeframe with the settings
    it was created with, even if the chart shows something else, and only new markers fire (not ones
    already on the chart).
- **Watchlist** with live prices and 24h change.
- **CSV import** for anything else: Date, Open, High, Low, Close, Volume (Yahoo Finance-style exports
  work).
- Light/dark theme, PNG snapshot of the whole layout, everything persisted in your browser.
- Offline fallback: if Binance is unreachable it switches to a simulated demo feed.

## Controls

| Action | How |
| --- | --- |
| Pan | drag the chart, or horizontal scroll |
| Zoom time | mouse wheel, or drag the time axis |
| Zoom price | drag / wheel on the price axis (double-click it to re-enable auto-scale) |
| Reset view | `Alt+R`, double-click time axis, or the **reset** button |
| Symbol search | just start typing a ticker |
| Indicators | `/` |
| Tools | `Alt+T` trend, `Alt+H` horizontal, `Alt+V` vertical, `Alt+F` fib, `Alt+M` measure |
| Alert | `Alt+A`, or right-click the chart → *Add alert at …* |
| Delete drawing | select it, then `Del` |
| Focus chart N in a layout | `Alt+1` … `Alt+6` |
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

- `js/chart.js`: canvas chart engine (panes, axes, rendering, crosshair, drawings, interaction)
- `js/indicators.js`: indicator math + definitions
- `js/script.js`: Candela Script: lexer, parser, checker, interpreter, built-in functions
- `js/alerts-core.js`: alert rules shared by the browser and the server
- `js/data.js`: Binance REST/WebSocket, demo feed, CSV parser
- `server.js`: the alert server (also serves the app)
- `desktop/`: the Windows app (Electron): `main.js` (window, tray, notifications), `preload.js`,
  `installer.nsi` (installer), icons
- `js/app.js`: UI: chart layouts and sync, toolbar, dialogs, watchlist, alerts, persistence

## Limits

- Stocks and forex need a free Twelve Data key, and its free plan limits how often charts can refresh
  (every minute or two, slower with many stock charts open). There is no pre-market or after-hours data.
- Without the server, alerts only run while the tab is open. With it, the server has to stay running.
