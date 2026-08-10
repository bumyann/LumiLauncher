const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const LUMIVERSE_PORT = 7860;
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const SETUP_DONE_PATH = path.join(app.getPath('userData'), 'setup_complete');

let mainWindow = null;
let tray = null;
let ptyProcess = null;   // node-pty instance (used in terminal/setup mode)
let isQuitting = false;
let isStopping = false;
let isRunning  = false;

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return { lumiversePath: 'C:\\Users\\ilyan\\Lumiverse', lumiverseBranch: 'staging' };
}

function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

function isSetupComplete() { return fs.existsSync(SETUP_DONE_PATH); }
function markSetupComplete() { fs.writeFileSync(SETUP_DONE_PATH, '1'); }

// ── Port utils ────────────────────────────────────────────────────────────────

function getPortPID(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { shell: 'cmd.exe', timeout: 5000 }).toString();
    const match = out.match(/\s+(\d+)\s*$/m);
    return match ? parseInt(match[1]) : null;
  } catch { return null; }
}

function killPID(pid) {
  try { execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe', timeout: 5000 }); return true; }
  catch { return false; }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, '127.0.0.1');
  });
}

// ── Log parser (for non-terminal mode) ───────────────────────────────────────

function parseLog(raw) {
  const line = raw.trim();
  const patterns = [
    { re: /EADDRINUSE|port.*in use|Failed to start server/i,
      level: 'error', msg: '⚠️ Port 7860 is already in use. Killing the old process and retrying...' },
    { re: /Server is running/i,
      level: 'success', msg: '✅ Lumiverse is up and running!' },
    { re: /Server crashed/i,
      level: 'error', msg: '💥 Lumiverse crashed. Check your config or extension files.' },
    { re: /Server exited with code 1/i,
      level: 'error', msg: '❌ Lumiverse failed to start (exit code 1). See details above.' },
    { re: /Update available: (\d+) commits behind/i,
      level: 'info', msg: (m) => `🔔 Lumiverse update available — ${m[1]} commits behind.` },
    { re: /Installing backend dependencies/i,
      level: 'info', msg: '📦 Installing backend dependencies...' },
    { re: /backend dependencies installed/i,
      level: 'info', msg: '📦 Dependencies ready.' },
    { re: /\[Spindle\] Starting (\d+) extension/i,
      level: 'info', msg: (m) => `🧩 Loading ${m[1]} extensions...` },
    { re: /\[Spindle\] Started extension: (.+)/i,
      level: 'info', msg: (m) => `  ✓ Extension loaded: ${m[1]}` },
    { re: /\[Spindle:(.+)\] .*error|failed/i,
      level: 'warn', msg: (m) => `⚠️ Extension issue: ${m[1]}` },
    { re: /\[db\] startup/i,         level: 'info', msg: '🗄️ Database loaded.' },
    { re: /Bun \d+\.\d+\.\d+ found/i,level: 'info', msg: '✓ Bun runtime found.' },
    { re: /Data directory:/i,         level: 'info', msg: '📁 Data directory verified.' },
    { re: /Disk hosting.*(\d+\.\d+)% used/i,
      level: (m) => parseFloat(m[1]) > 90 ? 'warn' : 'info',
      msg:   (m) => parseFloat(m[1]) > 90 ? `⚠️ Disk is ${m[1]}% full — Lumiverse may slow down.` : `💾 Disk usage: ${m[1]}%` },
    { re: /AUTH_SECRET derived/i,    level: 'info', msg: '🔑 Auth identity loaded.' },
    { re: /VAPID keys/i,             level: 'info', msg: '🔔 Push notification keys loaded.' },
    { re: /Pre-warmed: (.+)/i,       level: 'info', msg: (m) => `🔥 Tokenizer ready: ${m[1]}` },
  ];
  for (const p of patterns) {
    const m = line.match(p.re);
    if (m) {
      const level = typeof p.level === 'function' ? p.level(m) : p.level;
      const msg   = typeof p.msg   === 'function' ? p.msg(m)   : p.msg;
      return { level, msg, raw: line };
    }
  }
  return { level: 'raw', msg: line, raw: line };
}

// ── Terminal (PTY) mode — used for setup wizard + normal launching ─────────────

function spawnPty(lumiversePath) {
  let pty;
  try { pty = require('node-pty'); }
  catch {
    sendLog({ level: 'error', msg: '❌ node-pty not available. Run npm install and restart.', raw: '' });
    return null;
  }

  const shell = 'powershell.exe';
  const args  = ['-ExecutionPolicy', 'Bypass', '-File', path.join(lumiversePath, 'start.ps1')];

  const proc = pty.spawn(shell, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: lumiversePath,
    env: process.env,
  });

  proc.onData(data => {
    // forward raw terminal data to renderer
    sendTermData(data);

    // also parse for status updates
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      if (isStopping || isQuitting) continue;

      const parsed = parseLog(line);
      if (parsed.level === 'success') {
        isRunning = true;
        sendStatus('running');
        updateTray('running');
        if (!isSetupComplete()) {
          markSetupComplete();
          sendMode('launcher'); // switch to launcher UI after first successful run
        }
      }
      if (line.match(/Update available: (\d+) commits behind/i)) {
        const m = line.match(/Update available: (\d+) commits behind/i);
        sendUpdate({ type: 'lumiverse', status: 'available', commits: parseInt(m[1]) });
      }
      if (line.match(/EADDRINUSE/i)) handlePortInUse();
    }
  });

  proc.onExit(({ exitCode }) => {
    ptyProcess = null;
    isRunning = false;
    if (!isQuitting && !isStopping) {
      sendLog({ level: exitCode === 0 ? 'info' : 'error',
        msg: exitCode === 0 ? '⏹ Lumiverse stopped.' : `❌ Lumiverse exited unexpectedly (code ${exitCode}).`, raw: '' });
      sendStatus('stopped');
      updateTray('stopped');
    }
    isStopping = false;
  });

  return proc;
}

// ── Start / Stop / Restart ────────────────────────────────────────────────────

async function startLumiverse() {
  const cfg = loadConfig();
  const lumiversePath = cfg.lumiversePath;

  if (!fs.existsSync(lumiversePath)) {
    sendLog({ level: 'error', msg: `❌ Lumiverse folder not found at: ${lumiversePath} — go to Settings to fix this.`, raw: '' });
    sendStatus('error');
    return;
  }

  // first time? switch to terminal mode so setup wizard works
  if (!isSetupComplete()) {
    sendMode('terminal');
    sendStatus('starting');
    ptyProcess = spawnPty(lumiversePath);
    return;
  }

  // normal launch — check port first
  sendLog({ level: 'info', msg: '🔍 Checking port 7860...', raw: '' });
  const inUse = await isPortInUse(LUMIVERSE_PORT);
  if (inUse) {
    sendLog({ level: 'warn', msg: '⚠️ Port 7860 is occupied. Attempting to free it...', raw: '' });
    const pid = getPortPID(LUMIVERSE_PORT);
    if (pid) {
      const killed = killPID(pid);
      if (killed) {
        sendLog({ level: 'info', msg: `✓ Cleared old process (PID ${pid}). Starting fresh...`, raw: '' });
        await new Promise(r => setTimeout(r, 1500));
      } else {
        sendLog({ level: 'error', msg: `❌ Couldn't kill PID ${pid} — try running LumiLauncher as administrator.`, raw: '' });
        sendStatus('error');
        return;
      }
    }
  }

  sendStatus('starting');
  sendLog({ level: 'info', msg: '🚀 Starting Lumiverse...', raw: '' });
  ptyProcess = spawnPty(lumiversePath);
}

async function handlePortInUse() {
  const pid = getPortPID(LUMIVERSE_PORT);
  if (pid) { killPID(pid); sendLog({ level: 'info', msg: `✓ Freed port 7860 (killed PID ${pid}).`, raw: '' }); }
}

function stopLumiverse() {
  isStopping = true;
  if (ptyProcess) {
    sendLog({ level: 'info', msg: '⏹ Stopping Lumiverse...', raw: '' });
    try { ptyProcess.kill(); } catch {}
    ptyProcess = null;
  }
  const pid = getPortPID(LUMIVERSE_PORT);
  if (pid) killPID(pid);
  isRunning = false;
  sendStatus('stopped');
  updateTray('stopped');
  setTimeout(() => { isStopping = false; }, 2000);
}

async function restartLumiverse() {
  sendLog({ level: 'info', msg: '↺ Restarting Lumiverse...', raw: '' });
  isStopping = true;
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch {}
    ptyProcess = null;
  }
  const pid = getPortPID(LUMIVERSE_PORT);
  if (pid) killPID(pid);
  isRunning = false;
  sendStatus('stopped');
  await new Promise(r => setTimeout(r, 2000));
  isStopping = false;
  startLumiverse();
}

// ── Lumiverse git update ──────────────────────────────────────────────────────

function runGitCommand(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, shell: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `git exited ${code}`)));
  });
}

async function updateLumiverse(branch) {
  const cfg = loadConfig();
  const cwd = cfg.lumiversePath;
  if (!fs.existsSync(cwd)) { sendLog({ level: 'error', msg: `❌ Lumiverse path not found. Check Settings.`, raw: '' }); return; }
  sendLog({ level: 'info', msg: `📥 Updating Lumiverse on branch: ${branch}...`, raw: '' });
  sendUpdate({ type: 'lumiverse', status: 'updating' });
  try { await runGitCommand(['--version'], cwd); }
  catch {
    sendLog({ level: 'error', msg: `❌ Git not found. Install Git for Windows from git-scm.com and try again.`, raw: '' });
    sendUpdate({ type: 'lumiverse', status: 'error' }); return;
  }
  try {
    await runGitCommand(['fetch', 'origin'], cwd);
    sendLog({ level: 'info', msg: `✓ Fetched remote.`, raw: '' });
    const currentBranch = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (currentBranch !== branch) {
      sendLog({ level: 'info', msg: `↪ Switching from ${currentBranch} → ${branch}...`, raw: '' });
      await runGitCommand(['checkout', branch], cwd);
    }
    const pullOut = await runGitCommand(['pull', 'origin', branch], cwd);
    if (pullOut.includes('Already up to date')) {
      sendLog({ level: 'info', msg: `✓ Already up to date on ${branch}.`, raw: '' });
    } else {
      sendLog({ level: 'success', msg: `✅ Lumiverse updated to latest ${branch}! Restart Lumiverse to apply.`, raw: '' });
    }
    sendUpdate({ type: 'lumiverse', status: 'done' });
  } catch (e) {
    sendLog({ level: 'error', msg: `❌ Update failed: ${e.message}`, raw: '' });
    sendUpdate({ type: 'lumiverse', status: 'error' });
  }
}

// ── electron-updater ──────────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update',  ()     => sendUpdate({ type: 'launcher', status: 'checking' }));
  autoUpdater.on('update-available',     (info) => { sendLog({ level: 'info', msg: `🔔 LumiLauncher update available — v${info.version}. Downloading...`, raw: '' }); sendUpdate({ type: 'launcher', status: 'downloading', version: info.version }); });
  autoUpdater.on('update-not-available', ()     => sendUpdate({ type: 'launcher', status: 'up-to-date' }));
  autoUpdater.on('download-progress',    (p)    => sendUpdate({ type: 'launcher', status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded',    (info) => { sendLog({ level: 'success', msg: `✅ LumiLauncher v${info.version} downloaded. Restart to apply.`, raw: '' }); sendUpdate({ type: 'launcher', status: 'ready', version: info.version }); });
  autoUpdater.on('error', (err) => { if (app.isPackaged) { sendLog({ level: 'warn', msg: `⚠️ Launcher update check failed: ${err.message}`, raw: '' }); sendUpdate({ type: 'launcher', status: 'error' }); } });
}

function checkForLauncherUpdate() {
  if (app.isPackaged) { autoUpdater.checkForUpdates(); }
  else { sendUpdate({ type: 'launcher', status: 'up-to-date' }); }
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

function sendLog(entry)       { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', entry); }
function sendStatus(status)   { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', status); }
function sendUpdate(payload)  { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', payload); }
function sendTermData(data)   { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('term-data', data); }
function sendMode(mode)       { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mode', mode); }

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.on('start',                  ()          => startLumiverse());
ipcMain.on('stop',                   ()          => stopLumiverse());
ipcMain.on('restart',                ()          => restartLumiverse());
ipcMain.on('open-browser',           ()          => shell.openExternal(`http://localhost:${LUMIVERSE_PORT}`));
ipcMain.on('clear-logs',             ()          => { if (mainWindow) mainWindow.webContents.send('clear-logs'); });
ipcMain.handle('get-config',         ()          => loadConfig());
ipcMain.on('save-config',            (_, cfg)    => saveConfig(cfg));
ipcMain.handle('is-running',         ()          => isRunning);
ipcMain.handle('is-setup-complete',  ()          => isSetupComplete());
ipcMain.on('window-minimize',        ()          => mainWindow?.minimize());
ipcMain.on('window-hide',            ()          => mainWindow?.hide());
ipcMain.on('update-lumiverse',       (_, branch) => updateLumiverse(branch));
ipcMain.on('check-launcher-update',  ()          => checkForLauncherUpdate());
ipcMain.on('install-launcher-update',()          => autoUpdater.quitAndInstall(false, true));

// terminal input from xterm.js → pty
ipcMain.on('term-input', (_, data) => {
  if (ptyProcess) { try { ptyProcess.write(data); } catch {} }
});

// terminal resize
ipcMain.on('term-resize', (_, { cols, rows }) => {
  if (ptyProcess) { try { ptyProcess.resize(cols, rows); } catch {} }
});

// reset setup flag (for testing / re-running wizard)
ipcMain.on('reset-setup', () => {
  try { fs.unlinkSync(SETUP_DONE_PATH); } catch {}
  sendMode('terminal');
});

// ── Tray ──────────────────────────────────────────────────────────────────────

function updateTray(status) {
  if (!tray) return;
  const labels = { running: '● Lumiverse running', stopped: '○ Lumiverse stopped', error: '✕ Lumiverse error' };
  tray.setToolTip(`LumiLauncher — ${labels[status] || ''}`);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('LumiLauncher');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open LumiLauncher',        click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Open Lumiverse in Browser', click: () => shell.openExternal(`http://localhost:${LUMIVERSE_PORT}`) },
    { type: 'separator' },
    { label: 'Start Lumiverse',  click: () => startLumiverse() },
    { label: 'Stop Lumiverse',   click: () => stopLumiverse() },
    { type: 'separator' },
    { label: 'Quit LumiLauncher', click: () => { isQuitting = true; stopLumiverse(); app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680, height: 580,
    minWidth: 520, minHeight: 440,
    frame: false, transparent: false,
    backgroundColor: '#0d0d14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();
  setTimeout(() => checkForLauncherUpdate(), 5000);
});
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { isQuitting = true; stopLumiverse(); });
