/* What the page can ask of the desktop app: show a Windows notification, and which version it is. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('candelaDesktop', {
  notify: (message) => ipcRenderer.send('candela:notify', String(message)),
  version: String(ipcRenderer.sendSync('candela:version') || ''),
});
