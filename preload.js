const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumi', {
  start:                 ()        => ipcRenderer.send('start'),
  stop:                  ()        => ipcRenderer.send('stop'),
  restart:               ()        => ipcRenderer.send('restart'),
  openBrowser:           ()        => ipcRenderer.send('open-browser'),
  clearLogs:             ()        => ipcRenderer.send('clear-logs'),
  getConfig:             ()        => ipcRenderer.invoke('get-config'),
  saveConfig:            (cfg)     => ipcRenderer.send('save-config', cfg),
  isRunning:             ()        => ipcRenderer.invoke('is-running'),
  isSetupComplete:       ()        => ipcRenderer.invoke('is-setup-complete'),
  updateLumiverse:       (branch)  => ipcRenderer.send('update-lumiverse', branch),
  checkLauncherUpdate:   ()        => ipcRenderer.send('check-launcher-update'),
  installLauncherUpdate: ()        => ipcRenderer.send('install-launcher-update'),
  resetSetup:            ()        => ipcRenderer.send('reset-setup'),
  minimize:              ()        => ipcRenderer.send('window-minimize'),
  hide:                  ()        => ipcRenderer.send('window-hide'),

  // terminal
  termInput:  (data)         => ipcRenderer.send('term-input', data),
  termResize: (cols, rows)   => ipcRenderer.send('term-resize', { cols, rows }),

  onLog:          (cb) => ipcRenderer.on('log',           (_, d) => cb(d)),
  onStatus:       (cb) => ipcRenderer.on('status',        (_, d) => cb(d)),
  onClearLogs:    (cb) => ipcRenderer.on('clear-logs',    ()     => cb()),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, d) => cb(d)),
  onTermData:     (cb) => ipcRenderer.on('term-data',     (_, d) => cb(d)),
  onMode:         (cb) => ipcRenderer.on('mode',          (_, d) => cb(d)),
});
