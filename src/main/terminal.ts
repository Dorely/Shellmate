import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import { Client, type ClientChannel } from 'ssh2';
import type { ConnectionProfile, ElevationRequest, HostKeyRequest, ShellKind, TerminalOwnership, TerminalSnapshot } from '../shared/types';
import type { SecureStore } from './providers/secrets';
import { secretName } from './providers/secrets';
import type { Store } from './store';

type Backend = { write(data: string): void; resize(cols: number, rows: number): void; close(): void };
type Command = { id: string; text: string; started: number; capture: string; resolve: (result: CommandResult) => void; completed: Promise<CommandResult> };
export interface CommandResult { id: string; status: 'completed' | 'failed' | 'running' | 'interrupted'; exitCode: number | null; output: string; truncated: boolean }
type Session = { id: string; workspaceId: string; connectionId: string; shell: ShellKind; backend: Backend; output: string; seq: number; owner: TerminalOwnership | null; command: Command | null; turnFinished: boolean; error: string | null; elevation: ElevationRequest | null; manualBusy: boolean };
const OUTPUT_LIMIT = 160_000;
const COMMAND_LIMIT = 32_000;
const limit = (text: string, count: number) => text.length > count ? text.slice(-count) : text;
const plain = (text: string) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '').replace(/\r\n?/g, '\n');

function resolvedShell(profile: ConnectionProfile): ShellKind {
  if (profile.shell !== 'auto') return profile.shell;
  if (profile.kind === 'ssh') return 'posix';
  const executable = profile.localShellPath.toLowerCase();
  if (executable.includes('powershell') || executable.includes('pwsh')) return 'powershell';
  if (executable.includes('cmd')) return 'cmd';
  return process.platform === 'win32' ? 'powershell' : 'posix';
}
function wrapper(shell: ShellKind, text: string, id: string): string {
  const start = `__SHELLMATE_START_${id}__`;
  const end = `__SHELLMATE_END_${id}__`;
  if (shell === 'powershell') {
    const escaped = text.replace(/'/g, "''");
    return `Write-Output '${start}'; $global:LASTEXITCODE=$null; try { & ([scriptblock]::Create('${escaped}')); $__sm_code=if($LASTEXITCODE -is [int]){$LASTEXITCODE}elseif($?){0}else{1} } catch { Write-Error $_; $__sm_code=1 }; Write-Output ('${end}:'+$__sm_code)\r`;
  }
  if (shell === 'cmd') {
    const command = text.replace(/\r?\n/g, ' & ');
    return `echo ${start}\r${command}\rset "__sm_code=%ERRORLEVEL%"\rcall echo ${end}:%%__sm_code%%\r`;
  }
  const delimiter = `__SHELLMATE_SCRIPT_${id}__`;
  const body = text.replace(/\r\n?/g, '\n');
  if (body.split('\n').includes(delimiter)) throw new Error('Command contains a reserved shell delimiter.');
  return `__sm_file="$(mktemp)"; chmod 700 "$__sm_file"; cat > "$__sm_file" <<'${delimiter}'\n${body}\n${delimiter}\nprintf '\\n${start}\\n'; sh "$__sm_file"; __sm_code=$?; rm -f "$__sm_file"; printf '\\n${end}:%s\\n' "$__sm_code"\n`;
}
function commandStatus(capture: string, id: string): { output: string; exitCode: number } | null {
  const output = plain(capture);
  const start = output.indexOf(`\n__SHELLMATE_START_${id}__\n`);
  const endPattern = new RegExp(`\\n__SHELLMATE_END_${id}__:(\\d+)\\n`);
  if (start < 0) return null;
  const afterStart = start + `\n__SHELLMATE_START_${id}__\n`.length;
  const rest = output.slice(afterStart);
  const end = endPattern.exec(rest);
  if (!end) return null;
  return { output: rest.slice(0, end.index).trim(), exitCode: Number(end[1]) };
}

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private connecting = new Map<string, Promise<TerminalSnapshot>>();
  private hostKeys = new Map<string, HostKeyRequest>();
  constructor(private store: Store, private secrets: SecureStore, private changed: () => void, private onOutput: (event: { id: string; seq: number; data: string }) => void) {}
  private key(workspaceId: string, connectionId: string) { return `${workspaceId}:${connectionId}`; }
  session(workspaceId: string, connectionId: string): Session | null { return this.sessions.get(this.key(workspaceId, connectionId)) ?? null; }
  snapshots(workspaceId: string): TerminalSnapshot[] { return [...this.sessions.values()].filter(s => s.workspaceId === workspaceId).map(s => this.snapshot(s)); }
  snapshot(s: Session): TerminalSnapshot { return { id: s.id, workspaceId: s.workspaceId, connectionId: s.connectionId, connected: true, output: s.output, seq: s.seq, shell: s.shell, owner: s.owner, activeCommand: s.command?.text ?? null, error: s.error }; }
  pendingHostKeys(): HostKeyRequest[] { return [...this.hostKeys.values()]; }
  pendingElevations(): ElevationRequest[] { return [...this.sessions.values()].flatMap(s => s.elevation ? [s.elevation] : []); }
  async connect(workspaceId: string, connectionId: string): Promise<TerminalSnapshot> {
    if (!this.store.hasWorkspaceConnection(workspaceId, connectionId)) throw new Error('Connection is not in this workspace.');
    const existing = this.session(workspaceId, connectionId); if (existing) return this.snapshot(existing);
    const key = this.key(workspaceId, connectionId);
    const pending = this.connecting.get(key); if (pending) return pending;
    const opening = this.connectFresh(workspaceId, connectionId).finally(() => { this.connecting.delete(key); });
    this.connecting.set(key, opening);
    return opening;
  }
  private async connectFresh(workspaceId: string, connectionId: string): Promise<TerminalSnapshot> {
    const profile = this.store.connection(connectionId);
    const shell = resolvedShell(profile);
    let session: Session | null = null;
    let earlyOutput = '';
    let earlyClose: string | null = null;
    const output = (data: string) => { if (session) this.receive(session, data); else earlyOutput += data; };
    const closed = (reason: string) => { if (session) this.exited(workspaceId, connectionId, reason); else earlyClose = reason; };
    const backend = profile.kind === 'local' ? this.openLocal(profile, output, closed) : await this.openSsh(workspaceId, profile, output, closed);
    if (earlyClose || !this.store.hasWorkspaceConnection(workspaceId, connectionId) || this.store.connection(connectionId).updatedAt !== profile.updatedAt) {
      backend.close(); throw new Error(earlyClose ?? 'Connection changed while opening. Connect again.');
    }
    session = { id: randomUUID(), workspaceId, connectionId, shell, backend, output: '', seq: 0, owner: null, command: null, turnFinished: false, error: null, elevation: null, manualBusy: false };
    this.sessions.set(this.key(workspaceId, connectionId), session); this.changed();
    if (earlyOutput) this.receive(session, earlyOutput);
    return this.snapshot(session);
  }
  private openLocal(profile: ConnectionProfile, output: (data: string) => void, closed: (reason: string) => void): Backend {
    const command = profile.localShellPath.trim() || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh');
    const args = profile.localShellArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(value => value.replace(/^"|"$/g, '')) ?? [];
    const terminal = pty.spawn(command, args, { cols: 100, rows: 30, cwd: profile.localCwd.trim() || homedir(), env: { ...process.env, TERM: 'xterm-256color' } });
    terminal.onData(output);
    terminal.onExit(() => closed('Local shell exited.'));
    return { write: data => terminal.write(data), resize: (cols, rows) => terminal.resize(cols, rows), close: () => terminal.kill() };
  }
  private async openSsh(workspaceId: string, profile: ConnectionProfile, output: (data: string) => void, closed: (reason: string) => void): Promise<Backend> {
    const client = new Client(); let offered: string | null = null;
    const credential = profile.auth === 'password' ? await this.secrets.get(secretName('ssh-password', profile.id)) : await this.secrets.get(secretName('ssh-passphrase', profile.id));
    if (profile.auth === 'password' && !credential) throw new Error('Set this connection’s SSH password before connecting.');
    if (profile.auth === 'key' && !profile.privateKeyPath) throw new Error('Choose a private key file.');
    const privateKey = profile.auth === 'key' ? await readFile(profile.privateKeyPath) : undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve); client.once('error', reject);
        client.connect({ host: profile.host, port: profile.port, username: profile.username, password: profile.auth === 'password' ? credential ?? undefined : undefined,
          privateKey, passphrase: profile.auth === 'key' ? credential ?? undefined : undefined, readyTimeout: 20_000, keepaliveInterval: 15_000,
          hostHash: 'sha256', hostVerifier: (hash: string | Buffer) => { offered = String(hash); return profile.trustedHostKey === offered; } });
      });
      const stream = await new Promise<ClientChannel>((resolve, reject) => client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (error, channel) => error ? reject(error) : resolve(channel)));
      stream.on('data', (data: Buffer) => output(data.toString('utf8')));
      stream.stderr.on('data', (data: Buffer) => output(data.toString('utf8')));
      stream.on('close', () => { client.end(); closed('SSH shell closed.'); });
      client.on('close', () => closed('SSH connection closed.'));
      return { write: data => { stream.write(data); }, resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0), close: () => { stream.close(); client.end(); } };
    } catch (error) {
      client.end();
      if (offered && offered !== profile.trustedHostKey) {
        const request: HostKeyRequest = { id: randomUUID(), workspaceId, connectionId: profile.id, host: profile.host, port: profile.port, fingerprint: offered, changed: Boolean(profile.trustedHostKey) };
        this.hostKeys.set(request.id, request); this.changed();
        throw new Error(`SSH host key trust required for ${profile.name}. Review the fingerprint shown in the app.`);
      }
      throw error;
    }
  }
  trustHostKey(id: string, allow: boolean): HostKeyRequest {
    const request = this.hostKeys.get(id); if (!request) throw new Error('Host-key request expired.');
    this.hostKeys.delete(id);
    if (allow) { const profile = this.store.connection(request.connectionId); if (profile.host !== request.host || profile.port !== request.port) throw new Error('Connection changed while awaiting host-key trust.'); profile.trustedHostKey = request.fingerprint; profile.updatedAt = new Date().toISOString(); this.store.saveConnection(profile); }
    this.changed(); return request;
  }
  private exited(workspaceId: string, connectionId: string, reason: string) {
    const key = this.key(workspaceId, connectionId); const s = this.sessions.get(key); if (!s) return;
    this.sessions.delete(key); s.error = reason; if (s.command) s.command.resolve({ id: s.command.id, status: 'interrupted', exitCode: null, output: '', truncated: false }); this.changed();
  }
  disconnect(workspaceId: string, connectionId: string, force = false) {
    const s = this.session(workspaceId, connectionId); if (!s) return;
    if (s.owner && s.owner.phase !== 'returning-control' && !force) throw new Error('Take over this terminal before disconnecting.');
    this.sessions.delete(this.key(workspaceId, connectionId)); s.backend.close();
    if (s.command) s.command.resolve({ id: s.command.id, status: 'interrupted', exitCode: null, output: '', truncated: false }); this.changed();
  }
  disconnectProfile(connectionId: string) { for (const s of [...this.sessions.values()]) if (s.connectionId === connectionId) this.disconnect(s.workspaceId, connectionId, true); }
  shutdown() { for (const s of [...this.sessions.values()]) this.disconnect(s.workspaceId, s.connectionId, true); }
  resize(workspaceId: string, connectionId: string, cols: number, rows: number) {
    const s = this.session(workspaceId, connectionId); if (!s) throw new Error('Terminal is disconnected.');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 500 || rows > 300) throw new Error('Invalid terminal dimensions.');
    s.backend.resize(cols, rows);
  }
  write(workspaceId: string, connectionId: string, data: string) {
    const s = this.session(workspaceId, connectionId); if (!s) throw new Error('Terminal is disconnected.');
    if (s.owner) throw new Error('Agent controls this terminal. Use Take over first.');
    if (!data || data.length > 16_000) throw new Error('Invalid terminal input.');
    if (data.includes('\r') || data.includes('\n')) s.manualBusy = true;
    s.backend.write(data);
  }
  acquire(workspaceId: string, connectionId: string, conversationId: string): Session {
    const s = this.session(workspaceId, connectionId); if (!s) throw new Error('Connect this terminal first.');
    if (s.owner && s.owner.conversationId !== conversationId) throw new Error('Terminal is in use by another conversation.');
    if (s.manualBusy && !s.owner) throw new Error('The user’s terminal command may still be running. Wait for its prompt or reconnect.');
    if (!s.owner) { s.owner = { conversationId, phase: 'working' }; s.turnFinished = false; this.changed(); }
    return s;
  }
  finishTurn(conversationId: string) { for (const s of this.sessions.values()) if (s.owner?.conversationId === conversationId) { s.turnFinished = true; if (!s.command) s.owner = null; this.changed(); } }
  takeOver(workspaceId: string, connectionId: string): string | null {
    const s = this.session(workspaceId, connectionId); if (!s?.owner) return null;
    const conversationId = s.owner.conversationId; s.turnFinished = true;
    if (s.command) { s.owner.phase = 'returning-control'; s.backend.write('\x03'); }
    else s.owner = null;
    this.changed(); return conversationId;
  }
  private receive(s: Session, data: string) {
    if (!this.sessions.has(this.key(s.workspaceId, s.connectionId))) return;
    s.seq++; s.output = limit(s.output + data, OUTPUT_LIMIT); this.onOutput({ id: s.id, seq: s.seq, data });
    if (s.manualBusy && /(?:^|\n)[^\n]*[#$>] ?$/.test(plain(s.output.slice(-300)))) s.manualBusy = false;
    const command = s.command;
    if (command) {
      command.capture = limit(command.capture + data, COMMAND_LIMIT * 3);
      const finished = commandStatus(command.capture, command.id);
      if (finished) {
        const result: CommandResult = { id: command.id, status: finished.exitCode === 0 ? 'completed' : 'failed', exitCode: finished.exitCode, output: limit(finished.output, COMMAND_LIMIT), truncated: finished.output.length > COMMAND_LIMIT };
        s.command = null; s.elevation = null;
        if (s.turnFinished || s.owner?.phase === 'returning-control') s.owner = null;
        else if (s.owner) { s.owner.phase = 'working'; s.owner.command = undefined; }
        command.resolve(result); this.changed();
      } else if (!s.elevation && /(?:\[sudo\]\s*)?password(?: for [^:\n]+)?:\s*$/i.test(plain(data))) {
        s.elevation = { id: randomUUID(), sessionId: s.id, connectionId: s.connectionId, command: command.text, prompt: 'Password requested by terminal' }; this.changed();
      }
    }
  }
  respondElevation(id: string, password: string | null) {
    const s = [...this.sessions.values()].find(session => session.elevation?.id === id);
    if (!s) throw new Error('Password prompt expired.');
    s.elevation = null;
    if (password === null) s.backend.write('\x03');
    else { if (!password || password.length > 1024) throw new Error('Invalid password.'); s.backend.write(`${password}\r`); }
    this.changed();
  }
  async execute(s: Session, commandText: string, timeoutSeconds: number, signal: AbortSignal): Promise<CommandResult> {
    if (!s.owner || s.command) throw new Error('Terminal is unavailable for a new command.');
    if (!commandText.trim() || commandText.length > 16_000) throw new Error('Command must contain 1–16,000 characters.');
    const id = randomUUID();
    let resolve!: (result: CommandResult) => void;
    const completed = new Promise<CommandResult>(r => { resolve = r; });
    const command: Command = { id, text: commandText, started: Date.now(), capture: '', resolve, completed };
    const payload = wrapper(s.shell, commandText, id);
    s.command = command; s.owner.phase = 'command-running'; s.owner.command = commandText; this.changed();
    s.backend.write(payload);
    const timeout = Math.min(120, Math.max(1, timeoutSeconds));
    return await Promise.race([completed, new Promise<CommandResult>((done, reject) => {
      const timer = setTimeout(() => done({ id, status: 'running', exitCode: null, output: limit(plain(command.capture), COMMAND_LIMIT), truncated: command.capture.length > COMMAND_LIMIT }), timeout * 1000);
      completed.finally(() => clearTimeout(timer));
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Turn stopped while command continues.')); }, { once: true });
    })]);
  }
}
