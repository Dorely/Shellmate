# Source provenance

Shellmate's Electron/React foundation and provider/chat implementation were adapted from the neighboring SfxChat repository at commit `7f0038d7a821a1649b3c932f6baf1fb2d9ce0d52` (inspected 2026-09-24). The source repository's MIT license is retained in [LICENSE](../LICENSE).

Copied or adapted source areas include `src/shared/chat-models.ts`, `src/main/chat-registry.ts`, `chat-context.ts`, `diagnostics.ts`, `src/main/providers/{auth,codex,errors,secrets}.ts`, `src/main/providers/generic/`, and the Electron/Vite/TypeScript configuration. Shellmate's store, terminal manager, assistant tools, runtime orchestration, and UI were written for its remote-connection domain. SfxChat's media generation, asset library, and music code were not copied.

Provider model lists, capability checks, and account APIs are time-sensitive. Runtime integrations still require live validation with configured accounts and servers; copying an adapter does not establish access or compatibility.
