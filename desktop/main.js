/* Candela for Windows (Electron).
 *
 * Runs the Candela alert server (server.js) inside the app and shows the app in a window. Closing the
 * window keeps Candela running in the system tray, so alerts keep working; quit from the tray icon.
 * Alerts appear as Windows notifications (and on your phone/chat if you set that up in Alerts → Server). */
'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ID = 'com.candela.charts'; // must match "appId" in package.json (Windows uses it for notifications)
const PORTS = [47821, 47822, 47823, 47824, 47825]; // fixed, so saved charts (stored per address) are found again
const ROOT = path.join(__dirname, '..');
const icon = (name) => path.join(__dirname, 'icons', name);

let win = null, tray = null, server = null, port = null, quitting = false, stopping = false;

// ---------------------------------------------------------------- preferences (window size, tray options)
const prefsFile = () => path.join(app.getPath('userData'), 'desktop-prefs.json');
let prefs = { closeToTray: true, trayHintShown: false, bounds: null, maximized: false };
function loadPrefs() { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch (e) { /* first run */ } }
function savePrefs() { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 1)); } catch (e) { /* ignore */ } }

// ---------------------------------------------------------------- single instance: a second launch shows the first
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Windows shows notifications only for apps whose Start-menu shortcut carries the app ID. The installer
// creates the shortcut; the portable version creates one here. Either way, make sure the ID is set.
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Candela.lnk');
  const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; // portable: the .exe you ran, not its temp copy
  try {
    let cur = null;
    try { cur = shell.readShortcutLink(lnk); } catch (e) { /* no shortcut yet */ }
    if (!cur) shell.writeShortcutLink(lnk, 'create', { target, appUserModelId: APP_ID, description: 'Candela charts and alerts', icon: target, iconIndex: 0 });
    else if (cur.appUserModelId !== APP_ID || (process.env.PORTABLE_EXECUTABLE_FILE && cur.target !== target)) {
      shell.writeShortcutLink(lnk, 'update', { target: process.env.PORTABLE_EXECUTABLE_FILE ? target : cur.target, appUserModelId: APP_ID });
    }
  } catch (e) { /* notifications may not show, everything else works */ }
}

async function boot() {
  loadPrefs();
  ensureStartMenuShortcut();
  Menu.setApplicationMenu(null);
  // the alert server keeps its data in the user's app-data folder, not next to the program
  server = require(path.join(ROOT, 'server.js'));
  const dataFile = path.join(app.getPath('userData'), 'server-state.json');
  for (const p of PORTS) {
    try { port = (await server.start({ port: p, host: '127.0.0.1', dataFile, quiet: true })).port; break; } catch (e) { if (e.code !== 'EADDRINUSE') { fail(e); return; } }
  }
  if (!port) { fail(new Error(`Ports ${PORTS[0]}–${PORTS[PORTS.length - 1]} are all in use by other programs.`)); return; }

  // fired alerts → Windows notifications (the server runs even when the window is hidden)
  server.events.on('fired', (ev) => notify(ev.message));
  ipcMain.on('candela:notify', (_e, msg) => notify(String(msg || '').slice(0, 500))); // alerts that run in the page itself
  ipcMain.on('candela:version', (e) => { e.returnValue = app.getVersion(); }); // for the "new version available" notice

  createTray();
  const hidden = process.argv.includes('--hidden'); // started with Windows: stay in the tray
  createWindow(!hidden);
}

function fail(e) {
  dialog.showErrorBox('Candela could not start', e.message || String(e));
  app.exit(1);
}

// ---------------------------------------------------------------- window
function createWindow(show) {
  const b = prefs.bounds || { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...b, minWidth: 720, minHeight: 480, show: false, title: 'Candela', backgroundColor: '#0F1218',
    icon: icon('icon-256.png'), autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, // keep live charts and in-page alerts running while hidden in the tray
    },
  });
  if (prefs.maximized) win.maximize();
  const appOrigin = `http://127.0.0.1:${port}`;
  win.loadURL(appOrigin + '/');
  win.once('ready-to-show', () => { if (show) win.show(); });

  // links to other sites (e.g. "Get a free Twelve Data key") open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(appOrigin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appOrigin)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  // F11 full screen, Ctrl+R reload, F12 developer tools (handy when writing scripts)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (input.control && input.key.toLowerCase() === 'r') { win.webContents.reload(); e.preventDefault(); }
  });

  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    prefs.maximized = win.isMaximized();
    if (!prefs.maximized) prefs.bounds = win.getBounds();
    savePrefs();
  };
  win.on('resize', remember);
  win.on('move', remember);

  // closing the window keeps Candela (and your alerts) running in the tray
  win.on('close', (e) => {
    if (quitting || !prefs.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!prefs.trayHintShown) {
      prefs.trayHintShown = true;
      savePrefs();
      notify('Candela is still running in the system tray, so your alerts keep working. Right-click the tray icon to quit.', 'Candela keeps running');
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- tray
function createTray() {
  const img = nativeImage.createFromPath(icon('tray-32.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Candela: charts and alerts');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTrayMenu();
}

// "Start with Windows" must point at the program you installed or downloaded; the portable version
// otherwise runs from a temporary copy that is deleted after each run.
const loginItem = () => ({ path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] });

function refreshTrayMenu() {
  const login = app.getLoginItemSettings(loginItem());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Candela', click: showWindow },
    { type: 'separator' },
    {
      label: 'Keep running when the window is closed', type: 'checkbox', checked: prefs.closeToTray,
      click: (item) => { prefs.closeToTray = item.checked; savePrefs(); },
    },
    {
      label: 'Start with Windows (in the tray)', type: 'checkbox', checked: !!login.openAtLogin,
      click: (item) => { app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }); refreshTrayMenu(); },
    },
    { type: 'separator' },
    { label: 'Quit Candela', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------- notifications
function notify(body, title = 'Candela alert') {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body.replace(/^🔔 /, ''), icon: icon('icon-256.png') });
  n.on('click', showWindow);
  n.show();
}

// ---------------------------------------------------------------- quitting
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (!server || stopping) return;
  // save alerts and close the server first. Electron ignores a second app.quit() once quitting has
  // begun, so exit directly when done (windows are already closed at this point).
  e.preventDefault();
  stopping = true;
  server.stop().finally(() => app.exit(0));
});
app.on('window-all-closed', () => { /* stay in the tray */ });
