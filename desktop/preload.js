/* The only thing the page can ask of the desktop app: show a Windows notification. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('candelaDesktop', {
  notify: (message) => ipcRenderer.send('candela:notify', String(message)),
});
