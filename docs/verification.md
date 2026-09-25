# Verification record

2026-09-24/25, Windows development host:

- `npm run typecheck` passed.
- `npm run build` passed for main, preload, and renderer bundles.
- `npm run dev` started Electron; the Shellmate main window and a fresh `shellmate.sqlite` profile were observed. The startup diagnostic recorded `app.started`.
- A local `node-pty` PowerShell process reached a prompt in a standalone native-module smoke check. It did not validate the complete application terminal UI.
- After a clean `npm ci`, `npm run typecheck` and `npm run package` passed. The installer is `release-ready/Shellmate Setup 0.1.0.exe`. Electron-builder uses the unpacked Electron distribution to avoid the Windows `EPERM` rename failure seen with archive extraction. A later incremental attempt against the previous output directory could not replace a locked `app.asar`, so the final bundle uses a fresh directory.
- The final packaged `release-ready/win-unpacked/Shellmate.exe` remained running during a five-second startup smoke check and recorded `app.started` with `packaged: true`. It was then terminated.

Live Codex login, generic provider requests, SSH host-key/credential flows, agent command approvals, and renderer interactions have not yet been verified on configured systems. The computer-use app inventory did not expose the Shellmate window, so a visual interaction pass remains outstanding. The packaged startup check does not validate those workflows.
