<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="Duet icon" />
</p>

<h1 align="center">Duet</h1>

<p align="center"><b>Claude Code and Codex in one window.</b><br/>Start with either agent, switch mid-thread, and the other one picks up exactly where the first left off.</p>

<p align="center">
  <img src="docs/screenshots/switch.png" alt="Switching from Claude to Codex in the same thread" width="860" />
</p>

Duet is a native-feeling macOS desktop app (Electron/Chromium) that drives the **Claude Code** and **OpenAI Codex** command-line agents already installed on your Mac, with your own subscriptions. It talks to each one through its official streaming protocol — Claude Code's `stream-json` control protocol and Codex's `app-server` JSON-RPC — so you get live streaming, tool calls, diffs and approvals from both, in one consistent UI.

## Features

**Two agents, one thread**
- Switch agents with one click (or <kbd>⌘1</kbd> / <kbd>⌘2</kbd>). The whole UI fades from Claude terracotta to Codex periwinkle.
- Each agent keeps its own native session. When you switch, Duet hands the other agent a compact transcript of what it missed — messages, commands run, files edited — so it continues seamlessly. Switch back and only the new part is handed over.
- One model picker for both agents (switching models across agents switches the agent), reasoning effort, and four permission modes: **Plan**, **Ask**, **Auto-edit**, **Full access**.

**A great place to work with agents**
- Streaming markdown with syntax highlighting, and Claude Code-style work logs: one plain line per step ("Ran `npm test`", "Edited `src/app.ts` +3 −1", "Called `take_screenshot`") that opens into commands with live output, diffs, MCP calls and subagents, plus live plans/to-dos.
- Screenshots and other pictures that tools return (MCP screenshot tools, image viewers, generated images) show right in the conversation — click one for full size.
- Approvals docked above the composer: run/deny commands, review diffs before edits, approve plans, answer agent questions. <kbd>⌘↵</kbd> allow · <kbd>⇧⌘↵</kbd> always allow · <kbd>Esc</kbd> stop.
- Images: paste, drag & drop or attach; both agents see them.
- Type `/` for a menu of every command: Duet's own (`/theme`, `/model`, `/effort`, `/plan`, `/fast`, `/usage`, `/sync`, `/export`…), the agent's built-ins, and your custom commands and Codex skills. `@` mentions files.
- Codex's native features work like they do in Codex: `/review` (uncommitted changes, a branch or a commit), `/compact`, `/init`, skills, and **Fast** mode.
- Live usage meters for both subscriptions (5-hour / weekly limits) and a context-window meter.
- Notifications and a dock badge when an agent finishes or needs you.

**Make it yours**
- **Customize** — 13 themes (Graphite, Paper, Ocean Waves, Aurora, Synthwave, Deep Space…), separate picks for light and dark mode, accent colour (per agent, theme or your own), density, text size, chat width, corner radius, and calm animated backgrounds (gradient, wave, aurora, mesh, glow, grid, stars, grain) that pause when you're idle.
- **Describe a look** — type *"dark gradient with a wave effect"* in Customize, or `/theme …` in any chat, and Claude or Codex designs it. Agents only ever return colours and an effect from a fixed list, which Duet checks for contrast, so a theme can't break the app. Edit any theme afterwards; Undo is one click.
- **Personality** — pick how the agents talk to you (concise, friendly, pragmatic, teacher or your own words), or import your Claude Code output style and use it with Codex too.

**Usage**
- Tokens, cost and activity per day, model and agent, read from Claude Code's and Codex's local logs (in the background, only what changed since last time), plus both subscriptions' limits and your Codex account totals. Choose whether to count work done outside Duet.

**Getting around**
- Start a chat in any project from the home screen, add a project with **+**, or have a quick chat with no project at all.
- **Chat sync** puts every Claude Code and Codex chat in the sidebar as *Claude · title* / *Codex · title*, with their real dates. They're only an index entry until you open one, so syncing hundreds of chats costs next to nothing; it keeps itself up to date.
- A short onboarding for new users that checks both agents and offers to install or sign in to whichever is missing.
- **`duet` command line** — `duet .` opens the current folder, `duet -p "fix the build"` starts a chat, plus `--codex`, `--model`, `--list` and `--usage`. Install it from Settings.

**Built-in tools**
- **Browser** — a real Chromium browser panel for your dev server. Click **Pick element** to send an element's HTML, styles and a cropped screenshot straight into your message, or attach a full screenshot.
- **Changes** — live git status and diffs for the project.
- **Terminal** — a real shell (multiple tabs) in the project folder.
- ⌘K command palette for everything.

**Your data, both ways**
- **History** — every Claude Code session and Codex thread on your Mac, searchable. Open one to continue it with the same agent, or hand it to the other agent.
- **MCP servers** — one list showing each server's status in Claude and Codex side by side. Add a server once and install it in either or both, import from JSON, or copy what you have from one agent to the other. Writes go through each agent's own tooling (`claude mcp`, Codex `config/batchWrite`) so your config files keep their formatting.
- **Sync** — compare and copy instructions (`CLAUDE.md` ⇄ `AGENTS.md`), skills, custom commands/prompts and MCP servers in either direction, or "newest wins". Anything overwritten is saved first.
- **Backups** — snapshot settings, skills, MCP config and full conversation history of both agents (plus Duet's own threads) into one `.tar.gz`, restore on this or another Mac, optional daily/weekly automatic backups. Restores always take a safety backup first.
- **Storage** — pictures are stored once however often they appear, unused attachments and old safety copies can be cleaned up from Settings (they go to the Trash), and only recently used chats stay in memory.

## Screenshots

| | |
|---|---|
| ![Home](docs/screenshots/home.png) | ![Commands](docs/screenshots/commands.png) |
| ![Customize: a theme designed from a sentence](docs/screenshots/customize.png) | ![Usage](docs/screenshots/usage.png) |
| ![Thread](docs/screenshots/thread.png) | ![Approval](docs/screenshots/approval.png) |
| ![Panels: browser, changes, terminal](docs/screenshots/panels.png) | ![Light theme](docs/screenshots/light.png) |
| ![MCP servers](docs/screenshots/mcp.png) | ![Sync](docs/screenshots/sync.png) |
| ![Backups](docs/screenshots/backups.png) | ![Screenshots from tools show in the chat](docs/screenshots/tool-screenshot.png) |

## Requirements

- macOS on Apple Silicon.
- **Claude Code** (`claude`), signed in — `curl -fsSL https://claude.ai/install.sh | bash`, then `claude auth login`.
- **Codex** (`codex`), signed in — `npm i -g @openai/codex`, then `codex login`. Duet also finds the Codex CLI bundled inside the ChatGPT app.

Duet auto-detects both from your shell `PATH` and common install locations; you can point it at a specific binary in **Settings → Agents**.

## Install

Open `release/Duet-2.0.0-arm64.dmg` and drag **Duet** to Applications (or unzip `Duet-2.0.0-arm64-mac.zip`). The build is ad-hoc signed; if macOS blocks the first launch, right-click the app and choose **Open**.

To use Duet from the terminal, open **Settings → Command line → Install** (it adds a small `duet` script to a folder on your `PATH`, such as `/opt/homebrew/bin` or `~/.local/bin`). Then:

```bash
duet ~/Projects/my-app -p "add a dark mode toggle"
```

## Develop

```bash
npm install          # also rebuilds node-pty for Electron
npm run dev          # hot-reloading dev app
npm run typecheck
npm test             # unit tests (vitest)
npm run test:e2e     # builds, then drives the app with Playwright using demo agents
npm run test:live    # real Claude Code + Codex (uses your subscriptions, tiny prompts)
npm run dist         # DMG + zip into ./release
```

`DUET_FAKE_PROVIDERS=1 npm run dev` runs the app with deterministic demo agents (no CLIs or accounts needed). `npm run icons` re-renders `build/icon.png` from `build/icon.svg`.

## How switching works

Every Duet thread stores its own timeline plus, per agent, the id of that agent's native session and how much of the timeline that session has already seen. When you send a message:

1. If the chosen agent has never been in this thread, Duet starts a native session and prepends the conversation so far.
2. If it has, Duet resumes its native session (`claude --resume`, Codex `thread/resume`) and only sends what happened since its last turn. For Codex the hand-off is injected natively as history (`thread/inject_items`); for Claude it is a compact preamble.
3. If a native session can't be resumed anymore, Duet transparently starts a fresh one with the full transcript.

## Where your data lives

- Duet: `~/Library/Application Support/Duet` (threads, attachments, settings, the usage cache).
- Claude Code: `~/.claude`, `~/.claude.json`. Codex: `~/.codex`.
- Backups default to `~/Documents/Duet Backups`; change it in **Backups**.

Nothing leaves your Mac except the agents' own API traffic.

## Architecture

```
src/
  main/                 Electron main process
    providers/claude    stream-json control protocol: process, mapper, tool/approval descriptions
    providers/codex     app-server JSON-RPC client, item mapper, adapter
    providers/fake      deterministic demo agents for tests
    orchestrator.ts     threads, turns, approvals, hand-offs, persistence
    handoff.ts          budgeted transcript for agent switches
    features/           mcp, sync, backup, history, chat sync, usage (worker thread), themes,
                        personality, storage, cli, deep links, git, files, terminal
  preload/              contextBridge API (typed by src/shared/api.ts)
  renderer/             React 19 + Tailwind 4 UI
  shared/               types, theme engine, personalities, diff engine, path helpers
tests/
  unit/                 vitest
  e2e/                  Playwright + Electron (demo agents)
  live/                 real CLIs (opt-in)
```

Security: the window runs sandboxed with context isolation, every IPC call is checked against the main window, the embedded browser runs in its own sandboxed partition without preload access, and local images are served through a read-only, image-only protocol. Themes are data, never code. `duet://` links from anywhere else can only fill in a draft; sending a prompt straight away needs a private token from Duet's data folder, which the `duet` command reads.
