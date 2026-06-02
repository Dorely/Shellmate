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
- .NET 10 Blazor Interactive Server for the application UI and local app host.
- Electron.NET for the desktop shell on Windows, Linux, and macOS.
- EF Core with SQLite for local persistence.
- `Microsoft.Extensions.AI`, `Microsoft.Extensions.AI.OpenAI`, and the OpenAI .NET SDK for chat-provider abstraction and OpenAI-compatible endpoints.
- Bootstrap is vendored by the Blazor template for first-slice UI styling.

## Architectural Overview
- Shellmate is desktop-first: normal user operation is through Electron, while browser-hosted development remains available for fast Codex and Playwright verification.
- The app runs a local-only ASP.NET Core host and stores local state in SQLite.
- AI provider metadata is stored separately from secrets. API keys and OAuth tokens flow through `ISecretStore`; the first implementation stores them in SQLite behind that abstraction.
- The current chat is a global persistent transcript with no remote-machine tools. Future SSH/remote-desktop features should add explicit connection-scoped services and permission boundaries rather than expanding hidden agent access.

## Project Structure
- `Shellmate/` contains the Blazor/Electron app.
- `Shellmate/Components/` contains Razor layout, pages, and reusable UI.
- `Shellmate/Chat/` contains the first persistent assistant chat service.
- `Shellmate/Llm/` contains provider configuration, OpenAI-compatible chat client creation, and OpenAI account OAuth support.
- `Shellmate/Persistence/` contains EF Core context, SQLite setup, and repositories.
- `Shellmate/Secrets/` contains the secret-store abstraction and SQLite-backed implementation.
- `Shellmate/Models/` contains EF entities and small domain enums.

## Code Style
- Use dependency injection for services and repositories.
- Configuration belongs in `appsettings.json` and environment variables.
- Keep UI components focused on interaction state; put persistence, provider resolution, and chat behavior in services.
- Do not store new secrets directly on feature entities. Add them through `ISecretStore`.
- Keep first-slice chat honest about implemented capability. Do not imply SSH, remote desktop, connection notes, or remote tools exist until they are implemented.

## Build & Run
```bash
dotnet build Shellmate.sln
dotnet run --project Shellmate
dotnet run --project Shellmate -- --electron
```

## Verification
- Do not add test projects or automated tests unless the user explicitly requests them.
- Verify normal changes with `dotnet build Shellmate.sln`.
- VS Code F5 is configured to build and debug the Electron desktop shell by default.
- When UI behavior changes, run the browser-hosted app and verify it with Playwright.
- When Electron behavior changes, start `dotnet run --project Shellmate -- --electron`, verify the window, and terminate the app. Never leave the app running.

## Conventions
- When you need to understand current wiring, start with `VISION.md`, then `Program.cs`, then the relevant feature area.
- Trace each requested change through its full impact area before considering the work complete. Changes to models, contracts, or core concepts should include all affected layers such as persistence, services, UI, and documentation.
- Remove superseded code and concepts when replacing them. Do not leave deprecated pages, components, handlers, prompts, queries, or other logic in place just because the new path works; clean out obsolete implementations and reduce unnecessary complexity.
- This is a local development project. When a requested change replaces a concept, remove the superseded implementation outright; do not add or retain compatibility shims, legacy handlers/fallbacks, deprecated tool aliases, or dual paths unless the user explicitly asks for a transition path.
