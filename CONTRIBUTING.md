# Contributing to Shellmate

Thanks for helping make remote operations with an AI assistant transparent and safe.

## Before starting

- Search existing issues before opening a bug report or feature request.
- Keep proposals aligned with the direction in `VISION.md`: the user stays in control of connections, credentials, permissions, and model choice, and assistant behavior stays visible.
- Read `AGENTS.md` and `FILEMAP.md` for the project's conventions and layout.

## Local setup

Shellmate is developed on Windows with Node.js 22 or newer.

```powershell
npm ci
npm run typecheck
npm run build
npm run dev
```

## Pull requests

- Keep each pull request focused and describe the user-visible behavior it changes.
- For UI or terminal changes, say which interactions you checked in the running app or browser mode.
- Update `README.md`, `FILEMAP.md`, and `docs/` when responsibilities or behavior change.
- Credentials must go through the OS-encrypted `SecureStore`; never put secrets in SQLite, prompts, snapshots, or logs.
- Do not include real credentials, tokens, API keys, hostnames, IP addresses, screenshots of private systems, or build output.
