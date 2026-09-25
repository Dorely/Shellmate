# Shellmate

Shellmate is a Windows-first desktop remote connection manager. It pairs visible local or SSH terminals with persistent assistant conversations, per-connection notes, and explicit control over which machines an assistant may use.

## Current application

- Electron main process with a sandboxed React renderer and a fixed, validated preload API.
- SQLite workspaces, shared connection profiles, per-workspace conversations, connection notes, and durable chat/tool history.
- Local PTYs and SSH shell sessions with host-key verification, password/private-key authentication, terminal tabs, and a two-terminal split.
- Codex account chat, generic Chat Completions, Responses, and Anthropic providers. API keys and OAuth tokens use Electron OS-backed encryption.
- Per-conversation targets with disabled, ask-before-command, or autonomous access. A terminal an assistant uses is locked for the turn; user takeover stops further assistant dispatch.

This is a fresh application profile. The earlier .NET database at `Shellmate/shellmate.db` is neither read nor changed. The new profile lives under the operating system's Electron `Shellmate` user-data directory.

## Development

Requires Node.js 22 or later. On Windows, use:

```powershell
npm ci
npm run typecheck
npm run dev
```

`npm ci` downloads the Electron runtime and rebuilds `better-sqlite3` for it. `node-pty` ships a Windows binary and is intentionally excluded from the rebuild, because its source build requires Spectre-mitigated C++ libraries. Native modules remain unpacked by electron-builder.

To make a production bundle or Windows installer:

```powershell
npm run build
npm run package
```

VS Code F5 starts the Electron development app. The app uses a loopback OAuth callback on port 1455 when signing in to Codex.

## Control model

A conversation targets only connections explicitly selected for it. Targets default to **Ask before commands**. The selected terminal tab changes what the user sees; it never changes the target of an assistant tool call.

The main process holds exclusive ownership of a terminal while an assistant turn uses it. The user can scroll and copy during that time. Typing and competing assistant commands are rejected. **Take over** stops further assistant dispatch and interrupts a running command; an uncertain interruption requires reconnecting the session before further input.

Unknown or changed SSH host keys need explicit trust. Password prompts appear in a dedicated application dialog and are not sent to the model. Command observation timeouts do not stop remote commands. Interrupted commands are not replayed on restart.

Implementation details and evidence limits are in [architecture](docs/architecture.md) and [verification](docs/verification.md).
