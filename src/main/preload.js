'use strict';
/**
 * Preload: the only bridge between the sandboxed renderer and main. Exposes a
 * narrow, typed-ish API over contextBridge - no direct ipcRenderer, no Node.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onState: (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('window:state', handler);
      return () => ipcRenderer.removeListener('window:state', handler);
    },
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    defaults: () => ipcRenderer.invoke('settings:defaults'),
    setSection: (key, value) => ipcRenderer.invoke('settings:setSection', { key, value }),
    loadTexts: (json) => ipcRenderer.invoke('settings:loadTexts', json),
    exportFile: (withSecrets) => ipcRenderer.invoke('settings:export', { withSecrets }),
    importFile: () => ipcRenderer.invoke('settings:import'),
    openDataDir: () => ipcRenderer.invoke('settings:openDataDir'),
  },
  appearance: {
    get: () => ipcRenderer.invoke('appearance:get'),
    set: (patch) => ipcRenderer.invoke('appearance:set', patch),
    pick: () => ipcRenderer.invoke('appearance:pick'),
    clear: () => ipcRenderer.invoke('appearance:clear'),
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    stats: () => ipcRenderer.invoke('profiles:stats'),
    metrics: () => ipcRenderer.invoke('profiles:metrics'),
    create: (label) => ipcRenderer.invoke('profiles:create', { label }),
    remove: (id) => ipcRenderer.invoke('profiles:remove', { id }),
    launch: (id, openGmail) => ipcRenderer.invoke('profiles:launch', { id, openGmail }),
    stop: (id) => ipcRenderer.invoke('profiles:stop', { id }),
    scan: (id) => ipcRenderer.invoke('profiles:scan', { id }),
  },
  run: {
    start: () => ipcRenderer.invoke('run:start'),
    stop: () => ipcRenderer.invoke('run:stop'),
    pause: () => ipcRenderer.invoke('run:pause'),
    resume: () => ipcRenderer.invoke('run:resume'),
    status: () => ipcRenderer.invoke('run:status'),
    // Название и цену обработчик принимает и кладёт в ссылку Haron, поэтому
    // передаём их дальше, а не теряем на мосту.
    testLead: (email, title, price) => ipcRenderer.invoke('run:testLead', { email, title, price }),
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
  texts: {
    openFile: () => ipcRenderer.invoke('texts:openFile'),
    saveFile: (content) => ipcRenderer.invoke('texts:saveFile', content),
  },
  autoReply: {
    defaultHtml: () => ipcRenderer.invoke('autoreply:defaultHtml'),
    preview: (html) => ipcRenderer.invoke('autoreply:preview', { html }),
  },
  stats: {
    overview: (days) => ipcRenderer.invoke('stats:overview', days),
  },
  dialogs: {
    list: () => ipcRenderer.invoke('dialogs:list'),
  },
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    messages: (chatKey) => ipcRenderer.invoke('chats:messages', { chatKey }),
  },
  contacts: {
    list: () => ipcRenderer.invoke('contacts:list'),
    nudge: (email) => ipcRenderer.invoke('contacts:nudge', { email }),
  },
  cdp: {
    detectChrome: () => ipcRenderer.invoke('cdp:detectChrome'),
  },
});
