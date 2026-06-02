# Shellmate

Shellmate is a desktop-first, local Blazor/Electron application for building an LLM-enabled remote connection manager. The long-term product vision is a workspace that pairs remote sessions with an adjacent agent chat while keeping user control, permissions, and action visibility explicit.

## First Slice Status

Implemented now:

- .NET 10 Blazor Interactive Server app hosted by Electron.NET.
- Local SQLite persistence using EF Core.
- Provider configuration for OpenAI account OAuth and arbitrary OpenAI-compatible chat endpoints.
- SQLite-backed `ISecretStore` abstraction for API keys and OAuth tokens.
- Persistent global chat transcript with streaming responses, stop/cancel, reset, and default-provider gating.

Not implemented yet:

- SSH connection management.
- Remote desktop sessions.
- Per-connection notes.
- Agent tools that inspect or modify remote machines.
- Risk confirmations for remote actions.

## Requirements

- .NET 10 SDK.
- Node.js 22 or later for Electron.NET desktop builds.

## Build

```bash
dotnet build Shellmate.sln
```

## Browser Development

Run the local browser-hosted app:

```bash
dotnet run --project Shellmate
```

The HTTP launch profile is pinned to `http://localhost:1455` so OpenAI account OAuth callbacks can use the same local redirect URI as the desktop shell.

## Desktop Development

Run the Electron.NET desktop shell:

```bash
dotnet run --project Shellmate -- --electron
```

In VS Code, press F5 with the default `Shellmate Electron` launch configuration to build and debug the Electron desktop shell.

Desktop binding is configured in `Shellmate/appsettings.json` under `Desktop:BindHost` and `Desktop:HttpPort`. Override the port in PowerShell with:

```powershell
$env:Desktop__HttpPort = '1456'
dotnet run --project Shellmate -- --electron
```

Changing the port can break OpenAI account OAuth unless `Auth:Codex:RedirectUri` is also changed to an accepted redirect URI.

## Packaging

Electron package metadata lives in `Shellmate/Properties/electron-builder.json`. A local Windows folder publish can be produced with:

```bash
dotnet publish Shellmate/Shellmate.csproj -c Release -r win-x64 --self-contained
```

Cross-platform package creation may require building on the target OS depending on Electron/electron-builder support.

## Local Data

The local SQLite database stores provider metadata, chat transcripts, and first-slice secret values through `ISecretStore`. Database files are ignored by git.
