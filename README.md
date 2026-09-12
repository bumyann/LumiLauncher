# LumiLauncher

A simple launcher for [Lumiverse](https://lumiverse.chat) — no terminal required.

Instead of opening PowerShell every time, just double-click LumiLauncher. It handles starting, stopping, and updating Lumiverse for you, and shows plain-English messages instead of raw error codes.

---

## Download

Grab the latest `.exe` installer from the [Releases](https://github.com/bumyann/LumiLauncher/releases) page. Install it, open it, done.

---

## Requirements

- Windows 10 or 11
- [Lumiverse](https://lumiverse.chat/guides/getting-started/installation/) already cloned/installed on your machine
- [Git for Windows](https://git-scm.com/download/win) — only needed if you want to pull Lumiverse updates from inside the launcher

---

## First-time setup

If you've never run Lumiverse before, LumiLauncher will automatically open a terminal tab when you click Launch. Just follow the prompts — type your password, create your account, and let it finish. After that, every launch is one click.

If Lumiverse is already set up, it'll just start normally.

---

## Features

- **One-click launch** — starts Lumiverse and clears port conflicts automatically
- **Human-readable errors** — tells you what went wrong and how to fix it, in plain English
- **Built-in terminal** — handles first-time setup wizard, passwords, and interactive prompts
- **Lumiverse updates** — pull the latest commits (main or staging branch) from the Updates tab
- **Auto-updating** — the launcher updates itself silently in the background
- **System tray** — minimise to tray to keep Lumiverse running without a window open
- **Open in browser** button once Lumiverse is running

---

## First launch

1. Install LumiLauncher from the `.exe` installer
2. Open it and go to **⚙ Settings**
3. Set your Lumiverse folder path (e.g. `C:\Users\you\Lumiverse`)
4. Click **Launch**

---

## Error messages explained

| What you see | What it means |
|---|---|
| ⚠️ Port 7860 is already in use | A previous Lumiverse process didn't shut down cleanly. LumiLauncher will kill it and retry automatically. |
| ❌ Couldn't kill PID — try running as administrator | Windows blocked the process kill. Right-click LumiLauncher → Run as administrator. |
| ❌ Lumiverse folder not found | The path in Settings doesn't exist. Update it to match your install location. |
| 💥 Lumiverse crashed | An extension or config error caused a crash. Check any extensions you recently changed. |
| 🔔 Update available — N commits behind | There's a Lumiverse update ready. Go to the Updates tab to pull it. |
| ❌ Git not found | Install [Git for Windows](https://git-scm.com/download/win) to use the update feature. |

---

## License

MIT — made by [bumyann](https://github.com/bumyann)
