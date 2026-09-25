# Architecture

The Electron main process owns SQLite, encrypted secrets, chat providers, tool execution, and all terminal sessions. The renderer has no Node integration. A sandboxed preload exposes fixed operations; the main process validates arguments and accepts requests only from the application's main frame. Terminal output is sent as sequenced events so streaming does not require a full database snapshot on every chunk.

## Data and providers

The new `shellmate.sqlite` profile uses SQLite WAL, foreign keys, and a versioned schema. Workspaces reference app-wide connection profiles. Conversations belong to workspaces, and each conversation has explicit connection targets and access modes. Notes belong to profiles and are visible in any workspace containing that connection. Provider configuration is app-wide. Credentials are stored as encrypted files through Electron `safeStorage`, never in SQLite or renderer snapshots.

Provider transports and registry logic were adapted from the SfxChat revision recorded in [sources](sources.md). The chat runtime stores Responses-shaped wire history plus a tool ledger. A tool call records its intent before dispatch and its result afterward. Startup marks incomplete turns and tools as interrupted or uncertain. Missing tool outputs can be repaired from the ledger without rerunning a command. A conversation pins provider/model/effort for its turn. Generic providers are tested before model records are saved.

## Terminals and ownership

The main process keeps one live session per workspace/connection pair. Local sessions use node-pty; SSH sessions use ssh2 interactive shells and compare each host-key SHA-256 hash with the explicitly trusted profile hash. Unknown or changed keys are rejected until the user trusts the presented fingerprint. The renderer uses xterm and receives bounded output snapshots plus sequential live chunks.

On Windows, local sessions use ConPTY during normal operation. VS Code F5 and other inspector-attached launches use node-pty's WinPTY backend because ConPTY can block while spawning under a debugger and freeze Electron's main thread.

Tool calls include a connection ID, and the main process checks that the ID belongs to the conversation's workspace and selected targets. The target set is frozen at the start of a turn; additions and permission increases take effect next turn. Removals and disabling immediately prevent further dispatch. In ask mode, each command needs approval bound to its session ID and exact command text. Profile edits and reconnects invalidate pending approval through the session-ID check.

The first terminal operation acquires a per-session owner for the assistant turn. The owner is independent of the selected UI tab. User input is rejected by the main process while owned, though output and notes remain readable. A second conversation receives a busy result. Takeover aborts the owning turn and sends an interrupt to a running command. The lease remains until the command finishes or the user disconnects. A soft command timeout reports that the process continues; it does not release ownership.

Shell-specific wrappers emit start and end markers around assistant commands to collect results and exit codes. Output is bounded for model context. The persistent terminal remains visible, and command text and outcomes are recorded in the transcript. Manual input is treated as potentially busy until a shell prompt is observed; prompt recognition is heuristic for custom shells, so live SSH and custom-prompt checks remain a verification item.

## Lifecycle

Windows is the first release target. Browser-hosted operation and the old .NET runtime are absent. The earlier database is untouched and not migrated. On restart, workspaces and transcripts return with terminals disconnected. Shutdown aborts active chat turns, closes managed sessions, then closes SQLite. The app installs no background service.
