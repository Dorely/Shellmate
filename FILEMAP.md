# Shellmate - File Map

> **Auto-maintained reference.** Agents and contributors should update this file whenever files are added, removed, or significantly refactored.
> Read this file at the start of every session to understand the codebase layout.

---

## Root

| File | Description |
|------|-------------|
| `VISION.md` | High-level project vision and success criteria. |
| `README.md` | Project purpose, first-slice status, requirements, build/run commands, packaging notes, and local-data notes. |
| `AGENTS.md` | Stable project guidance for agents and contributors. |
| `FILEMAP.md` | This file - concise map of source files and project structure. |
| `Shellmate.sln` | Solution file containing the `Shellmate` project. |
| `global.json` | Pins the .NET SDK version (`10.0.100`). |
| `.editorconfig` | C#/Razor formatting and naming rules generated from the .NET template. |
| `.gitignore` | Standard .NET ignore patterns plus Shellmate local SQLite database files. |
| `.vscode/launch.json` | VS Code debug configurations; the first/default F5 target launches Shellmate in Electron mode. |
| `.vscode/tasks.json` | VS Code build task used by debug launch configurations. |

## Shellmate/ - Blazor/Electron App

| File | Description |
|------|-------------|
| `Shellmate.csproj` | `net10.0` Blazor Web project with Electron.NET, EF Core SQLite, Microsoft.Extensions.AI, OpenAI SDK, tokenizers, SSH.NET, Quick.PtyNet, runtime IDs, and warnings-as-errors. |
| `Program.cs` | App host setup: Electron mode detection/window launch, Blazor Interactive Server, DI wiring, EF migrations, OAuth endpoints, token counting, assistant tools, notes, and routing. |
| `appsettings.json` / `appsettings.Development.json` | Configuration for logging, desktop binding, Codex OAuth redirect URI, SQLite connection string, Blazor hub size, agent/tool/terminal limits, and token-counting defaults. |
| `Properties/launchSettings.json` | Local launch profiles for browser-hosted HTTP and Electron desktop mode on `localhost:1455`. |
| `Properties/electron-builder.json` | Electron/electron-builder packaging metadata for Windows, Linux, and macOS targets. |

### Auth/

| File | Description |
|------|-------------|
| `CodexOAuthEndpoints.cs` | Minimal API endpoints for starting and completing OpenAI account OAuth, then redirecting back to provider settings. |

### Chat/

| File | Description |
|------|-------------|
| `IAssistantChatService.cs` / `AssistantChatService.cs` | Persistent assistant turn service with provider resolution, manual tool-call loop, shared tool invocation, cancellation, reset, and transcript persistence. |
| `IWorkspaceChatRuntime.cs` / `WorkspaceChatRuntime.cs` | App-process chat runtime that keeps active assistant turns alive across route changes and renderer reloads, with live-turn state and note-change notifications. |
| `AssistantPromptBuilder.cs` | Builds the app-owned assistant system prompt with tool-use rules, visible note guidance, and dynamic terminal context. |
| `AssistantToolRegistry.cs` | Shared assistant tool registry that combines shell and note tools for model requests and token-count previews. |
| `AssistantShellTools.cs` | Defines shell inspection and command-execution tools over the currently connected terminal session. |
| `AssistantNoteTools.cs` | Defines connection-scoped note list/read/create/rename/update/delete tools resolved through the selected workspace connection. |
| `AssistantTurnUpdate.cs` | Streaming update records consumed by the chat page: text deltas, tool-call events, completion, and turn errors. |

### Components/

| File | Description |
|------|-------------|
| `App.razor` | Root HTML shell, static assets including xterm, Blazor script, and reconnect modal. |
| `Routes.razor` | Router setup using `MainLayout` and the NotFound page. |
| `_Imports.razor` | Shared Razor `@using` directives for components. |

### Components/Chat/

| File | Description |
|------|-------------|
| `ChatModels.cs` | UI-only chat transcript/live-turn models, message parts, persisted tool-call helpers, tool-chip state, and live token-count helpers used by `ChatSurface`. |
| `ChatTranscriptTokenCounter.cs` | Shared chat transcript token-count adapter for model input: system prompt, tool definitions, persisted messages, pending user text, and live turns. |
| `ChatSurface.razor` / `.razor.css` / `.razor.js` | Reusable chat shell for text/tool transcript rendering, token badge display, streaming state, composer autosize, enter-to-send, and scroll-follow behavior. |
| `ChatToolChipView.razor` / `.razor.css` | Expandable generic tool-call chip used for live and persisted shell tool calls. |

### Components/Terminal/

| File | Description |
|------|-------------|
| `TerminalSurface.razor` / `.razor.css` / `.razor.js` | Reusable xterm surface with JS interop for initialization, input, output, fit/resize, focus, and disposal. |

### Components/Notes/

| File | Description |
|------|-------------|
| `ConnectionNotesDrawer.razor` / `.razor.css` | Right-side workspace drawer for selected-connection note listing, creation, editing, saving, and deletion. |

### Components/Layout/

| File | Description |
|------|-------------|
| `MainLayout.razor` / `.razor.css` | Desktop-style app shell with left navigation, full-height content area, and global terminal elevation prompt dialog. |
| `NavMenu.razor` / `.razor.css` | Sidebar navigation for Chat, Providers, and Connections. |
| `ReconnectModal.razor` / `.razor.css` / `.razor.js` | Template reconnect UI shown when the SignalR circuit drops. |

### Components/Pages/

| File | Description |
|------|-------------|
| `Home.razor` / `.razor.css` | Workspace route at `/` and `/chat`; attaches to persistent chat/terminal runtimes, shows token counts, terminal UI, live tool chips, and notes drawer. |
| `NotFound.razor` | 404 page wired through status-code re-execution. |
| `Error.razor` | Error page rendered by exception handler middleware. |
| `Settings/Providers.razor` / `.razor.css` | Provider settings page for OpenAI account OAuth, OpenAI-compatible endpoints, model tests, defaults, API-key updates, and child model rows. |
| `Settings/Connections.razor` / `.razor.css` | Connection settings page for creating, editing, and deleting SSH/local shell terminal profiles, including shell-kind hints. |

### Connections/

| File | Description |
|------|-------------|
| `ConnectionSecretNames.cs` | Centralized secret key names for SSH passwords and private-key passphrases. |
| `ITerminalConnectionService.cs` / `TerminalConnectionService.cs` | Connection profile CRUD, validation, credential secret handling, and SSH host-key trust updates. |
| `TerminalConnectionModels.cs` | Service DTOs for connection drafts, shell-kind hints, secret status, and trusted SSH host-key metadata. |
| `IWorkspaceConnectionContext.cs` / `WorkspaceConnectionContext.cs` | App-process workspace-selected connection context shared by the UI and assistant note tools. |

### Notes/

| File | Description |
|------|-------------|
| `IConnectionNoteService.cs` / `ConnectionNoteService.cs` | Connection-scoped note CRUD service with title validation, unique default titles, and title-based agent operations. |
| `ConnectionNoteModels.cs` | Service DTOs for note summaries and full note details. |

### Llm/

| File | Description |
|------|-------------|
| `AgentOptions.cs` | Configurable agent/chat options for Codex request timeout, tool iterations, and terminal context/result limits. |
| `ChatClientFactory.cs` / `IChatClientFactory.cs` | Creates and tests Microsoft.Extensions.AI chat clients from persisted providers and effective credentials. |
| `CodexAuthService.cs` / `ICodexAuthService.cs` | OpenAI account OAuth PKCE flow, token refresh, revocation, and token secret persistence. |
| `CodexChatClient.cs` | Tool-aware `IChatClient` bridge to the Codex Responses SSE endpoint for account OAuth chat. |
| `CodexProvider.cs` | Constants and helpers for the OpenAI account provider and JWT account-id extraction. |
| `LlmProviderService.cs` / `ILlmProviderService.cs` | Provider CRUD, readiness snapshots, credential status, default-provider selection, and effective API-key/token resolution. |
| `SecretNames.cs` | Centralized secret key names for provider API keys and OAuth tokens. |
| `StreamingToolCallTracker.cs` | Tracks streamed tool-call start, argument deltas, and ready function-call content. |
| `ToolCallArguments.cs` | Helpers for preserving and parsing raw tool-call JSON arguments for manual invocation. |
| `ToolCallStreamingContent.cs` | Custom streaming AI content records for function-call start and argument-delta events. |

### Models/

| File | Description |
|------|-------------|
| `AssistantConversation.cs` | EF entity for the single persistent assistant conversation. |
| `AssistantMessage.cs` | EF entity and enums for transcript messages, tool-call manifests/results, roles, statuses, and errors. |
| `AuthType.cs` | Enum for provider authentication modes: none, API key, or OAuth. |
| `ConnectionNote.cs` | EF entity for persistent Markdown-style notes scoped to terminal connections. |
| `LlmProvider.cs` | EF entity for chat endpoint/model rows, default selection, child model credential inheritance, and readiness snapshots. |
| `OAuthToken.cs` | EF entity for OAuth token metadata; token values are stored through `ISecretStore`. |
| `StoredSecret.cs` | EF entity backing the first SQLite implementation of `ISecretStore`. |
| `TerminalConnection.cs` | EF entity and enums for SSH/local shell terminal profiles, connection kind, auth type, and shell-kind hints. |

### Persistence/

| File | Description |
|------|-------------|
| `AppDbContext.cs` | EF Core context for providers, OAuth metadata, terminal connections, stored secrets, and assistant transcripts; includes SQLite lock retry and model configuration. |
| `DatabaseMigrationBootstrapper.cs` | Migration bootstrapper that stamps existing `EnsureCreated` databases with the baseline migration before running EF migrations. |
| `PersistenceServiceCollectionExtensions.cs` | DI extension that wires `AppDbContext` to SQLite from configuration. |
| `SqliteConnectionSettings.cs` | SQLite connection-string builder and PRAGMA setup for busy timeout and WAL mode. |

### Persistence/Migrations/

| File | Description |
|------|-------------|
| `20260602000000_InitialSchema.cs` | EF baseline migration for the schema that existed before migration adoption. |
| `20260602001000_AddTerminalConnections.cs` | EF migration adding terminal connection profile storage. |
| `20260603000000_AddAssistantToolCallsAndShellKind.cs` | EF migration adding assistant tool transcript columns and terminal shell-kind hints. |
| `20260603001000_AddConnectionNotes.cs` | EF migration adding connection-scoped note storage with cascade deletion and per-connection unique titles. |
| `AppDbContextModelSnapshot.cs` | EF model snapshot for the current migrated schema. |

### Persistence/Repositories/

| File | Description |
|------|-------------|
| `ILlmProviderRepository.cs` / `LlmProviderRepository.cs` | EF repository for provider CRUD, lookup, and default selection. |
| `IOAuthTokenRepository.cs` / `OAuthTokenRepository.cs` | EF repository for OAuth token metadata replacement, lookup, and deletion. |
| `IAssistantConversationRepository.cs` / `AssistantConversationRepository.cs` | EF repository for the global assistant conversation and ordered transcript messages. |
| `ITerminalConnectionRepository.cs` / `TerminalConnectionRepository.cs` | EF repository for terminal connection CRUD, ordered listing, and default profile lookup. |
| `IConnectionNoteRepository.cs` / `ConnectionNoteRepository.cs` | EF repository for connection-scoped note listing, lookup, mutation, and persistence. |

### Terminal/

| File | Description |
|------|-------------|
| `ITerminalBackendSession.cs` | Common backend interface for local PTY and SSH terminal sessions. |
| `ITerminalSessionService.cs` / `TerminalSessionService.cs` | App-process terminal coordinator for persistent sessions, replayable UI output subscriptions, snapshots, command execution, elevation prompts, resize, and cleanup. |
| `LocalTerminalSession.cs` | Quick.PtyNet-backed local shell session with platform shell defaults and PTY cleanup. |
| `SshTerminalSession.cs` | SSH.NET-backed shell session with password/private-key auth, `xterm-256color`, resize, and host-key trust checks. |
| `TerminalSessionModels.cs` | Terminal DTOs for size, output, SSH host-key prompts, snapshots, command records/results, elevation prompts, connect results, and resolved SSH credentials. |

### Tokens/

| File | Description |
|------|-------------|
| `ITokenCounter.cs` / `CompositeTokenCounter.cs` | Reusable token counting abstraction; tries exact tiktoken counting first, then falls back to character estimation. |
| `TokenCountRequest.cs` / `TokenCountResult.cs` | Request/result records for model-or-encoding token counting with method, exactness, and warning metadata. |
| `TokenCountingOptions.cs` | Configurable default encoding, model-to-encoding mappings, and char-estimator ratio. |
| `TiktokenTokenCounter.cs` | Exact token counter backed by `Microsoft.ML.Tokenizers` tiktoken encodings. |
| `CharEstimateTokenCounter.cs` | Conservative fallback token counter based on character length. |

### Secrets/

| File | Description |
|------|-------------|
| `ISecretStore.cs` | Abstraction for named local secrets. |
| `SqliteSecretStore.cs` | First implementation of `ISecretStore`, storing named secret values in SQLite. |

### wwwroot/

| File | Description |
|------|-------------|
| `app.css` | App-wide CSS from the Blazor template. |
| `favicon.png` | Site/app icon from the Blazor template. |
| `lib/bootstrap/` | Vendored Bootstrap distribution used by first-slice UI. |
| `lib/xterm/` | Vendored xterm.js, fit addon, styles, sourcemaps, and license files for the terminal surface. |
