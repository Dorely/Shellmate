# Shellmate - Project Guidelines

## First Read
- Read `VISION.md` immediately before doing any substantive work in this repo.
- Read `FILEMAP.md` at the start of every session to understand the full codebase layout.
- Treat `VISION.md` as the high-level direction for the project.
- Do not assume everything in `VISION.md` is implemented or currently part of the implementation plan. Use the codebase to confirm current behavior.
- Keep this file (`AGENTS.md`) stable and high level. Do not add notes here that are likely to become stale during normal development.

## File Map Maintenance
- After adding, deleting, or renaming any source file, update `FILEMAP.md` to reflect the change.
- When refactoring moves code between files or changes a file's responsibility, update the description in `FILEMAP.md`.
- Keep `FILEMAP.md` entries concise - one to two lines per file maximum. If a file is doing more than can be reasonably construed within that limit, consider refactoring it.

## Tech Stack
- Electron, React, TypeScript, and electron-vite for the Windows-first desktop app.
- SQLite for workspaces, connections, notes, conversations, and tool history.
- node-pty and ssh2 for local and SSH interactive terminals; xterm for display.
- Codex account chat plus OpenAI-compatible Chat Completions/Responses and Anthropic providers.

## Architectural Overview
- Shellmate is a local Electron desktop app. The main process owns privileged operations; a sandboxed React renderer uses a fixed validated preload API.
- The assistant may operate only explicitly selected connections, and the main process enforces command permissions and terminal ownership.

## Code Style
- Keep UI interaction state separate from persistence, provider resolution, terminal sessions, and chat behavior.
- Do not expose general filesystem, shell, or credential access through preload.
- Store credentials through the OS-encrypted `SecureStore`; do not put plaintext secrets in SQLite, snapshots, prompts, or logs.

## Build & Run
```bash
npm ci
npm run typecheck
npm run build
npm run dev
npm run package
```

## Verification
- Do not add test projects or automated tests unless the user explicitly requests them.
- Verify normal changes with `npm run typecheck` and `npm run build`.
- For UI/terminal work, inspect the live Electron app and record which interactions were actually checked.
- For packaging changes, run `npm run package` on Windows. Never leave an app instance started for verification running.

## Conventions
- When you need to understand current wiring, start with `VISION.md`, then `src/main/index.ts`, then the relevant area.
- Trace each requested change through its full impact area before considering the work complete. Changes to models, contracts, or core concepts should include all affected layers such as persistence, services, UI, and documentation.
- Remove superseded code and concepts when replacing them. Do not leave deprecated pages, components, handlers, prompts, queries, or other logic in place just because the new path works; clean out obsolete implementations and reduce unnecessary complexity.
- This is a local development project. When a requested change replaces a concept, remove the superseded implementation outright; do not add or retain compatibility shims, legacy handlers/fallbacks, deprecated tool aliases, or dual paths unless the user explicitly asks for a transition path.
