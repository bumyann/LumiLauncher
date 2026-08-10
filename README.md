# LumiLauncher

A small Electron launcher for [Lumiverse](https://github.com/lumiverse) that replaces cryptic terminal errors with plain-English status messages.

![LumiLauncher screenshot](assets/screenshot.png)

## Features

- **One-click launch** — starts Lumiverse and auto-kills any leftover process on port 7860
- **Human-readable logs** — translates error codes into plain explanations with fix hints
- **Tray icon** — minimises to system tray so Lumiverse keeps running in the background
- **Update badge** — shows when Lumiverse has commits to pull
- **Settings** — point it at any Lumiverse installation path
- **Open in browser** button once Lumiverse is confirmed running

## Setup

### Requirements

- [Node.js](https://nodejs.org/) (v18+) and npm
- [Lumiverse](https://github.com/lumiverse) installed locally
- Windows (tested on Windows 11)

### Install & run

```bash
git clone https://github.com/bumyann/LumiLauncher
cd lumilauncher
npm install
npm start
```

### Build a distributable .exe

```bash
npm run build
```

The installer ends up in `dist/`. Share it with anyone who has Lumiverse installed.

### First run

> **Important:** If you haven't run Lumiverse before, open PowerShell and run `.\start.ps1` manually once first. This completes the first-time setup wizard (password, account creation, etc.) which requires interactive input that LumiLauncher can't handle. After that, you can use LumiLauncher for everything.

Once setup is done, open LumiLauncher and go to **⚙ Settings** to set the path to your Lumiverse folder (e.g. `C:\Users\you\Lumiverse`). It defaults to `C:\Users\ilyan\Lumiverse`.

## Error messages explained

| What you see | What it means |
|---|---|
| ⚠️ Port 7860 is already in use | A previous Lumiverse process didn't shut down. LumiLauncher will kill it and retry. |
| ❌ Couldn't kill PID — try running as administrator | Windows blocked the kill. Right-click LumiLauncher → Run as administrator. |
| ❌ Lumiverse folder not found | The path in Settings doesn't exist. Update it to match your install. |
| 💥 Lumiverse crashed | An extension or config error caused a runtime crash. Check recent extension changes. |
| 🔔 Update available — N commits behind | Pull latest from the Lumiverse repo. |

## License

MIT
