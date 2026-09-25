# Shellmate

Shellmate is a Windows-first desktop remote connection manager. It pairs visible local or SSH terminals with persistent assistant conversations, per-connection notes, and explicit control over which machines an assistant may use.

## Current application

- Electron main process with a sandboxed React renderer and a fixed, validated preload API.
- SQLite workspaces, shared connection profiles, per-workspace conversations, connection notes, and durable chat/tool history.
- Local PTYs and SSH shell sessions with host-key verification, password/private-key authentication, terminal tabs, and a two-terminal split.
- Codex account chat, generic Chat Completions, Responses, and Anthropic providers. API keys and OAuth tokens use Electron OS-backed encryption.
- Workspace connections are available to every conversation in that workspace, with disabled, ask-before-command, or autonomous access. A terminal an assistant uses is locked for the turn; user takeover stops further assistant dispatch.
- Per-workspace web access (Disabled, Ask, Autonomous) for web search, page fetches, and clickable cited sources.
- A header theme selector offers Graphite, Light, and Forest. The provider screen supports tested custom Codex models alongside built-in models and API providers.

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

For browser verification, run `npm run browser` and open the printed `http://127.0.0.1:<port>` URL. This builds the renderer and starts the same local services without an Electron window. Stop it with Ctrl+C when finished. Re-run the command after code changes. Browser mode uses the existing Shellmate profile, so changes made there also appear in the desktop app.

## Control model

Every conversation sees its workspace's connection tabs, including disconnected connections it can reconnect. Each workspace connection defaults to **Ask before commands**; use **Access** to set Disabled or Autonomous. The selected terminal tab changes what the user sees; assistant tool calls always name a connection ID. New connections and permission increases take effect with the next message, while restrictions take effect immediately.

The main process holds exclusive ownership of a terminal while an assistant turn uses it. The user can scroll and copy during that time. Typing and competing assistant commands are rejected. **Take over** stops further assistant dispatch and interrupts a running command. If the program ignores the interrupt, control still returns to the user after three seconds.

Assistant commands are typed into the live shell exactly as a user would type them, so the working directory and variables persist. Shellmate learns prompt, command-start, and exit-code boundaries from invisible shell-integration sequences. Local PowerShell loads the hooks at launch. Local POSIX shells and SSH sessions receive a one-line bootstrap after connecting, with its echo hidden and, in bash, its history entry removed. Agent commands require PowerShell or a POSIX shell (bash, zsh, dash/sh) with integration ready. cmd.exe sessions are manual only. Password prompts from assistant commands open an app dialog showing the prompt text; Windows UAC elevation happens outside the terminal and is left to the user.

Unknown or changed SSH host keys need explicit trust. Password prompts appear in a dedicated application dialog and are not sent to the model. Command observation timeouts do not stop remote commands. Interrupted commands are not replayed on restart.

## Web access

Each workspace has a **Web** setting under **Access**. New and migrated workspaces use **Ask before each search or fetch**.

- **Disabled:** the assistant has no web tools.
- **Ask:** each `web_search` and `web_fetch` call shows an approval card with the query or URL.
- **Autonomous:** web calls run without approval. Models with built-in search (Codex models, and API models whose test found hosted search) use the provider's search. Built-in search runs on the provider's servers and can't be approved per call, so it is offered only in Autonomous mode.

When built-in search isn't used, `web_search` goes through the search API chosen in **Providers → Web search**: SerpApi or Tavily. Enter the API key there; it is stored with OS encryption. Without a configured search API, the assistant can still fetch known URLs. `web_fetch` reads only public http(s) pages; loopback, private, link-local, and CGNAT addresses are blocked, including after redirects. URLs in chat open in the system browser, and cited sources are listed under the answer.

Implementation details and evidence limits are in [architecture](docs/architecture.md) and [verification](docs/verification.md).
