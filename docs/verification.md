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

2026-09-24 shell integration rewrite (marker wrappers replaced):

- `npm run typecheck` and `npm run build` passed.
- Spike: OSC sequences pass through both inbox and bundled ConPTY on Windows 10 19045, and WinPTY strips them. With the inbox ConPTY, the command-start and exit marks arrived before the screen text they bracket, so captures contained the echo instead of the output. The bundled ConPTY (`useConptyDll`) kept them in order.
- A scratch harness drove the real `TerminalManager` through local shells.
  - Windows PowerShell 5.1: integration ready; `cd`/`$x` persisted across commands; `cmd /c exit 3` reported exit code 3; a multi-line `. { … }` command returned only its output, and its variable persisted; a `Read-Host -AsSecureString "Password"` prompt raised an elevation request with the text `Password:`, and the reply was delivered; takeover during `Start-Sleep 30` released ownership and a later command ran.
  - Git Bash 5.2 and WSL Ubuntu bash 5.2: the same checks passed. The bootstrap was invisible, `history` contained no bootstrap entry, and multi-line commands ran as a single `{ … }` history entry. Real `sudo` showed `[sudo] password for jonth:` in the request; a wrong password raised a second request, and Cancel sent an interrupt; the command failed with exit code 1, and the next command ran.
  - WSL dash: prompt-only integration without a command-start mark; exit codes and persistent state were correct, and the echo was stripped from single-line and multi-line output.
  - `printf "db password:"` finished without a password request. cmd.exe reported `unsupported`, and agent commands were refused.
  - An SSH-style run (banner kept, no screen clear) in WSL bash kept the login banner lines and dropped the pre-integration prompt.
- In `npm run browser`, the user's Plex-Server SSH connection (Ubuntu, bash) was connected from the UI. The terminal showed the last-login banner and one clean prompt; integration was ready and reported the working directory. A user-typed `history | tail -3` showed no bootstrap entry, only two leftover entries from the previous `__SHELLMATE_*` wrapper, then returned to not busy with exit code 0. The session was disconnected, and the app was stopped.
- Not verified: zsh (not installed), PowerShell over SSH, and assistant turns sent through a live model in the app. Under the VS Code F5 debugger, WinPTY sessions are expected to report integration as unavailable.

2026-09-24 F5 freeze fixed with a PTY utility process (WinPTY fallback removed):

- `npm run typecheck` and `npm run build` passed; the build emits `out/main/pty-host.js`.
- The built app ran in browser mode under `--inspect-brk` with a CDP client that enabled `NodeWorker` with `waitForDebuggerOnStart`, the same worker pause VS Code js-debug applies, and set `VSCODE_INSPECTOR_OPTIONS`. Local PowerShell connected in about two seconds with integration ready. A typed `cd C:\Windows; cmd /c exit 3` reported cwd `C:\Windows` and exit code 3. Resize and disconnect worked, and no Shellmate `OpenConsole.exe` remained afterward.
- A packaged `electron-builder --win dir` build (to a scratch directory, because `release-ready/win-unpacked/resources/app.asar` was locked) included `out/main/pty-host.js` in the asar and the unpacked ConPTY files. Driven over the renderer's DevTools protocol, it connected local PowerShell with integration ready and reported cwd and exit code 4.
- The real VS Code F5 button was not pressed; the check above reproduces its worker-pausing debugger.

2026-09-24 web search, fetch, and citations:

- `npm run typecheck` and `npm run build` passed.
- `npm run browser` opened the live profile. It migrated to schema version 3, and the Default workspace showed `Web · ask`. The Access picker's Web row changed the mode, and Autonomous persisted across an app restart.
- Codex (`gpt-6-sol`, high), Autonomous: asking for the current Node.js LTS produced two `web_search (built-in)` activity rows (a search query and an `open` of nodejs.org), an answer citing nodejs.org, and a Sources list. Activity rows were first shown after the answer bubble; the bubble is now split around each search. That ordering change was typechecked and built but not rechecked live.
- Ask mode: a request to fetch three URLs raised a web approval card for each. The approved `https://example.com` returned "Example Domain". The approved `http://127.0.0.1:8080/` was blocked as a private address. The rejected `http://192.168.1.1/` returned a declined error. Literal private URLs are now rejected before the approval prompt; this was not rechecked live.
- A standalone bundle of `web-fetch.ts` blocked `localtest.me` (resolves to loopback), `[::1]`, `[::ffff:127.0.0.1]`, `2130706433`, `169.254.169.254`, `file://`, embedded credentials, and an httpbin redirect to `127.0.0.1`, and fetched `https://example.com/`.
- Disabled mode: the model listed no web tools and declined to fetch.
- Providers → Web search rendered the None/SerpApi/Tavily selector and key field. No search key was entered, so SerpApi, Tavily, and app-owned `web_search` were not exercised. No Anthropic, generic Responses, or Chat Completions provider was configured, so their built-in search, citations, `pause_turn` handling, the Anthropic and Chat Completions tool-shape fixes, and the Responses `reasoning.effort` change were not verified live.
- The Web mode was restored to Ask and the browser-mode app was stopped.

2026-09-24 shell-exit reporting and uncapped tool rounds:

- Cause: in a live Plex-Server chat, two `set -e; python3 … PY; docker compose …` commands failed in the shared login shell. errexit exited bash, the SSH channel closed, and the assistant saw only `interrupted` with empty output. Piping `set -e` and then a failing `{ …; }` group into Git Bash `bash -i` confirmed that the next line never ran.
- `npm run typecheck` and `npm run build` passed.
- The generated POSIX bootstrap ran in Git Bash `bash -i` and `sh -i`. Each prompt emitted the option flags before the exit code; `e` appeared after `set -e` and cleared after `set +e`.
- The likely-cause pattern matched `set -e; …`, `set -euo pipefail`, and `&& exit 1`. It did not match `docker exec`, `find -exec`, or `bash -c "set -e; …"`.
- Not verified: the `disconnected` result and errexit note in a live app turn, and zsh.

2026-09-25 in-place delete confirmation (native confirm dialogs removed):

- `npm run typecheck` and `npm run build` passed; no `alert`, `confirm`, or `prompt` calls remain in `src`.
- `npm run browser`: a new conversation's History × turned into a red `Delete?` button in the same spot, and a second click at the same point deleted it (8 conversations remained; the original was set active again). An earlier second click that landed outside the button disarmed it without deleting.
- Edit connection → Delete connection armed as `Delete it and its notes everywhere?` in place and disarmed when the pointer left; the dialog was cancelled and both connections remained. The browser-mode app was stopped.

2026-09-25 conversation management and provider layout:

- `npm run typecheck` and `npm run build` passed.
- `npm run browser` on the live profile: ＋ created a conversation and made it active; clicking the title opened an inline editor and Enter saved a user title. History listed conversations newest first with rename and delete controls; a reload kept the new conversation active. Clearing the title from History on the empty conversation returned it to `New conversation` with `default` source. Deleting it (confirm accepted) fell back to the newest remaining conversation, leaving the original eight. The original conversation was set active again.
- A long History title first overflowed and hid the row controls; the list column was constrained and the titles now truncate.
- At 1600×1000 the providers dialog filled most of the window with four separate cards, each splitting its saved items from its add/edit form.
- Not verified: an assistant `rename_session` call under the new prompt, the Electron window (the workspace name dialog replaces `window.prompt`, which Electron does not support), and the single-column layout below 1000px.
- The browser-mode app was stopped.

2026-09-25 mid-turn context compaction:

- `npm run typecheck` and `npm run build` passed.
- A standalone bundle of `compaction.ts` cleared only older outputs, left the latest round intact, and started the summary tail at a round boundary. It also quoted the current request when the tail no longer held it and read Responses, Chat Completions, and Anthropic usage fields.
- `npm run browser`, Codex `gpt-6-sol` high, with the Codex window temporarily forced to 24,000 tokens (reverted before commit). Local was added to the Default workspace as Autonomous. The model ran four large-output PowerShell commands, then was asked for the fifth file from command (1). Over about 20 rounds the turn cleared outputs and summarized several times, and the summaries showed in the chat. It called `recall_tool_output` and completed with the correct answer, `@AppHelpToast.png`, 232 bytes. Command (1)'s stored output was already cut to its last 32k characters by the terminal limit, so the model reran a five-file listing to confirm. The run showed that summarizing a small head did not shrink the context (13k → 13k). A minimum head size of 15% of the window was added, the context meter was scaled by the calibration, and cleared recalls were made to resolve to the original output.
- After a restart, a follow-up turn in the same conversation paged a cleared result back through `recall_tool_output` (20,000 and then 12,349 characters). It listed the four earlier commands without running new ones.
- The provider screen showed the Context window field prefilled with 272000. No API provider was configured, so saving a model's context window, overflow-error retry, and compaction on Anthropic, Responses, and Chat Completions were not verified live.
- Local was removed from the Default workspace again and the browser-mode app was stopped.

2026-09-25 v1.0.0 release preparation (logo, release scripts, README):

- `npm run typecheck` and `npm run build` passed; the main bundle emits `chunks/icon-*.ico` for the window icon.
- Built Electron app driven over the DevTools protocol: the header shows the new logo. A demo workspace (local PowerShell, one note, one "Ask" command approval) produced `docs/images/screenshot.png`. The profile database was backed up first and restored byte-identical afterward.
- `npm run browser`: the logo PNG is served as `image/png` with its exact byte size, and the header image and favicon load in the browser pane.
- `npm run release` refused to clear `release/` while another Electron app held old `.asar` handles, as designed, and succeeded once they were released. It produced `release/Shellmate-Setup-1.0.0.exe` and its `.sha256`.
- With `signExecutable: false` (instead of `signAndEditExecutable: false`), `Shellmate.exe` and the installer both carry the crab icon, and the exe reports ProductName Shellmate, FileVersion 1.0.0, and CompanyName Dorely. Code signing remains skipped.
- `release/win-unpacked/Shellmate.exe` started and stayed up for 8 seconds, the taskbar showed the crab icon, and the app then closed normally. The NSIS installer itself was not run, to avoid installing on the development host.
- A history-wide `git log -p` scan for key and token patterns (`sk-`, `tvly-`, JWTs, private-key headers, GitHub and AWS keys) found nothing.
