'use strict';
/**
 * Preload: the only bridge between the sandboxed renderer and main. Exposes a
 * narrow, typed-ish API over contextBridge - no direct ipcRenderer, no Node.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    setSection: (key, value) => ipcRenderer.invoke('settings:setSection', { key, value }),
    loadTexts: (json) => ipcRenderer.invoke('settings:loadTexts', json),
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    stats: () => ipcRenderer.invoke('profiles:stats'),
    create: (label) => ipcRenderer.invoke('profiles:create', { label }),
    remove: (id) => ipcRenderer.invoke('profiles:remove', { id }),
    launch: (id, openGmail) => ipcRenderer.invoke('profiles:launch', { id, openGmail }),
    stop: (id) => ipcRenderer.invoke('profiles:stop', { id }),
    scan: (id) => ipcRenderer.invoke('profiles:scan', { id }),
  },
  run: {
    start: () => ipcRenderer.invoke('run:start'),
    stop: () => ipcRenderer.invoke('run:stop'),
    status: () => ipcRenderer.invoke('run:status'),
    testLead: (email) => ipcRenderer.invoke('run:testLead', { email }),
  },
  logs: {
    recent: (n) => ipcRenderer.invoke('logs:recent', n),
    onEntry: (cb) => {
      const handler = (_e, entry) => cb(entry);
      ipcRenderer.on('log:entry', handler);
      return () => ipcRenderer.removeListener('log:entry', handler);
    },
  },
  telegram: {
    test: (botToken) => ipcRenderer.invoke('telegram:test', { botToken }),
  },
  gmail: {
    testSend: (id, payload) => ipcRenderer.invoke('gmail:testSend', { id, ...payload }),
    dryRun: (id) => ipcRenderer.invoke('gmail:dryRun', { id }),
  },
  contacts: {
    list: () => ipcRenderer.invoke('contacts:list'),
    nudge: (email) => ipcRenderer.invoke('contacts:nudge', { email }),
  },
  cdp: {
    detectChrome: () => ipcRenderer.invoke('cdp:detectChrome'),
  },
});
