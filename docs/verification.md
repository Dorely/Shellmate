# Verification record

2026-09-24/25, Windows development host:

- `npm run typecheck` passed.
- `npm run build` passed for main, preload, and renderer bundles.
- `npm run dev` started Electron; the Shellmate main window and a fresh `shellmate.sqlite` profile were observed. The startup diagnostic recorded `app.started`.
- A local `node-pty` PowerShell process reached a prompt in a standalone native-module smoke check. It did not validate the complete application terminal UI.
- After a clean `npm ci`, `npm run typecheck` and `npm run package` passed. The installer is `release-ready/Shellmate Setup 0.1.0.exe`. Electron-builder uses the unpacked Electron distribution to avoid the Windows `EPERM` rename failure seen with archive extraction. A later incremental attempt against the previous output directory could not replace a locked `app.asar`, so the final bundle uses a fresh directory.
- The final packaged `release-ready/win-unpacked/Shellmate.exe` remained running during a five-second startup smoke check and recorded `app.started` with `packaged: true`. It was then terminated.

Live Codex login, generic provider requests, SSH host-key/credential flows, agent command approvals, and renderer interactions have not yet been verified on configured systems. The first computer-use inventory did not expose the Shellmate window, so a visual interaction pass remained outstanding. The packaged startup check does not validate those workflows.

2026-09-24 model selector relocation: `npm run typecheck` and `npm run build` passed. Computer Use found an existing Shellmate Electron window, but activation timed out and the state capture retry failed with `SetIsBorderRequired failed: No such interface supported (0x80004002)`. No live UI interaction was confirmed for this change.

2026-09-24 F5 local-shell freeze: Windows ConPTY spawned and resized PowerShell outside the debugger, while node-pty's WinPTY backend spawned, reached a prompt, and resized with the inspector active. With `SHELLMATE_DEBUG_PTY=winpty`, a direct `TerminalManager` smoke check connected, received the prompt, resized, and received command output. `npm run typecheck` and `npm run build` passed. The full VS Code F5 window flow has not been rechecked after this change.

2026-09-24 workspace access, themes, and custom Codex models:

- `npm run typecheck` and `npm run build` passed.
- An isolated version 1 SQLite profile migrated to version 2: Disabled stayed Disabled, an Autonomous target became Ask, chat history stayed intact, the old target table was removed, and a newly opened connection defaulted to Ask. The live Shellmate profile also opened at schema version 2 with workspace access entries and no target table.
- An isolated registry smoke check confirmed that saving a custom Codex model requires a completed medium-effort test bound to the signed-in account; the model then resolves through Codex, duplicate IDs are rejected, and deleting the selected model restores the built-in default. This used a stub transport and did not contact Codex.
- An isolated access check confirmed Ask by default, permission increases on the next turn, immediate downgrades, and no restored access within a turn after removing and reopening a connection.
- `npm run dev` opened a Shellmate window and was stopped after verification. Computer Use identified the window but could not capture it: `SetIsBorderRequired failed: No such interface supported (0x80004002)`. Live theme switching, terminal recoloring, permission changes during a chat, and a signed-in Codex model test remain unverified in the window.
- `npm run browser` served the built renderer and real Shellmate services on a random loopback port. The browser loaded saved workspaces and connection tabs. Graphite, Light, and Forest rendered; Forest persisted after a reload. The provider dialog showed the custom Codex model form. Changing Local access to Disabled updated its chip and reduced the available connection count, then changing it back restored both. Graphite and Ask were restored after verification. No terminal command or live Codex request was sent through the browser.
- Browser host checks returned 403 without a session cookie and for a foreign Origin; an authenticated same-origin snapshot returned 200.
