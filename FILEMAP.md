# Shellmate file map

Read this map at the start of each development session. Generated output, dependencies, and user data are omitted.

| File | Responsibility |
| --- | --- |
| `AGENTS.md` | Stable project workflow and verification instructions. |
| `VISION.md` | Product direction for transparent remote operations. |
| `README.md` | Current behavior, setup, build, and control model. |
| `docs/architecture.md` | Implemented runtime boundaries, data, terminal ownership, and recovery. |
| `docs/verification.md` | Checks actually run and outstanding live integration evidence. |
| `docs/sources.md` | SfxChat source revision, reused files, and attribution. |
| `LICENSE` | MIT license copied with the SfxChat-derived source. |
| `package.json`, `package-lock.json` | Runtime/development dependencies and build scripts. |
| `tsconfig.json`, `electron.vite.config.ts`, `electron-builder.yml` | TypeScript, bundling (main plus the `pty-host` entry), and Windows installer configuration. |
| `.vscode/launch.json`, `.vscode/tasks.json` | Electron development launch and build task. |
| `src/shared/types.ts`, `src/shared/chat-models.ts` | Typed renderer/main contracts and built-in Codex model metadata. |
| `src/main/index.ts` | Electron lifecycle, secure storage, provider wiring, validated operations, and app snapshots. |
| `src/main/browser-host.ts` | Loopback browser development host, static renderer delivery, authenticated operation bridge, and events. |
| `src/main/store.ts` | Fresh SQLite schema, workspace/connection/note/conversation persistence, tool ledger, and restart recovery. |
| `src/main/terminal.ts` | Local PTY/SSH sessions, host-key trust, integration bootstrap, shell state, command execution, elevation prompts, and ownership. |
| `src/main/shell-integration.ts` | PowerShell/bash/zsh/sh prompt hooks, bootstrap lines, command keystrokes, and the nonce-tagged OSC parser. |
| `src/main/local-pty.ts` | `LocalPtyHost`: starts the PTY utility process, routes spawn/write/resize/kill messages, and strips debugger env. |
| `src/main/pty-host.ts` | Utility-process entry that owns node-pty ConPTY terminals off the main thread. |
| `src/main/chat-service.ts`, `src/main/assistant.ts` | Persistent streaming turns, workspace-scoped terminal/web/recall tools and approvals, prompt, cancellation, context accounting, and per-round compaction. |
| `src/main/compaction.ts` | Pure history compaction: tool-output clearing, round-safe summary split, transcript rendering, summary prompt, and usage parsing. |
| `src/main/web-search.ts` | App-owned `web_search` backends (SerpApi, Tavily) with keys in SecureStore. |
| `src/main/web-fetch.ts` | `web_fetch`: SSRF-guarded public page fetch with redirect, size, and time limits, converted to text. |
| `src/main/chat-registry.ts`, `src/main/chat-context.ts` | Provider/model registry, selection, capability testing, context windows, and token estimates. |
| `src/main/diagnostics.ts` | Redacted local diagnostics. |
| `src/main/providers/auth.ts`, `codex.ts`, `secrets.ts`, `errors.ts` | Codex OAuth/transport, encrypted credentials, and provider error handling. |
| `src/main/providers/generic/` | Chat Completions, Responses, Anthropic (incl. built-in web search and citations), SSE, registry validation, and capability probes. |
| `src/preload/index.ts` | Fixed renderer IPC bridge and change/output notifications. |
| `src/renderer/index.html`, `main.tsx` | Secured renderer document and React entrypoint. |
| `src/renderer/browser-bridge.ts` | Browser implementation of the fixed Shellmate API over the loopback host. |
| `src/renderer/App.tsx`, `styles.css` | Workspace UI, chat, terminal tabs/split, notes, connections, provider settings, and approvals. |
| `src/renderer/theme.ts` | Persisted theme selection and xterm palettes. |
| `Shellmate/wwwroot/favicon.png` | Unused legacy icon retained after an automatic deletion policy block. The prior SQLite database remains ignored and untouched. |
