import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AccessMode, ConnectionProfile, Conversation, Message, Note, Workspace, WorkspaceConnectionAccess } from '../shared/types';

const now = () => new Date().toISOString();
const decode = <T>(row: unknown): T => JSON.parse((row as { json: string }).json) as T;
const name = (value: string, max = 80) => {
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`A name between 1 and ${max} characters is required.`);
  return result;
};

export class Store {
  readonly db: Database.Database;
  constructor(filename: string, private readonly changed: () => void = () => {}) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 3) { this.db.close(); throw new Error('This Shellmate database needs a newer application.'); }
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE connections (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE workspace_connections (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, access TEXT NOT NULL DEFAULT 'ask', PRIMARY KEY(workspace_id, connection_id));
        CREATE TABLE notes (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, title_key TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(connection_id,title_key));
        CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), json TEXT NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, json TEXT NOT NULL);
        CREATE TABLE tool_calls (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, name TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, result TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE turns (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, status TEXT NOT NULL);
        PRAGMA user_version = 3;
      `);
      const workspace: Workspace = { id: randomUUID(), name: 'Default', webAccess: 'ask', createdAt: now() };
      this.db.prepare('INSERT INTO workspaces VALUES (?,?)').run(workspace.id, JSON.stringify(workspace));
      this.db.prepare('INSERT INTO settings VALUES (?,?)').run('workspace-active', workspace.id);
    })();
    if (version === 1) this.db.transaction(() => {
      this.db.exec("ALTER TABLE workspace_connections ADD COLUMN access TEXT NOT NULL DEFAULT 'ask'");
      this.db.exec("UPDATE workspace_connections SET access='disabled' WHERE EXISTS (SELECT 1 FROM targets t JOIN conversations c ON c.id=t.conversation_id WHERE c.workspace_id=workspace_connections.workspace_id AND t.connection_id=workspace_connections.connection_id AND t.access='disabled')");
      this.db.exec('DROP TABLE targets');
      this.db.pragma('user_version = 2');
    })();
    if (version > 0 && version < 3) this.db.transaction(() => {
      for (const workspace of this.workspaces()) this.db.prepare('UPDATE workspaces SET json=? WHERE id=?').run(JSON.stringify({ ...workspace, webAccess: 'ask' }), workspace.id);
      const models: unknown = JSON.parse(this.setting('chat-models', '[]'));
      if (Array.isArray(models)) this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('chat-models', JSON.stringify(models.map(model => ({ ...model, hostedSearch: null }))));
      this.db.pragma('user_version = 3');
    })();
    this.recover();
  }
  close() { this.db.close(); }
  setting(key: string, fallback = ''): string { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value ?? fallback; }
  setSetting(key: string, value: string) { this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); this.changed(); }
  recover() {
    this.db.prepare("UPDATE tool_calls SET status='uncertain', result=? WHERE status='running'").run(JSON.stringify({ error: 'Tool outcome is uncertain after restart; it was not replayed.' }));
    this.db.prepare("UPDATE turns SET status='interrupted' WHERE status='running'").run();
    const rows = this.db.prepare('SELECT json FROM messages').all();
    for (const row of rows) {
      const message = decode<Message>(row);
      if (message.status === 'running') { message.status = 'cancelled'; message.text += '\nTurn interrupted by application restart.'; this.updateMessage(message); }
    }
  }
  workspaces(): Workspace[] { return this.db.prepare('SELECT json FROM workspaces ORDER BY rowid').all().map(decode<Workspace>); }
  workspace(id: string): Workspace { const row = this.db.prepare('SELECT json FROM workspaces WHERE id=?').get(id); if (!row) throw new Error('Workspace not found.'); return decode<Workspace>(row); }
  activeWorkspaceId(): string { return this.setting('workspace-active', this.workspaces()[0]?.id); }
  setActiveWorkspace(id: string) { this.workspace(id); this.setSetting('workspace-active', id); }
  createWorkspace(raw: string): Workspace {
    const workspace: Workspace = { id: randomUUID(), name: name(raw, 60), webAccess: 'ask', createdAt: now() };
    this.db.prepare('INSERT INTO workspaces VALUES (?,?)').run(workspace.id, JSON.stringify(workspace)); this.changed(); return workspace;
  }
  renameWorkspace(id: string, raw: string) { const workspace = this.workspace(id); workspace.name = name(raw, 60); this.db.prepare('UPDATE workspaces SET json=? WHERE id=?').run(JSON.stringify(workspace), id); this.changed(); }
  setWorkspaceWebAccess(id: string, access: AccessMode) { const workspace = this.workspace(id); workspace.webAccess = access; this.db.prepare('UPDATE workspaces SET json=? WHERE id=?').run(JSON.stringify(workspace), id); this.changed(); }
  connections(): ConnectionProfile[] { return this.db.prepare('SELECT json FROM connections ORDER BY rowid').all().map(decode<ConnectionProfile>); }
  connection(id: string): ConnectionProfile { const row = this.db.prepare('SELECT json FROM connections WHERE id=?').get(id); if (!row) throw new Error('Connection not found.'); return decode<ConnectionProfile>(row); }
  saveConnection(profile: ConnectionProfile) {
    this.db.prepare('INSERT INTO connections(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(profile.id, JSON.stringify(profile)); this.changed();
  }
  deleteConnection(id: string) { this.connection(id); this.db.prepare('DELETE FROM connections WHERE id=?').run(id); this.changed(); }
  workspaceConnections(workspaceId: string): WorkspaceConnectionAccess[] { this.workspace(workspaceId); return this.db.prepare('SELECT connection_id as connectionId, access FROM workspace_connections WHERE workspace_id=? ORDER BY rowid').all(workspaceId) as WorkspaceConnectionAccess[]; }
  hasWorkspaceConnection(workspaceId: string, connectionId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM workspace_connections WHERE workspace_id=? AND connection_id=?').get(workspaceId, connectionId)); }
  setWorkspaceConnection(workspaceId: string, connectionId: string, included: boolean) {
    this.workspace(workspaceId); this.connection(connectionId);
    this.db.transaction(() => {
      if (included) this.db.prepare('INSERT OR IGNORE INTO workspace_connections(workspace_id,connection_id) VALUES (?,?)').run(workspaceId, connectionId);
      else {
        this.db.prepare('DELETE FROM workspace_connections WHERE workspace_id=? AND connection_id=?').run(workspaceId, connectionId);
      }
    })(); this.changed();
  }
  workspaceAccess(workspaceId: string, connectionId: string): AccessMode | null {
    return (this.db.prepare('SELECT access FROM workspace_connections WHERE workspace_id=? AND connection_id=?').get(workspaceId, connectionId) as { access: AccessMode } | undefined)?.access ?? null;
  }
  setWorkspaceAccess(workspaceId: string, connectionId: string, access: AccessMode) {
    if (!this.hasWorkspaceConnection(workspaceId, connectionId)) throw new Error('Connection is not in this workspace.');
    this.db.prepare('UPDATE workspace_connections SET access=? WHERE workspace_id=? AND connection_id=?').run(access, workspaceId, connectionId); this.changed();
  }
  conversations(workspaceId: string): Conversation[] { this.workspace(workspaceId); return this.db.prepare('SELECT json FROM conversations WHERE workspace_id=? ORDER BY rowid').all(workspaceId).map(decode<Conversation>); }
  conversation(id: string): Conversation { const row = this.db.prepare('SELECT json FROM conversations WHERE id=?').get(id); if (!row) throw new Error('Conversation not found.'); return decode<Conversation>(row); }
  createConversation(workspaceId: string): Conversation {
    this.workspace(workspaceId);
    const value: Conversation = { id: randomUUID(), workspaceId, title: 'New conversation', titleSource: 'default', createdAt: now() };
    this.db.prepare('INSERT INTO conversations VALUES (?,?,?)').run(value.id, workspaceId, JSON.stringify(value)); this.setActiveConversation(value.id); return value;
  }
  /** The workspace's remembered conversation, falling back to its newest one. */
  activeConversationId(workspaceId: string): string | null {
    const saved = this.setting(`conversation-active/${workspaceId}`);
    const ids = this.conversations(workspaceId).map(item => item.id);
    return ids.includes(saved) ? saved : ids.at(-1) ?? null;
  }
  setActiveConversation(id: string) { this.setSetting(`conversation-active/${this.conversation(id).workspaceId}`, id); }
  deleteConversation(id: string) {
    this.conversation(id);
    this.db.transaction(() => { this.db.prepare('DELETE FROM conversations WHERE id=?').run(id); this.db.prepare('DELETE FROM settings WHERE key=?').run(`history/${id}`); })(); this.changed();
  }
  renameConversation(id: string, raw: string, source: Conversation['titleSource'] = 'user') {
    const value = this.conversation(id); value.title = name(raw, 70); value.titleSource = source;
    this.db.prepare('UPDATE conversations SET json=? WHERE id=?').run(JSON.stringify(value), id); this.changed();
  }
  /** Drops a user title so the assistant names the conversation again. */
  releaseConversationTitle(id: string) {
    const value = this.conversation(id);
    if (value.titleSource !== 'user') return;
    const started = Boolean(this.db.prepare('SELECT 1 FROM messages WHERE conversation_id=?').get(id));
    if (!started) value.title = 'New conversation';
    value.titleSource = started ? 'assistant' : 'default';
    this.db.prepare('UPDATE conversations SET json=? WHERE id=?').run(JSON.stringify(value), id); this.changed();
  }
  titleConversation(id: string, text: string) { const value = this.conversation(id); if (value.titleSource === 'default') this.renameConversation(id, text.trim().slice(0, 65) || 'New conversation', 'default'); }
  messages(workspaceId: string): Message[] { this.workspace(workspaceId); return this.db.prepare('SELECT json FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id=?) ORDER BY rowid').all(workspaceId).map(decode<Message>); }
  conversationMessages(conversationId: string): Message[] { this.conversation(conversationId); return this.db.prepare('SELECT json FROM messages WHERE conversation_id=? ORDER BY rowid').all(conversationId).map(decode<Message>); }
  addMessage(conversationId: string, role: Message['role'], text: string, status: Message['status'] = 'completed', targetId?: string, toolName?: string): Message {
    this.conversation(conversationId);
    const message: Message = { id: randomUUID(), conversationId, role, text, status, createdAt: now(), targetId, toolName };
    this.db.prepare('INSERT INTO messages VALUES (?,?,?)').run(message.id, conversationId, JSON.stringify(message)); this.changed(); return message;
  }
  deleteMessage(id: string) { this.db.prepare('DELETE FROM messages WHERE id=?').run(id); this.changed(); }
  updateMessage(message: Message) { this.db.prepare('UPDATE messages SET json=? WHERE id=?').run(JSON.stringify(message), message.id); this.changed(); }
  setTurn(conversationId: string, status: string) { this.db.prepare('INSERT INTO turns VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET status=excluded.status').run(conversationId, status); this.changed(); }
  toolCall(id: string): { id: string; conversationId: string; name: string; args: string; status: string; result: string | null } | null {
    const row = this.db.prepare('SELECT id,conversation_id as conversationId,name,args,status,result FROM tool_calls WHERE id=?').get(id);
    return (row as ReturnType<Store['toolCall']>) ?? null;
  }
  startTool(id: string, conversationId: string, toolName: string, args: string) {
    this.db.prepare('INSERT INTO tool_calls(id,conversation_id,name,args,status,result) VALUES (?,?,?,?,?,NULL)').run(id, conversationId, toolName, args, 'running'); this.changed();
  }
  finishTool(id: string, result: string, status = 'completed') { this.db.prepare('UPDATE tool_calls SET status=?,result=? WHERE id=?').run(status, result, id); this.changed(); }
  notes(connectionId: string): Note[] { this.connection(connectionId); return this.db.prepare('SELECT json FROM notes WHERE connection_id=? ORDER BY rowid').all(connectionId).map(decode<Note>); }
  note(connectionId: string, id: string): Note { const row = this.db.prepare('SELECT json FROM notes WHERE id=? AND connection_id=?').get(id, connectionId); if (!row) throw new Error('Note not found.'); return decode<Note>(row); }
  saveNote(connectionId: string, raw: { id?: string; title: string; content: string }): Note {
    this.connection(connectionId);
    const title = name(raw.title, 120);
    if (raw.content.length > 100_000) throw new Error('Note is too long.');
    const id = raw.id ?? randomUUID(); if (raw.id) this.note(connectionId, id);
    const note: Note = { id, connectionId, title, content: raw.content, updatedAt: now() };
    this.db.prepare('INSERT INTO notes(id,connection_id,title_key,json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET title_key=excluded.title_key,json=excluded.json').run(id, connectionId, title.toLocaleLowerCase(), JSON.stringify(note));
    this.changed(); return note;
  }
  deleteNote(connectionId: string, noteId: string) { this.note(connectionId, noteId); this.db.prepare('DELETE FROM notes WHERE id=?').run(noteId); this.changed(); }
}
