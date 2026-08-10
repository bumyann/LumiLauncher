# LumiLauncher

A launcher for [Lumiverse](https://lumiverse.chat) because I'm a lazy bastard that hates even the smallest inconvenience, and opening PowerShell every time is not it.

Double-click, it starts. That's the pitch.

---

## What It Does

- Starts and stops Lumiverse without touching a terminal
- Kills leftover port conflicts automatically so you don't have to
- Tells you what went wrong in plain English instead of exit codes
- Has a built-in terminal for first-time setup (passwords, account creation, etc.)
- Pulls Lumiverse updates from inside the app (main or staging branch)
- Updates itself silently in the background
- Lives in the system tray so you can close the window without killing Lumiverse

---

## Download

Grab the installer for your platform from the [Releases](https://github.com/bumyann/LumiLauncher/releases) page.

| Platform | File |
|---|---|
| Windows | `LumiLauncher-Setup-x.x.x.exe` |
| macOS | `LumiLauncher-x.x.x.dmg` |
| Linux | `LumiLauncher-x.x.x.AppImage` |

---

## Requirements

- [Lumiverse](https://lumiverse.chat/guides/getting-started/installation/) already installed on your machine
- [Git](https://git-scm.com/downloads) if you want to use the in-app Lumiverse update feature

---

## First-Time Setup

If you've never run Lumiverse before, click Launch and it'll automatically open a terminal tab where you can go through the setup wizard — type your password, create your account, all that. After that it won't bother you again.

If Lumiverse is already set up, it just starts normally.

---

## First Launch Checklist

1. Install LumiLauncher for your platform
2. Open LumiLauncher
3. Go to **⚙ Settings** → set your Lumiverse folder path (e.g. `C:\Users\you\Lumiverse`)
4. Click Launch

---

## Error Messages

| What You See | What It Means |
|---|---|
| ⚠️ Port 7860 is already in use | Leftover process from a previous run. LumiLauncher kills it and retries automatically. |
| ❌ Couldn't kill PID — try running as administrator | Windows said no. Right-click LumiLauncher → Run as administrator. |
| ❌ Lumiverse folder not found | The path in Settings is wrong. Fix it. |
| 💥 Lumiverse crashed | Something in your config or extensions broke. Check what you changed recently. |
| 🔔 Update available — N commits behind | Go to the Updates tab and pull. |
| ❌ Git not found | Install [Git](https://git-scm.com/downloads). |

---

## Note

Lumiverse already has an [official desktop tray companion](https://lumiverse.chat/guides/getting-started/desktop-tray/) — but it requires Rust, C++ build tools, and compiling from source. LumiLauncher is for people who just want an installer file.

---

## License

MIT 
