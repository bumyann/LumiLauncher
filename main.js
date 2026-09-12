const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const http = require('http');
const https = require('https');
const os = require('os');
const { WebSocketServer } = require('ws');
const { autoUpdater } = require('electron-updater');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const LUMIVERSE_PORT   = 7860;
const BANANABREAD_PORT = 8008;
const CONFIG_PATH      = path.join(app.getPath('userData'), 'config.json');
const SETUP_DONE_PATH  = path.join(app.getPath('userData'), 'setup_complete');

let mainWindow      = null;
let remoteServer    = null;
let wss             = null;
let remotePort      = 7861;
let remoteClients   = new Set();
let tray            = null;
let ptyProcess      = null;
let bbProcess       = null;   // BananaBread child process
let isQuitting      = false;
let isStopping      = false;
let isBBStopping    = false;
let isRunning       = false;
let isBBRunning     = false;

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return {
    lumiversePath:    '',
    lumiverseBranch:  'staging',
    bananabreadPath:  '',
    bananabreadEnabled: false,
    autoRestart: false,
    remoteEnabled: false,
  };
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

// ── Log parser ────────────────────────────────────────────────────────────────

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
    { re: /\[db\] startup/i,          level: 'info', msg: '🗄️ Database loaded.' },
    { re: /Bun \d+\.\d+\.\d+ found/i, level: 'info', msg: '✓ Bun runtime found.' },
    { re: /Data directory:/i,          level: 'info', msg: '📁 Data directory verified.' },
    { re: /Disk hosting.*(\d+\.\d+)% used/i,
      level: (m) => parseFloat(m[1]) > 90 ? 'warn' : 'info',
      msg:   (m) => parseFloat(m[1]) > 90 ? `⚠️ Disk is ${m[1]}% full — Lumiverse may slow down.` : `💾 Disk usage: ${m[1]}%` },
    { re: /AUTH_SECRET derived/i, level: 'info', msg: '🔑 Auth identity loaded.' },
    { re: /VAPID keys/i,          level: 'info', msg: '🔔 Push notification keys loaded.' },
    { re: /Pre-warmed: (.+)/i,    level: 'info', msg: (m) => `🔥 Tokenizer ready: ${m[1]}` },
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

function parseBBLog(raw) {
  const line = raw.trim();
  const patterns = [
    { re: /uvicorn.*running|application startup complete|started server/i,
      level: 'success', msg: '✅ BananaBread is up on port 8008.' },
    { re: /downloading|fetching model/i,
      level: 'info', msg: '📥 [BB] Downloading model — this may take a while on first run...' },
    { re: /model loaded|loaded.*model/i,
      level: 'info', msg: '🧠 [BB] Model loaded.' },
    { re: /warmup/i,
      level: 'info', msg: '🔥 [BB] Running warmup inference...' },
    { re: /error|exception|traceback/i,
      level: 'error', msg: `❌ [BB] ${line}` },
    { re: /warning/i,
      level: 'warn', msg: `⚠️ [BB] ${line}` },
  ];
  for (const p of patterns) {
    const m = line.match(p.re);
    if (m) {
      const level = typeof p.level === 'function' ? p.level(m) : p.level;
      const msg   = typeof p.msg   === 'function' ? p.msg(m)   : p.msg;
      return { level, msg, raw: line };
    }
  }
  return { level: 'raw', msg: `[BB] ${line}`, raw: line };
}

// ── uv check ─────────────────────────────────────────────────────────────────

function isUvAvailable() {
  try { execSync('uv --version', { shell: true, timeout: 5000 }); return true; }
  catch { return false; }
}

// ── Terminal (PTY) mode ───────────────────────────────────────────────────────

function spawnPty(lumiversePath) {
  let pty;
  try { pty = require('node-pty'); }
  catch {
    sendLog({ level: 'error', msg: '❌ node-pty not available. Run npm install and restart.', raw: '' });
    return null;
  }

  const proc = pty.spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(lumiversePath, 'start.ps1')
  ], { name: 'xterm-color', cols: 80, rows: 24, cwd: lumiversePath, env: process.env });

  proc.onData(data => {
    sendTermData(data);
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim() || isStopping || isQuitting) continue;
      const parsed = parseLog(line);
      if (parsed.level === 'success') {
        isRunning = true;
        sendStatus('running');
        updateTray('running');
        if (!isSetupComplete()) { markSetupComplete(); sendMode('launcher'); }
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
      const cfg = loadConfig();
      if (exitCode !== 0 && cfg.autoRestart) {
        sendLog({ level: 'warn', msg: `⚠️ Lumiverse crashed (code ${exitCode}). Auto-restarting in 5 seconds...`, raw: '' });
        sendStatus('starting');
        setTimeout(() => { if (!isQuitting) startLumiverse(); }, 5000);
      } else {
        sendLog({ level: exitCode === 0 ? 'info' : 'error',
          msg: exitCode === 0 ? '⏹ Lumiverse stopped.' : `❌ Lumiverse exited unexpectedly (code ${exitCode}).`, raw: '' });
        sendStatus('stopped');
        updateTray('stopped');
      }
    }
    isStopping = false;
  });

  return proc;
}

// ── BananaBread ───────────────────────────────────────────────────────────────

async function startBananaBread() {
  const cfg = loadConfig();
  if (!cfg.bananabreadEnabled) return;

  const bbPath = cfg.bananabreadPath;
  if (!bbPath || !fs.existsSync(bbPath)) {
    sendLog({ level: 'error', msg: `❌ [BB] BananaBread folder not found at: ${bbPath} — update the path in Settings.`, raw: '' });
    sendBBStatus('error');
    return;
  }

  if (!isUvAvailable()) {
    sendLog({ level: 'error', msg: `❌ [BB] uv is not installed. BananaBread requires uv to run. Install it from https://docs.astral.sh/uv/getting-started/installation/ then restart.`, raw: '' });
    sendBBStatus('error');
    return;
  }

  const inUse = await isPortInUse(BANANABREAD_PORT);
  if (inUse) {
    sendLog({ level: 'warn', msg: `⚠️ [BB] Port 8008 is occupied. Attempting to free it...`, raw: '' });
    const pid = getPortPID(BANANABREAD_PORT);
    if (pid) {
      killPID(pid);
      sendLog({ level: 'info', msg: `✓ [BB] Cleared old process (PID ${pid}).`, raw: '' });
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  sendLog({ level: 'info', msg: `🍌 Starting BananaBread...`, raw: '' });
  sendBBStatus('starting');

  bbProcess = spawn('uv', ['run', 'bananabread-emb'], {
    cwd: bbPath,
    shell: true,
    env: process.env,
  });

  const handleData = (data) => {
    const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
    for (const line of lines) {
      if (isBBStopping || isQuitting) continue;
      const parsed = parseBBLog(line);
      sendLog(parsed);
      if (parsed.level === 'success') { isBBRunning = true; sendBBStatus('running'); }
      if (parsed.level === 'error')   { sendBBStatus('error'); }
    }
  };

  bbProcess.stdout.on('data', handleData);
  bbProcess.stderr.on('data', handleData);

  bbProcess.on('close', (code) => {
    bbProcess = null;
    isBBRunning = false;
    if (!isQuitting && !isBBStopping) {
      sendLog({ level: code === 0 ? 'info' : 'error',
        msg: code === 0 ? '⏹ BananaBread stopped.' : `❌ BananaBread exited unexpectedly (code ${code}).`, raw: '' });
      sendBBStatus('stopped');
    }
    isBBStopping = false;
  });
}

function stopBananaBread() {
  isBBStopping = true;
  if (bbProcess) {
    sendLog({ level: 'info', msg: '⏹ Stopping BananaBread...', raw: '' });
    try { bbProcess.kill(); } catch {}
    bbProcess = null;
  }
  const pid = getPortPID(BANANABREAD_PORT);
  if (pid) killPID(pid);
  isBBRunning = false;
  sendBBStatus('stopped');
  setTimeout(() => { isBBStopping = false; }, 2000);
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

  // start BananaBread first if enabled (non-blocking)
  if (cfg.bananabreadEnabled) startBananaBread();

  if (!isSetupComplete()) {
    sendMode('terminal');
    sendStatus('starting');
    ptyProcess = spawnPty(lumiversePath);
    return;
  }

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
  if (bbProcess) stopBananaBread();
  setTimeout(() => { isStopping = false; }, 2000);
}

async function restartLumiverse() {
  sendLog({ level: 'info', msg: '↺ Restarting Lumiverse...', raw: '' });
  isStopping = true;
  if (ptyProcess) { try { ptyProcess.kill(); } catch {} ptyProcess = null; }
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
    sendLog({ level: 'error', msg: `❌ Git not found. Install Git from git-scm.com and try again.`, raw: '' });
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
      sendLog({ level: 'success', msg: `✅ Lumiverse updated to latest ${branch}! Restart to apply.`, raw: '' });
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

// ── Remote dashboard ─────────────────────────────────────────────────────────

const MOBILE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>LumiLauncher Remote</title>
<style>
  :root {
    --bg: #0d0d14; --bg2: #13131f; --bg3: #1a1a2e;
    --border: #2a2a45; --accent: #9896bb; --accent2: #5d6da5; --accent3: #344979;
    --pink: #c084b0; --text: #d4d4e8; --text-dim: #7070a0; --text-mute: #404060;
    --success: #7bbf8a; --warn: #c9a96e; --error: #c97070; --info: #7aa8d0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 16px; }
  h1 { font-size: 18px; color: var(--accent); margin-bottom: 4px; }
  .subtitle { font-size: 12px; color: var(--text-mute); margin-bottom: 16px; }
  .status-bar { display: flex; align-items: center; gap: 8px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text-mute); flex-shrink: 0; transition: background .3s; }
  .dot.running { background: var(--success); box-shadow: 0 0 6px var(--success); }
  .dot.starting { background: var(--warn); animation: pulse 1s infinite; }
  .dot.error { background: var(--error); }
  @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }
  .status-label { font-size: 13px; color: var(--text-dim); flex: 1; }
  .ws-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--error); }
  .ws-dot.connected { background: var(--success); }
  .ws-label { font-size: 10px; color: var(--text-mute); }
  .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
  .btn { padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); font-size: 14px; font-weight: 500; cursor: pointer; text-align: center; transition: all .15s; -webkit-tap-highlight-color: transparent; }
  .btn:active { transform: scale(.96); }
  .btn.primary { background: var(--accent3); border-color: var(--accent2); color: #fff; }
  .btn.danger { border-color: #5a3a3a; color: var(--error); }
  .btn.full { grid-column: 1 / -1; }
  .btn:disabled { opacity: .35; pointer-events: none; }
  .log-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .log-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-mute); font-weight: 600; }
  .clear-btn { font-size: 10px; padding: 2px 8px; background: none; border: 1px solid var(--border); color: var(--text-mute); border-radius: 3px; cursor: pointer; }
  #log { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; height: 280px; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.6; display: flex; flex-direction: column; gap: 1px; }
  .log-line { display: flex; gap: 6px; }
  .log-time { color: var(--text-mute); flex-shrink: 0; }
  .log-msg { flex: 1; word-break: break-word; }
  .log-line.success .log-msg { color: var(--success); }
  .log-line.error .log-msg { color: var(--error); }
  .log-line.warn .log-msg { color: var(--warn); }
  .log-line.info .log-msg { color: var(--info); }
  .log-line.raw .log-msg { color: var(--text-mute); }
  .section { margin-bottom: 12px; }
</style>
</head>
<body>
<h1>🌙 LumiLauncher</h1>
<p class="subtitle">Remote Control</p>

<div class="section">
  <div class="status-bar">
    <div class="dot" id="lumi-dot"></div>
    <span class="status-label" id="lumi-status">Connecting...</span>
    <div class="ws-dot" id="ws-dot"></div>
    <span class="ws-label" id="ws-label">ws</span>
  </div>
</div>

<div class="controls section">
  <button class="btn primary" id="btn-start" onclick="send('start')">▶ Launch</button>
  <button class="btn danger"  id="btn-stop"  onclick="send('stop')">■ Stop</button>
  <button class="btn full"    id="btn-restart" onclick="send('restart')">↺ Restart</button>
  <button class="btn full"    id="btn-browser" onclick="openLumi()">↗ Open Lumiverse in Browser</button>
</div>

<div class="log-header">
  <span class="log-label">Live Log</span>
  <button class="clear-btn" onclick="clearLog()">clear</button>
</div>
<div id="log"></div>

<script>
  const logEl = document.getElementById('log');
  const lumiDot = document.getElementById('lumi-dot');
  const lumiStatus = document.getElementById('lumi-status');
  const wsDot = document.getElementById('ws-dot');
  const wsLabel = document.getElementById('ws-label');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnRestart = document.getElementById('btn-restart');

  const STATUS_LABELS = {
    stopped: 'Lumiverse is not running.',
    starting: 'Starting Lumiverse...',
    running: 'Lumiverse is running.',
    error: 'Something went wrong.',
  };

  let ws;
  function connect() {
    ws = new WebSocket('ws://' + location.host);
    ws.onopen = () => { wsDot.className = 'ws-dot connected'; wsLabel.textContent = 'live'; };
    ws.onclose = () => { wsDot.className = 'ws-dot'; wsLabel.textContent = 'disconnected'; setTimeout(connect, 3000); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') setStatus(msg.data);
      if (msg.type === 'log') addLog(msg.data);
      if (msg.type === 'init') { setStatus(msg.status); msg.logs.forEach(addLog); }
    };
  }
  connect();

  function send(action) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action })); }
  function openLumi() { window.open('http://' + location.hostname + ':7860', '_blank'); }
  function clearLog() { logEl.innerHTML = ''; }

  function setStatus(s) {
    lumiDot.className = 'dot ' + s;
    lumiStatus.textContent = STATUS_LABELS[s] || s;
    btnStart.disabled   = s === 'starting' || s === 'running';
    btnStop.disabled    = s === 'stopped'  || s === 'error';
    btnRestart.disabled = s === 'stopped'  || s === 'error' || s === 'starting';
  }

  function addLog(entry) {
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');
    const line = document.createElement('div');
    line.className = 'log-line ' + entry.level;
    line.innerHTML = '<span class="log-time">' + ts + '</span><span class="log-msg">' + esc(entry.msg) + '</span>';
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  setStatus('stopped');
</script>
</body>
</html>`;

let recentLogs = [];

function broadcastToRemote(msg) {
  const data = JSON.stringify(msg);
  for (const client of remoteClients) {
    try { if (client.readyState === 1) client.send(data); } catch {}
  }
}

function startRemoteServer() {
  const cfg = loadConfig();
  if (!cfg.remoteEnabled) return;

  remoteServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(MOBILE_HTML);
  });

  wss = new WebSocketServer({ server: remoteServer });

  wss.on('connection', (ws) => {
    remoteClients.add(ws);
    // send current state + recent logs
    ws.send(JSON.stringify({ type: 'init', status: isRunning ? 'running' : 'stopped', logs: recentLogs.slice(-50) }));

    ws.on('message', (raw) => {
      try {
        const { action } = JSON.parse(raw.toString());
        if (action === 'start')   startLumiverse();
        if (action === 'stop')    stopLumiverse();
        if (action === 'restart') restartLumiverse();
      } catch {}
    });

    ws.on('close', () => remoteClients.delete(ws));
    ws.on('error', () => remoteClients.delete(ws));
  });

  remoteServer.listen(remotePort, '0.0.0.0', () => {
    sendLog({ level: 'info', msg: `📱 Remote dashboard available at http://YOUR-TAILSCALE-IP:${remotePort}`, raw: '' });
  });
}

function stopRemoteServer() {
  for (const client of remoteClients) { try { client.close(); } catch {} }
  remoteClients.clear();
  if (wss) { wss.close(); wss = null; }
  if (remoteServer) { remoteServer.close(); remoteServer = null; }
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

function sendLog(entry) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', entry);
  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs.shift();
  broadcastToRemote({ type: 'log', data: entry });
}
function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', status);
  broadcastToRemote({ type: 'status', data: status });
}
function sendBBStatus(status){ if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bb-status', status); }
function sendUpdate(payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', payload); }
function sendTermData(data)  { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('term-data', data); }
function sendMode(mode)      { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mode', mode); }

// ── IPC handlers ──────────────────────────────────────────────────────────────

// ── Version management ───────────────────────────────────────────────────────

function fetchGithubReleases() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/bumyann/LumiLauncher/releases',
      headers: { 'User-Agent': 'LumiLauncher' },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse releases')); }
      });
    }).on('error', reject);
  });
}

async function downloadAndInstallVersion(version, assetUrl) {
  const ext      = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.AppImage';
  const tmpPath  = path.join(os.tmpdir(), `LumiLauncher-${version}${ext}`);

  sendLog({ level: 'info', msg: `📥 Downloading LumiLauncher v${version}...`, raw: '' });
  sendUpdate({ type: 'downgrade', status: 'downloading', version });

  await new Promise((resolve, reject) => {
    const file = require('fs').createWriteStream(tmpPath);
    https.get(assetUrl, { headers: { 'User-Agent': 'LumiLauncher' } }, (res) => {
      // follow redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, { headers: { 'User-Agent': 'LumiLauncher' } }, (res2) => {
          res2.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      } else {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }
    }).on('error', reject);
  });

  sendLog({ level: 'success', msg: `✅ Downloaded v${version}. Launching installer...`, raw: '' });
  sendUpdate({ type: 'downgrade', status: 'installing', version });

  if (process.platform === 'win32') {
    spawn(tmpPath, [], { detached: true, shell: true });
  } else if (process.platform === 'darwin') {
    spawn('open', [tmpPath], { detached: true });
  } else {
    spawn('chmod', ['+x', tmpPath], { shell: true }).on('close', () => {
      spawn(tmpPath, [], { detached: true, shell: true });
    });
  }

  setTimeout(() => { isQuitting = true; stopLumiverse(); stopBananaBread(); stopRemoteServer(); app.quit(); }, 2000);
}

ipcMain.handle('fetch-releases', async () => {
  try {
    const releases = await fetchGithubReleases();
    const current = app.getVersion();
    return releases
      .filter(r => !r.draft && !r.prerelease)
      .map(r => ({
        version: r.tag_name.replace(/^v/, ''),
        tag: r.tag_name,
        name: r.name,
        date: r.published_at,
        isCurrent: r.tag_name.replace(/^v/, '') === current,
        assets: r.assets.map(a => ({ name: a.name, url: a.browser_download_url })),
      }));
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.on('install-version', (_, { version, assetUrl }) => {
  downloadAndInstallVersion(version, assetUrl);
});

ipcMain.on('start',                   ()          => startLumiverse());
ipcMain.on('stop',                    ()          => stopLumiverse());
ipcMain.on('restart',                 ()          => restartLumiverse());
ipcMain.on('start-bb',                ()          => startBananaBread());
ipcMain.on('stop-bb',                 ()          => stopBananaBread());
ipcMain.on('open-browser',            ()          => shell.openExternal(`http://localhost:${LUMIVERSE_PORT}`));
ipcMain.on('open-bb-browser',         ()          => shell.openExternal(`http://localhost:${BANANABREAD_PORT}/docs`));
ipcMain.on('clear-logs',              ()          => { if (mainWindow) mainWindow.webContents.send('clear-logs'); });
ipcMain.handle('get-config',          ()          => loadConfig());
ipcMain.on('save-config',             (_, cfg)    => saveConfig(cfg));
ipcMain.handle('is-running',          ()          => isRunning);
ipcMain.handle('is-bb-running',       ()          => isBBRunning);
ipcMain.handle('is-setup-complete',   ()          => isSetupComplete());
ipcMain.on('window-minimize',         ()          => mainWindow?.minimize());
ipcMain.on('window-hide',             ()          => mainWindow?.hide());
ipcMain.on('update-lumiverse',        (_, branch) => updateLumiverse(branch));
ipcMain.on('check-launcher-update',   ()          => checkForLauncherUpdate());
ipcMain.on('install-launcher-update', ()          => autoUpdater.quitAndInstall(false, true));
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.on('start-remote',  () => startRemoteServer());
ipcMain.on('stop-remote',   () => stopRemoteServer());
ipcMain.on('term-input',  (_, data)         => { if (ptyProcess) { try { ptyProcess.write(data); } catch {} } });
ipcMain.on('term-resize', (_, { cols, rows })=> { if (ptyProcess) { try { ptyProcess.resize(cols, rows); } catch {} } });
ipcMain.on('reset-setup', () => { try { fs.unlinkSync(SETUP_DONE_PATH); } catch {} sendMode('terminal'); });

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
    { label: 'Open BananaBread Docs',     click: () => shell.openExternal(`http://localhost:${BANANABREAD_PORT}/docs`) },
    { type: 'separator' },
    { label: 'Start Lumiverse',  click: () => startLumiverse() },
    { label: 'Stop Lumiverse',   click: () => stopLumiverse() },
    { type: 'separator' },
    { label: 'Quit LumiLauncher', click: () => { isQuitting = true; stopLumiverse(); stopBananaBread(); app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680, height: 620,
    minWidth: 520, minHeight: 480,
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
  app.setAppUserModelId('com.bumyann.lumilauncher');
  createWindow();
  createTray();
  setupAutoUpdater();
  setTimeout(() => checkForLauncherUpdate(), 5000);
  const _cfg = loadConfig();
  if (_cfg.remoteEnabled) startRemoteServer();
});
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { isQuitting = true; stopLumiverse(); stopBananaBread(); stopRemoteServer(); });
