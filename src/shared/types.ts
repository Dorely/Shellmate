export type AccessMode = 'disabled' | 'ask' | 'autonomous';
export type ThemeName = 'graphite' | 'light' | 'forest';
export type ConnectionKind = 'ssh' | 'local';
export type ShellKind = 'auto' | 'posix' | 'powershell' | 'cmd';
export interface Workspace { id: string; name: string; webAccess: AccessMode; createdAt: string }
export interface ConnectionProfile {
  id: string; name: string; kind: ConnectionKind; host: string; port: number; username: string;
  auth: 'password' | 'key'; privateKeyPath: string; shell: ShellKind;
  localShellPath: string; localShellArgs: string; localCwd: string;
  trustedHostKey: string | null; createdAt: string; updatedAt: string;
}
export interface ConnectionInput extends Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt' | 'trustedHostKey'> {
  id?: string; password?: string; passphrase?: string;
  passwordAction?: 'keep' | 'replace' | 'remove'; passphraseAction?: 'keep' | 'replace' | 'remove';
}
export interface ConnectionSummary extends ConnectionProfile { hasPassword: boolean; hasPassphrase: boolean }
export interface Note { id: string; connectionId: string; title: string; content: string; updatedAt: string }
export interface Conversation { id: string; workspaceId: string; title: string; titleSource: 'default' | 'user' | 'assistant'; createdAt: string }
export interface WorkspaceConnectionAccess { connectionId: string; access: AccessMode }
export interface WebSource { url: string; title?: string }
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant' | 'tool'; text: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; createdAt: string; targetId?: string; toolName?: string; sources?: WebSource[] }
export interface TerminalOwnership { conversationId: string; phase: 'working' | 'command-running' | 'returning-control'; command?: string }
export type TerminalIntegration = 'pending' | 'ready' | 'unavailable' | 'unsupported';
export interface TerminalSnapshot { id: string; workspaceId: string; connectionId: string; connected: boolean; output: string; seq: number; shell: ShellKind; owner: TerminalOwnership | null; activeCommand: string | null; error: string | null; integration: TerminalIntegration; integrationDetail: string | null; busy: boolean; cwd: string | null; lastExitCode: number | null }
interface ApprovalBase { id: string; conversationId: string; workspaceId: string; createdAt: string }
export type ApprovalRequest = ApprovalBase & ({ kind: 'command'; connectionId: string; sessionId: string; command: string } | { kind: 'web'; action: 'search' | 'fetch'; detail: string })
export interface HostKeyRequest { id: string; workspaceId: string; connectionId: string; host: string; port: number; fingerprint: string; changed: boolean }
export interface ElevationRequest { id: string; sessionId: string; connectionId: string; command: string; prompt: string }
export type GenericProviderKind = 'chat-completions' | 'responses' | 'anthropic';
export interface ChatProviderEntry { id: string; label: string; baseUrl: string; kind: GenericProviderKind }
export type CapabilityFlag = true | false | 'unknown';
export interface ChatModelEntry { id: string; providerId: string; slug: string; efforts: string[]; maxTokens: number | null; contextLimit?: number; vision: CapabilityFlag; audio: CapabilityFlag; hostedSearch: string | null; effortResults: Record<string, 'pass' | 'fail'>; lastTestedAt: string; testError?: string }
export interface ActiveChatSelection { modelId: string; effort: string }
export interface ChatModelOption { id: string; label: string; providerLabel: string; slug: string; efforts: string[]; builtIn: boolean; hostedSearch: boolean; contextLimit: number }
export interface ModelCapabilityResult { perEffort: Record<string, 'pass' | 'fail'>; failedEfforts: string[]; maxTokens: number | null; vision: CapabilityFlag; audio: CapabilityFlag; hostedSearch: string | null; error?: string }
export type SearchBackendId = 'serpapi' | 'tavily';
export interface WebSearchStatus { backend: SearchBackendId | null; keys: Record<SearchBackendId, boolean> }
export interface ProviderStatus { codexReady: boolean; loginPending: boolean; secureStorageAvailable: boolean; error: string | null; chatModels: ChatModelOption[]; activeChat: ActiveChatSelection; providers: ChatProviderEntry[] }
export interface ChatContext { model: string; tokens: number; limit: number | null; includesHiddenReasoning: boolean; includesEstimatedMedia: boolean }
export interface Snapshot { theme: ThemeName; workspaces: Workspace[]; activeWorkspaceId: string; workspaceConnections: WorkspaceConnectionAccess[]; connections: ConnectionSummary[]; conversations: Conversation[]; messages: Message[]; terminals: TerminalSnapshot[]; approvals: ApprovalRequest[]; hostKeys: HostKeyRequest[]; elevations: ElevationRequest[]; providers: ProviderStatus; webSearch: WebSearchStatus; activeTurns: string[] }
export interface ShellmateApi {
  snapshot(): Promise<Snapshot>; chatContext(conversationId: string, draft: string): Promise<ChatContext>; setTheme(theme: ThemeName): Promise<void>;
  createWorkspace(name: string): Promise<Workspace>; renameWorkspace(id: string, name: string): Promise<void>; setActiveWorkspace(id: string): Promise<void>;
  createConversation(): Promise<string>; renameConversation(id: string, title: string): Promise<void>; setWorkspaceAccess(connectionId: string, access: AccessMode): Promise<void>; setWorkspaceWebAccess(access: AccessMode): Promise<void>;
  sendMessage(id: string, text: string): Promise<void>; cancelTurn(id: string): Promise<void>;
  saveConnection(input: ConnectionInput): Promise<ConnectionProfile>; deleteConnection(id: string): Promise<void>; setWorkspaceConnection(connectionId: string, included: boolean): Promise<void>;
  connect(connectionId: string): Promise<void>; disconnect(connectionId: string): Promise<void>; resize(connectionId: string, cols: number, rows: number): Promise<void>; write(connectionId: string, text: string): Promise<void>;
  takeOver(connectionId: string): Promise<void>; resolveApproval(id: string, allow: boolean): Promise<void>; trustHostKey(id: string, allow: boolean): Promise<void>; respondElevation(id: string, password: string | null): Promise<void>;
  listNotes(connectionId: string): Promise<Note[]>; saveNote(connectionId: string, note: { id?: string; title: string; content: string }): Promise<Note>; deleteNote(connectionId: string, noteId: string): Promise<void>;
  startLogin(): Promise<void>; cancelLogin(): Promise<void>; logout(): Promise<void>;
  saveChatProvider(input: { id?: string; label: string; baseUrl: string; kind: GenericProviderKind; apiKey?: string; keyAction?: 'keep' | 'replace' | 'remove' }): Promise<ChatProviderEntry>;
  deleteChatProvider(id: string): Promise<void>; listChatModels(providerId: string): Promise<string[]>; testChatModel(input: { providerId: string; slug: string; efforts: string[] }): Promise<ModelCapabilityResult>;
  saveChatModel(input: { id?: string; providerId: string; slug: string; efforts: string[]; contextLimit: number }): Promise<ChatModelEntry>; deleteChatModel(id: string): Promise<void>; setActiveChat(input: ActiveChatSelection): Promise<void>;
  saveWebSearch(input: { backend: SearchBackendId | null; apiKey?: string; keyAction?: 'keep' | 'replace' | 'remove' }): Promise<void>; testWebSearch(): Promise<number>; openExternal(url: string): Promise<void>;
  testCodexModel(slug: string): Promise<void>; saveCodexModel(input: { id?: string; slug: string }): Promise<void>; deleteCodexModel(id: string): Promise<void>;
  onChanged(callback: () => void): () => void; onTerminal(callback: (event: { id: string; seq: number; data: string }) => void): () => void;
}
declare global { interface Window { shellmate: ShellmateApi } }
