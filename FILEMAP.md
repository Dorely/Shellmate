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
| `Shellmate.csproj` | `net10.0` Blazor Web project with Electron.NET, EF Core SQLite, Microsoft.Extensions.AI, OpenAI SDK, runtime IDs, and warnings-as-errors. |
| `Program.cs` | App host setup: Electron mode detection/window launch, Blazor Interactive Server, DI wiring, SQLite `EnsureCreated`, OAuth endpoints, and routing. |
| `appsettings.json` / `appsettings.Development.json` | Configuration for logging, desktop binding, Codex OAuth redirect URI, SQLite connection string, Blazor hub size, and agent timeouts. |
| `Properties/launchSettings.json` | Local launch profiles for browser-hosted HTTP and Electron desktop mode on `localhost:1455`. |
| `Properties/electron-builder.json` | Electron/electron-builder packaging metadata for Windows, Linux, and macOS targets. |

### Auth/

| File | Description |
|------|-------------|
| `CodexOAuthEndpoints.cs` | Minimal API endpoints for starting and completing OpenAI account OAuth, then redirecting back to provider settings. |

### Chat/

| File | Description |
|------|-------------|
| `IAssistantChatService.cs` / `AssistantChatService.cs` | Persistent global assistant chat service with default-provider resolution, streaming responses, cancellation, reset, and transcript persistence. |
| `AssistantTurnUpdate.cs` | Streaming update records consumed by the chat page: text deltas, completion, and turn errors. |

### Components/

| File | Description |
|------|-------------|
| `App.razor` | Root HTML shell, static assets, Blazor script, and reconnect modal. |
| `Routes.razor` | Router setup using `MainLayout` and the NotFound page. |
| `_Imports.razor` | Shared Razor `@using` directives for components. |

### Components/Chat/

| File | Description |
|------|-------------|
| `ChatModels.cs` | UI-only chat transcript/live-turn models used by `ChatSurface`. |
| `ChatSurface.razor` / `.razor.css` / `.razor.js` | Reusable chat shell for transcript rendering, streaming state, composer autosize, enter-to-send, and scroll-follow behavior. |

### Components/Layout/

| File | Description |
|------|-------------|
| `MainLayout.razor` / `.razor.css` | Desktop-style app shell with left navigation and full-height content area. |
| `NavMenu.razor` / `.razor.css` | Sidebar navigation for Chat and Providers. |
| `ReconnectModal.razor` / `.razor.css` / `.razor.js` | Template reconnect UI shown when the SignalR circuit drops. |

### Components/Pages/

| File | Description |
|------|-------------|
| `Home.razor` / `.razor.css` | Chat route at `/` and `/chat`; loads/persists transcript, streams turns, supports reset and stop, and gates composer on a tested provider. |
| `NotFound.razor` | 404 page wired through status-code re-execution. |
| `Error.razor` | Error page rendered by exception handler middleware. |
| `Settings/Providers.razor` / `.razor.css` | Provider settings page for OpenAI account OAuth, OpenAI-compatible endpoints, model tests, defaults, API-key updates, and child model rows. |

### Llm/

| File | Description |
|------|-------------|
| `AgentOptions.cs` | Configurable agent/chat options currently used for Codex request timeout. |
| `ChatClientFactory.cs` / `IChatClientFactory.cs` | Creates and tests Microsoft.Extensions.AI chat clients from persisted providers and effective credentials. |
| `CodexAuthService.cs` / `ICodexAuthService.cs` | OpenAI account OAuth PKCE flow, token refresh, revocation, and token secret persistence. |
| `CodexChatClient.cs` | Minimal `IChatClient` bridge to the Codex Responses SSE endpoint for account OAuth chat. |
| `CodexProvider.cs` | Constants and helpers for the OpenAI account provider and JWT account-id extraction. |
| `LlmProviderService.cs` / `ILlmProviderService.cs` | Provider CRUD, readiness snapshots, credential status, default-provider selection, and effective API-key/token resolution. |
| `SecretNames.cs` | Centralized secret key names for provider API keys and OAuth tokens. |

### Models/

| File | Description |
|------|-------------|
| `AssistantConversation.cs` | EF entity for the single persistent assistant conversation. |
| `AssistantMessage.cs` | EF entity and enums for transcript messages, roles, statuses, and errors. |
| `AuthType.cs` | Enum for provider authentication modes: none, API key, or OAuth. |
| `LlmProvider.cs` | EF entity for chat endpoint/model rows, default selection, child model credential inheritance, and readiness snapshots. |
| `OAuthToken.cs` | EF entity for OAuth token metadata; token values are stored through `ISecretStore`. |
| `StoredSecret.cs` | EF entity backing the first SQLite implementation of `ISecretStore`. |

### Persistence/

| File | Description |
|------|-------------|
| `AppDbContext.cs` | EF Core context for providers, OAuth metadata, stored secrets, and assistant transcripts; includes SQLite lock retry and model configuration. |
| `PersistenceServiceCollectionExtensions.cs` | DI extension that wires `AppDbContext` to SQLite from configuration. |
| `SqliteConnectionSettings.cs` | SQLite connection-string builder and PRAGMA setup for busy timeout and WAL mode. |

### Persistence/Repositories/

| File | Description |
|------|-------------|
| `ILlmProviderRepository.cs` / `LlmProviderRepository.cs` | EF repository for provider CRUD, lookup, and default selection. |
| `IOAuthTokenRepository.cs` / `OAuthTokenRepository.cs` | EF repository for OAuth token metadata replacement, lookup, and deletion. |
| `IAssistantConversationRepository.cs` / `AssistantConversationRepository.cs` | EF repository for the global assistant conversation and ordered transcript messages. |

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
