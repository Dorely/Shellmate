import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { SecureStore, secretName } from './providers/secrets';
import { CodexAuth } from './providers/auth';
import { ChatRegistry } from './chat-registry';
import { ChatService } from './chat-service';
import { WebSearchService } from './web-search';
import { TerminalManager } from './terminal';
import { DiagnosticLog, redactText } from './diagnostics';
import { diagnosticError } from './providers/errors';
import { startBrowserHost, type BrowserHost } from './browser-host';
import type { ConnectionInput, ConnectionProfile, Snapshot } from '../shared/types';

app.setName('Shellmate');
app.setPath('userData', join(app.getPath('appData'), 'Shellmate'));
const browserMode = !app.isPackaged && process.argv.includes('--browser');
let window: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
let quitting = false;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const changed = () => { if (notifyTimer) return; notifyTimer = setTimeout(() => { notifyTimer = null; if (window && !window.isDestroyed()) window.webContents.send('shellmate:changed'); browserHost?.changed(); }, 40); };
const safeError = (error: unknown) => redactText(error instanceof Error ? error.message : 'Operation failed.');
const themeBackgrounds = { graphite: '#15191f', light: '#f4f6fa', forest: '#151a19' } as const;
const id = z.uuid();
const string = z.string();
const connectionSchema = z.object({
  id: id.optional(), name: string.min(1).max(80), kind: z.enum(['ssh','local']), host: string.max(255), port: z.number().int().min(1).max(65535), username: string.max(255),
  auth: z.enum(['password','key']), privateKeyPath: string.max(4096), shell: z.enum(['auto','posix','powershell','cmd']), localShellPath: string.max(4096), localShellArgs: string.max(4096), localCwd: string.max(4096),
  password: string.optional(), passphrase: string.optional(), passwordAction: z.enum(['keep','replace','remove']).optional(), passphraseAction: z.enum(['keep','replace','remove']).optional()
});
const schemas: Record<string, z.ZodTypeAny> = {
  snapshot: z.tuple([]), chatContext: z.tuple([id,string]), setTheme: z.tuple([z.enum(['graphite','light','forest'])]),
  createWorkspace: z.tuple([string]), renameWorkspace: z.tuple([id,string]), setActiveWorkspace: z.tuple([id]),
  createConversation: z.tuple([]), renameConversation: z.tuple([id,string]), setWorkspaceAccess: z.tuple([id,z.enum(['disabled','ask','autonomous'])]), setWorkspaceWebAccess: z.tuple([z.enum(['disabled','ask','autonomous'])]),
  sendMessage: z.tuple([id,string]), cancelTurn: z.tuple([id]), saveConnection: z.tuple([connectionSchema]), deleteConnection: z.tuple([id]), setWorkspaceConnection: z.tuple([id,z.boolean()]),
  connect: z.tuple([id]), disconnect: z.tuple([id]), resize: z.tuple([id,z.number().int(),z.number().int()]), write: z.tuple([id,string]), takeOver: z.tuple([id]),
  resolveApproval: z.tuple([id,z.boolean()]), trustHostKey: z.tuple([id,z.boolean()]), respondElevation: z.tuple([id,string.nullable()]),
  listNotes: z.tuple([id]), saveNote: z.tuple([id,z.object({ id: id.optional(), title: string, content: string })]), deleteNote: z.tuple([id,id]),
  startLogin: z.tuple([]), cancelLogin: z.tuple([]), logout: z.tuple([]),
  saveChatProvider: z.tuple([z.object({ id: id.optional(), label: string, baseUrl: string, kind: z.enum(['chat-completions','responses','anthropic']), apiKey: string.optional(), keyAction: z.enum(['keep','replace','remove']).optional() })]),
  deleteChatProvider: z.tuple([id]), listChatModels: z.tuple([id]), testChatModel: z.tuple([z.object({ providerId: id, slug: string, efforts: z.array(string) })]),
  saveChatModel: z.tuple([z.object({ id: id.optional(), providerId: id, slug: string, efforts: z.array(string) })]), deleteChatModel: z.tuple([id]),
  setActiveChat: z.tuple([z.object({ modelId: string, effort: string })]),
  testCodexModel: z.tuple([string]), saveCodexModel: z.tuple([z.object({ id: string.optional(), slug: string })]), deleteCodexModel: z.tuple([string]),
  saveWebSearch: z.tuple([z.object({ backend: z.enum(['serpapi','tavily']).nullable(), apiKey: string.max(512).optional(), keyAction: z.enum(['keep','replace','remove']).optional() })]), testWebSearch: z.tuple([]),
  openExternal: z.tuple([z.url({ protocol: /^https?$/ }).max(4096)])
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    const profileRoot = app.getPath('userData'); await mkdir(profileRoot, { recursive: true });
    const diagnostics = new DiagnosticLog(profileRoot);
    const store = new Store(join(profileRoot, 'shellmate.sqlite'), changed);
    const secrets = new SecureStore({ directory: join(profileRoot, 'secrets'), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value), isAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text') });
    const auth = new CodexAuth({ store: secrets, openExternal: url => shell.openExternal(url), onChange: changed });
    let authError: string | null = null;
    try { await auth.initialize(); } catch (error) { authError = safeError(error); }
    const registry = new ChatRegistry(store, secrets);
    const terminal = new TerminalManager(store, secrets, changed, event => { if (window && !window.isDestroyed()) window.webContents.send('shellmate:terminal', event); browserHost?.terminal(event); });
    const webSearch = new WebSearchService(store, secrets);
    const chat = new ChatService(store, terminal, registry, auth, webSearch, changed, diagnostics);
    if (!store.conversations(store.activeWorkspaceId()).length) store.createConversation(store.activeWorkspaceId());
    const activeWorkspace = () => store.activeWorkspaceId();
    const snapshot = async (): Promise<Snapshot> => {
      const workspaceId = activeWorkspace();
      const connections = await Promise.all(store.connections().map(async profile => ({ ...profile,
        hasPassword: await secrets.get(secretName('ssh-password', profile.id)).then(Boolean).catch(() => false),
        hasPassphrase: await secrets.get(secretName('ssh-passphrase', profile.id)).then(Boolean).catch(() => false) })));
      const savedTheme = store.setting('ui-theme', 'graphite');
      const theme: Snapshot['theme'] = savedTheme === 'light' || savedTheme === 'forest' ? savedTheme : 'graphite';
      return { theme, workspaces: store.workspaces(), activeWorkspaceId: workspaceId, workspaceConnections: store.workspaceConnections(workspaceId), connections,
        conversations: store.conversations(workspaceId), messages: store.messages(workspaceId),
        terminals: terminal.snapshots(workspaceId), approvals: chat.approvals().filter(item => item.workspaceId === workspaceId), hostKeys: terminal.pendingHostKeys(), elevations: terminal.pendingElevations(),
        providers: { codexReady: auth.status.ready, loginPending: auth.status.pending, secureStorageAvailable: await secrets.available(), error: auth.status.error ?? authError,
          chatModels: registry.options(), activeChat: registry.activeSelection(), providers: registry.providers() }, webSearch: await webSearch.status(), activeTurns: chat.activeTurns() };
    };
    async function saveConnection(input: ConnectionInput): Promise<ConnectionProfile> {
      const old = input.id ? store.connection(input.id) : null;
      if (input.kind === 'ssh' && (!input.host.trim() || !input.username.trim())) throw new Error('SSH host and username are required.');
      const profile: ConnectionProfile = {
        id: old?.id ?? randomUUID(), name: input.name.trim(), kind: input.kind, host: input.host.trim(), port: input.port, username: input.username.trim(), auth: input.auth,
        privateKeyPath: input.privateKeyPath.trim(), shell: input.shell, localShellPath: input.localShellPath.trim(), localShellArgs: input.localShellArgs.trim(), localCwd: input.localCwd.trim(),
        trustedHostKey: old && old.host === input.host.trim() && old.port === input.port ? old.trustedHostKey : null,
        createdAt: old?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      for (const [kind, action, value] of [
        ['ssh-password', input.passwordAction ?? (input.password ? 'replace' : 'keep'), input.password],
        ['ssh-passphrase', input.passphraseAction ?? (input.passphrase ? 'replace' : 'keep'), input.passphrase]
      ] as const) {
        const key = secretName(kind, profile.id);
        if (action === 'replace') { if (!value) throw new Error('Enter a replacement credential.'); await secrets.set(key, value); }
        if (action === 'remove') await secrets.delete(key);
      }
      if (old) terminal.disconnectProfile(old.id);
      store.saveConnection(profile);
      if (!old) store.setWorkspaceConnection(activeWorkspace(), profile.id, true);
      return profile;
    }
    const handlers: Record<string, (...args: any[]) => unknown> = {
      snapshot, chatContext: (conversationId, draft) => chat.chatContext(conversationId, draft), setTheme: value => { store.setSetting('ui-theme', value); window?.setBackgroundColor(themeBackgrounds[value as keyof typeof themeBackgrounds]); },
      createWorkspace: name => { const item = store.createWorkspace(name); store.setActiveWorkspace(item.id); store.createConversation(item.id); return item; },
      renameWorkspace: (workspaceId, name) => store.renameWorkspace(workspaceId, name),
      setActiveWorkspace: workspaceId => { store.setActiveWorkspace(workspaceId); if (!store.conversations(workspaceId).length) store.createConversation(workspaceId); },
      createConversation: () => store.createConversation(activeWorkspace()).id, renameConversation: (conversationId, title) => store.renameConversation(conversationId, title),
      setWorkspaceAccess: (connectionId, access) => { const workspaceId = activeWorkspace(); if (!store.hasWorkspaceConnection(workspaceId, connectionId)) throw new Error('Connection is not in this workspace.'); chat.restrictWorkspaceAccess(workspaceId, connectionId, access); store.setWorkspaceAccess(workspaceId, connectionId, access); },
      setWorkspaceWebAccess: access => { const workspaceId = activeWorkspace(); chat.restrictWorkspaceWebAccess(workspaceId, access); store.setWorkspaceWebAccess(workspaceId, access); },
      sendMessage: (conversationId, text) => chat.sendMessage(conversationId, text), cancelTurn: conversationId => chat.cancelTurn(conversationId),
      saveConnection, deleteConnection: async connectionId => { terminal.disconnectProfile(connectionId); store.deleteConnection(connectionId); await secrets.delete(secretName('ssh-password', connectionId)); await secrets.delete(secretName('ssh-passphrase', connectionId)); },
      setWorkspaceConnection: (connectionId, included) => { const workspaceId = activeWorkspace(); if (!included) { chat.restrictWorkspaceAccess(workspaceId, connectionId, null); terminal.disconnect(workspaceId, connectionId, true); } store.setWorkspaceConnection(workspaceId, connectionId, included); },
      connect: connectionId => terminal.connect(activeWorkspace(), connectionId), disconnect: connectionId => terminal.disconnect(activeWorkspace(), connectionId),
      resize: (connectionId, cols, rows) => terminal.resize(activeWorkspace(), connectionId, cols, rows), write: (connectionId, value) => terminal.write(activeWorkspace(), connectionId, value),
      takeOver: connectionId => { const conversationId = terminal.takeOver(activeWorkspace(), connectionId); if (conversationId) chat.cancelTurn(conversationId); },
      resolveApproval: (approvalId, allow) => chat.resolveApproval(approvalId, allow), trustHostKey: async (requestId, allow) => { const request = terminal.trustHostKey(requestId, allow); if (allow && store.hasWorkspaceConnection(request.workspaceId, request.connectionId)) await terminal.connect(request.workspaceId, request.connectionId); },
      respondElevation: (requestId, password) => terminal.respondElevation(requestId, password),
      listNotes: connectionId => store.notes(connectionId), saveNote: (connectionId, note) => store.saveNote(connectionId, note), deleteNote: (connectionId, noteId) => store.deleteNote(connectionId, noteId),
      startLogin: () => auth.startLogin(), cancelLogin: () => auth.cancelLogin(), logout: () => auth.logout(),
      saveChatProvider: input => registry.saveProvider(input), deleteChatProvider: providerId => registry.deleteProvider(providerId), listChatModels: providerId => registry.listModels(providerId),
      testChatModel: input => registry.testModel(input), saveChatModel: input => registry.saveModel(input), deleteChatModel: modelId => registry.deleteModel(modelId),
      setActiveChat: input => registry.setActive(input.modelId, input.effort),
      testCodexModel: slug => registry.testCodexModel(slug, auth), saveCodexModel: input => registry.saveCodexModel(input, auth), deleteCodexModel: modelId => registry.deleteCodexModel(modelId),
      saveWebSearch: async input => { await webSearch.save(input); changed(); }, testWebSearch: () => webSearch.test(),
      openExternal: url => shell.openExternal(new URL(url).toString())
    };
    const invoke = async (method: unknown, rawArgs: unknown): Promise<unknown> => {
      if (quitting) throw new Error('Shellmate is closing.');
      if (typeof method !== 'string' || !Object.hasOwn(schemas, method)) throw new Error('Unknown application operation.');
      const parsed = schemas[method].safeParse(rawArgs); if (!parsed.success) throw new Error('Invalid operation arguments.');
      try { return await handlers[method](...(parsed.data as unknown[])); } catch (error) {
        const reference = diagnostics.record('operation.failed', { method, error: diagnosticError(error) });
        throw new Error(`${safeError(error)}${reference ? ` (diagnostic ${reference})` : ''}`);
      }
    };
    ipcMain.handle('shellmate:call', async (event, method: unknown, rawArgs: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted application request.');
      return invoke(method, rawArgs);
    });
    if (browserMode) {
      browserHost = await startBrowserHost(join(__dirname, '../renderer'), invoke);
      process.stdout.write(`Shellmate browser: ${browserHost.url}\n`);
    } else {
      const startupBackground = themeBackgrounds[store.setting('ui-theme', 'graphite') as keyof typeof themeBackgrounds] ?? themeBackgrounds.graphite;
      window = new BrowserWindow({ width: 1500, height: 960, minWidth: 950, minHeight: 650, title: 'Shellmate', show: false, backgroundColor: startupBackground, webPreferences: {
        preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
      } });
      window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
      window.on('ready-to-show', () => window?.show());
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      if (!app.isPackaged && devUrl) await window.loadURL(devUrl); else await window.loadFile(join(__dirname, '../renderer/index.html'));
      app.on('window-all-closed', () => app.quit());
    }
    diagnostics.record('app.started', { version: app.getVersion(), packaged: app.isPackaged, browserMode });
    app.on('before-quit', event => {
      if (quitting) return; event.preventDefault(); quitting = true;
      void Promise.all([chat.shutdown(), auth.cancelLogin(), browserHost?.close()]).finally(() => { terminal.shutdown(); if (notifyTimer) clearTimeout(notifyTimer); store.close(); app.quit(); });
    });
  }).catch(error => { dialog.showErrorBox('Shellmate could not start', safeError(error)); app.exit(1); });
}
