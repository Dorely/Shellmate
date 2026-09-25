import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Client, type ClientChannel } from 'ssh2';
import type { ConnectionProfile, ElevationRequest, HostKeyRequest, ShellKind, TerminalIntegration, TerminalOwnership, TerminalSnapshot } from '../shared/types';
import { LocalPtyHost, undebuggedEnv } from './local-pty';
import type { SecureStore } from './providers/secrets';
import { secretName } from './providers/secrets';
import { bootstrapLine, commandInput, IntegrationParser, powershellLaunchArgs, type IntegrationEvent } from './shell-integration';
import type { Store } from './store';

type Backend = { write(data: string): void; resize(cols: number, rows: number): void; close(): void };
type Command = { id: string; text: string; input: string; capture: string; started: boolean; startedAt: number; interrupt: NodeJS.Timeout | null; resolve: (result: CommandResult) => void; completed: Promise<CommandResult> };
export interface CommandResult { id: string; status: 'completed' | 'failed' | 'running' | 'interrupted'; exitCode: number | null; output: string; truncated: boolean; note?: string }
export interface CommandProgress { id: string; command: string; running: boolean; elapsedSeconds: number; exitCode: number | null; output: string; truncated: boolean }
type ShellState = 'starting' | 'prompt' | 'input' | 'running';
// A typed bootstrap line whose echo stays hidden until the integrated prompt appears.
type Bootstrap = { line: string; keepBanner: boolean; before: string; after: string; sent: boolean; quiet: NodeJS.Timeout | null; timer: NodeJS.Timeout | null };
type Session = {
  id: string; workspaceId: string; connectionId: string; shell: ShellKind; backend: Backend; output: string; seq: number; owner: TerminalOwnership | null; command: Command | null; turnFinished: boolean; error: string | null;
  elevation: ElevationRequest | null; elevationCheck: NodeJS.Timeout | null; redact: { text: string; until: number } | null;
  integration: TerminalIntegration; integrationDetail: string | null; integrationTimer: NodeJS.Timeout | null; parser: IntegrationParser; bootstrap: Bootstrap | null;
  state: ShellState; cwd: string | null; lastExitCode: number | null; bracketedPaste: boolean;
  lastCommand: CommandProgress | null;
};
type Integration = { integration: TerminalIntegration; detail: string | null; launchArgs: string[]; bootstrap: { line: string; keepBanner: boolean } | null };
const OUTPUT_LIMIT = 160_000;
const COMMAND_LIMIT = 32_000;
const INTERRUPT_WAIT_MS = 5_000;
const PASSWORD_PROMPT = /(?:^|\n)([^\n]*\b(?:password|passphrase)\b[^\n]*:)[ \t]*$/i;
// Terminal query replies and focus reports that xterm sends without the user typing.
const DEVICE_ATTRIBUTES = '\x1b[c';
const TERMINAL_REPLY = /^(?:\x1B\[(?:[\d;?]*[Rcnt]|[IO]))+$/;
const limit = (text: string, count: number) => text.length > count ? text.slice(-count) : text;
const plain = (text: string) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '').replace(/\r\n?/g, '\n');

function resolvedShell(profile: ConnectionProfile): ShellKind {
  if (profile.shell !== 'auto') return profile.shell;
  if (profile.kind === 'ssh') return 'posix';
  const executable = profile.localShellPath.toLowerCase();
  if (executable.includes('powershell') || executable.includes('pwsh')) return 'powershell';
  if (executable.includes('cmd')) return 'cmd';
  if (/(?:bash|zsh|wsl|(?:^|[\\/])sh)(?:\.exe)?$/.test(executable)) return 'posix';
  return process.platform === 'win32' ? 'powershell' : 'posix';
}
function integrationFor(profile: ConnectionProfile, shell: ShellKind, nonce: string): Integration {
  const none = (integration: TerminalIntegration, detail: string): Integration => ({ integration, detail, launchArgs: [], bootstrap: null });
  if (shell === 'cmd') return none('unsupported', 'cmd.exe cannot report command boundaries. Use PowerShell or a POSIX shell for agent commands.');
  if (shell === 'powershell' && profile.kind === 'local') {
    const args = profile.localShellArgs.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    if (args.some(arg => /^[-/](?:c|co|com\w*|e|ec|en\w*|f|fi|fil|file)$/i.test(arg))) return none('unavailable', 'Custom -Command or -File shell arguments prevent shell integration.');
    return { integration: 'pending', detail: null, launchArgs: powershellLaunchArgs(nonce), bootstrap: null };
  }
  // ConPTY (local shells and Windows SSH servers) repaints its own buffer, so those bootstraps clear the screen.
  const clear = profile.kind === 'local' || shell === 'powershell';
  return { integration: 'pending', detail: null, launchArgs: [], bootstrap: { line: bootstrapLine(shell === 'powershell' ? 'powershell' : 'posix', nonce, clear), keepBanner: !clear } };
}
// Without a command-start mark, drop the echoed input (including continuation prompts) from the captured output.
function withoutEcho(output: string, input: string): string {
  const wanted = plain(input).replace(/\s+/g, ''); let i = 0; let j = 0;
  while (i < output.length && j < wanted.length) {
    if (/\s/.test(output[i])) { i++; continue; }
    if (output[i] === wanted[j]) { i++; j++; continue; }
    if (output[i] === '>') { i++; continue; }
    break;
  }
  const newline = output.indexOf('\n', j === wanted.length ? i : 0);
  return newline < 0 ? (j === wanted.length ? '' : output) : output.slice(newline + 1);
}

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private connecting = new Map<string, Promise<TerminalSnapshot>>();
  private hostKeys = new Map<string, HostKeyRequest>();
  private ptys = new LocalPtyHost();
  constructor(private store: Store, private secrets: SecureStore, private changed: () => void, private onOutput: (event: { id: string; seq: number; data: string }) => void) {}
  private key(workspaceId: string, connectionId: string) { return `${workspaceId}:${connectionId}`; }
  private alive(s: Session) { return this.sessions.get(this.key(s.workspaceId, s.connectionId)) === s; }
  session(workspaceId: string, connectionId: string): Session | null { return this.sessions.get(this.key(workspaceId, connectionId)) ?? null; }
  snapshots(workspaceId: string): TerminalSnapshot[] { return [...this.sessions.values()].filter(s => s.workspaceId === workspaceId).map(s => this.snapshot(s)); }
  snapshot(s: Session): TerminalSnapshot {
    return { id: s.id, workspaceId: s.workspaceId, connectionId: s.connectionId, connected: true, output: s.output, seq: s.seq, shell: s.shell, owner: s.owner, activeCommand: s.command?.text ?? null, error: s.error,
      integration: s.integration, integrationDetail: s.integrationDetail, busy: s.state === 'running', cwd: s.cwd, lastExitCode: s.lastExitCode };
  }
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
    const nonce = randomBytes(8).toString('hex');
    const integration = integrationFor(profile, shell, nonce);
    let session: Session | null = null;
    let earlyOutput = '';
    let earlyClose: string | null = null;
    const output = (data: string) => { if (session) this.receive(session, data); else earlyOutput += data; };
    const closed = (reason: string) => { if (session) this.exited(workspaceId, connectionId, reason); else earlyClose = reason; };
    const backend = profile.kind === 'local' ? await this.openLocal(profile, integration.launchArgs, output, closed) : await this.openSsh(workspaceId, profile, output, closed);
    if (earlyClose || !this.store.hasWorkspaceConnection(workspaceId, connectionId) || this.store.connection(connectionId).updatedAt !== profile.updatedAt) {
      backend.close(); throw new Error(earlyClose ?? 'Connection changed while opening. Connect again.');
    }
    session = { id: randomUUID(), workspaceId, connectionId, shell, backend, output: '', seq: 0, owner: null, command: null, turnFinished: false, error: null,
      elevation: null, elevationCheck: null, redact: null, integration: integration.integration, integrationDetail: integration.detail, integrationTimer: null,
      parser: new IntegrationParser(nonce), bootstrap: null, state: 'starting', cwd: null, lastExitCode: null, bracketedPaste: false, lastCommand: null };
    this.sessions.set(this.key(workspaceId, connectionId), session); this.changed();
    if (integration.bootstrap) this.beginBootstrap(session, integration.bootstrap.line, integration.bootstrap.keepBanner);
    else if (integration.integration === 'pending') {
      const s = session;
      s.integrationTimer = setTimeout(() => this.integrationFailed(s, 'No integrated prompt appeared. A profile or custom prompt may have replaced it.'), 20_000);
    }
    if (earlyOutput) this.receive(session, earlyOutput);
    return this.snapshot(session);
  }
  private openLocal(profile: ConnectionProfile, launchArgs: string[], output: (data: string) => void, closed: (reason: string) => void): Promise<Backend> {
    const command = profile.localShellPath.trim() || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh');
    const args = profile.localShellArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(value => value.replace(/^"|"$/g, '')) ?? [];
    const userArgs = launchArgs.length ? args.filter(arg => !/^[-/]noe(?:x(?:it?)?)?$/i.test(arg)) : args;
    return this.ptys.spawn({ file: command, args: [...userArgs, ...launchArgs], cwd: profile.localCwd.trim() || homedir(), env: { ...undebuggedEnv(), TERM: 'xterm-256color' }, cols: 100, rows: 30 }, output, closed);
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
  private release(s: Session) {
    for (const timer of [s.integrationTimer, s.elevationCheck, s.bootstrap?.quiet, s.bootstrap?.timer, s.command?.interrupt]) if (timer) clearTimeout(timer);
    if (s.command) s.command.resolve({ id: s.command.id, status: 'interrupted', exitCode: null, output: '', truncated: false });
  }
  private exited(workspaceId: string, connectionId: string, reason: string) {
    const key = this.key(workspaceId, connectionId); const s = this.sessions.get(key); if (!s) return;
    this.sessions.delete(key); s.error = reason; this.release(s); this.changed();
  }
  disconnect(workspaceId: string, connectionId: string, force = false) {
    const s = this.session(workspaceId, connectionId); if (!s) return;
    if (s.owner && s.owner.phase !== 'returning-control' && !force) throw new Error('Take over this terminal before disconnecting.');
    this.sessions.delete(this.key(workspaceId, connectionId)); s.backend.close(); this.release(s); this.changed();
  }
  disconnectProfile(connectionId: string) { for (const s of [...this.sessions.values()]) if (s.connectionId === connectionId) this.disconnect(s.workspaceId, connectionId, true); }
  shutdown() { for (const s of [...this.sessions.values()]) this.disconnect(s.workspaceId, s.connectionId, true); this.ptys.shutdown(); }
  resize(workspaceId: string, connectionId: string, cols: number, rows: number) {
    const s = this.session(workspaceId, connectionId); if (!s) throw new Error('Terminal is disconnected.');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 500 || rows > 300) throw new Error('Invalid terminal dimensions.');
    s.backend.resize(cols, rows);
  }
  write(workspaceId: string, connectionId: string, data: string) {
    const s = this.session(workspaceId, connectionId); if (!s) throw new Error('Terminal is disconnected.');
    if (s.owner) throw new Error('Agent controls this terminal. Use Take over first.');
    if (s.bootstrap) throw new Error('Shell integration is starting.');
    if (!data || data.length > 16_000) throw new Error('Invalid terminal input.');
    if ((s.state === 'prompt' || s.state === 'input') && !TERMINAL_REPLY.test(data)) this.setState(s, /[\r\n]/.test(data) ? 'running' : 'input');
    s.backend.write(data);
  }
  acquire(workspaceId: string, connectionId: string, conversationId: string): Session {
    const s = this.session(workspaceId, connectionId); if (!s) throw new Error('Connect this terminal first.');
    if (s.owner && s.owner.conversationId !== conversationId) throw new Error('Terminal is in use by another conversation.');
    if (!s.owner && s.state === 'running') throw new Error('The user’s terminal command is still running. Wait for its prompt.');
    if (!s.owner) { s.owner = { conversationId, phase: 'working' }; s.turnFinished = false; this.changed(); }
    return s;
  }
  finishTurn(conversationId: string) { for (const s of this.sessions.values()) if (s.owner?.conversationId === conversationId) { s.turnFinished = true; if (!s.command) s.owner = null; this.changed(); } }
  takeOver(workspaceId: string, connectionId: string): string | null {
    const s = this.session(workspaceId, connectionId); if (!s?.owner) return null;
    const conversationId = s.owner.conversationId;
    this.returnControl(s); return conversationId;
  }
  /** Interrupts commands a stopped conversation left running and returns its terminals to the user. */
  interruptConversation(conversationId: string) {
    for (const s of this.sessions.values()) if (s.owner?.conversationId === conversationId && s.owner.phase !== 'returning-control') this.returnControl(s);
  }
  private returnControl(s: Session) {
    if (!s.owner) return;
    s.turnFinished = true;
    const command = s.command;
    if (command) {
      s.owner.phase = 'returning-control'; this.clearElevation(s); s.backend.write('\x03');
      // A program that ignores the interrupt still returns control to the user.
      command.interrupt = setTimeout(() => {
        if (s.command !== command) return;
        s.command = null; s.owner = null;
        const result: CommandResult = { ...this.partial(command), status: 'interrupted', truncated: false };
        s.lastCommand = this.progressOf(command, result); command.resolve(result); this.changed();
      }, 3_000);
    } else s.owner = null;
    this.changed();
  }
  /** Sends Ctrl+C to the conversation's own running command and waits briefly for its prompt. */
  async interrupt(s: Session, conversationId: string, signal: AbortSignal): Promise<CommandResult> {
    const command = s.command;
    if (s.owner?.conversationId !== conversationId || !command) throw new Error('No command of yours is running in this terminal.');
    this.clearElevation(s); s.backend.write('\x03');
    const stopped = await Promise.race([command.completed, new Promise<null>((done, reject) => {
      const timer = setTimeout(() => done(null), INTERRUPT_WAIT_MS);
      void command.completed.finally(() => clearTimeout(timer));
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Turn stopped.')); }, { once: true });
    })]);
    if (stopped) return { ...stopped, status: 'interrupted' };
    return { ...this.partial(command), note: 'Ctrl+C did not return a prompt. The program may ignore interrupts or be blocked in uninterruptible I/O (for example a stale network mount). Tell the user; they can Take over or reconnect the terminal.' };
  }
  /** The agent's running command, or the last one it ran, as clean output. */
  progress(s: Session): CommandProgress | null {
    return s.command ? this.progressOf(s.command, this.partial(s.command)) : s.lastCommand;
  }
  private partial(command: Command): CommandResult {
    return { id: command.id, status: 'running', exitCode: null, output: limit(plain(command.capture), COMMAND_LIMIT), truncated: command.capture.length > COMMAND_LIMIT };
  }
  private progressOf(command: Command, result: CommandResult): CommandProgress {
    return { id: command.id, command: command.text, running: result.status === 'running', elapsedSeconds: Math.round((Date.now() - command.startedAt) / 1000), exitCode: result.exitCode, output: result.output, truncated: result.truncated };
  }
  private setState(s: Session, state: ShellState) {
    if (s.state === state) return;
    const busy = s.state === 'running'; s.state = state;
    if (busy !== (state === 'running')) this.changed();
  }
  private integrationFailed(s: Session, detail: string) {
    if (!this.alive(s) || s.integration !== 'pending') return;
    s.integration = 'unavailable'; s.integrationDetail = detail; s.integrationTimer = null; this.changed();
  }
  private beginBootstrap(s: Session, line: string, keepBanner: boolean) {
    const b: Bootstrap = { line, keepBanner, before: '', after: '', sent: false, quiet: null, timer: null };
    s.bootstrap = b;
    b.timer = setTimeout(() => this.sendBootstrap(s), 10_000);
  }
  // Wait for the login banner and first prompt to settle, then type the bootstrap line.
  private sendBootstrap(s: Session) {
    const b = s.bootstrap; if (!b || b.sent || !this.alive(s)) return;
    for (const timer of [b.quiet, b.timer]) if (timer) clearTimeout(timer);
    b.sent = true; b.quiet = null;
    b.timer = setTimeout(() => {
      if (s.bootstrap !== b) return;
      s.bootstrap = null; this.integrationFailed(s, 'The shell did not accept the integration bootstrap. It may not be a PowerShell or POSIX shell.');
      this.deliver(s, b.before + b.after, []);
    }, 8_000);
    s.backend.write(b.line);
  }
  private receive(s: Session, data: string) {
    if (!this.alive(s)) return;
    const { text, events } = s.parser.feed(data);
    const pasteOn = text.lastIndexOf('\x1b[?2004h'); const pasteOff = text.lastIndexOf('\x1b[?2004l');
    if (pasteOn !== pasteOff) s.bracketedPaste = pasteOn > pasteOff;
    const b = s.bootstrap;
    if (!b) { this.deliver(s, text, events); return; }
    if (!b.sent) {
      // Held output never reaches xterm, so answer ConPTY's startup device-attributes query here.
      if (text.includes(DEVICE_ATTRIBUTES)) s.backend.write('\x1b[?1;2c');
      b.before += text.split(DEVICE_ATTRIBUTES).join('');
      if (!plain(b.before).trim()) return;
      if (b.quiet) clearTimeout(b.quiet);
      b.quiet = setTimeout(() => this.sendBootstrap(s), 400);
      return;
    }
    for (const event of events) if (event.kind === 'P') s.cwd = event.arg || null;
    const prompt = events.find(event => event.kind === 'A');
    if (!prompt) { b.after = limit(b.after + text, OUTPUT_LIMIT); return; }
    // Show the banner without the pre-integration prompt line, then continue from the integrated prompt.
    if (b.timer) clearTimeout(b.timer);
    s.bootstrap = null;
    const cut = b.before.lastIndexOf('\n');
    const banner = b.keepBanner && cut >= 0 ? b.before.slice(0, cut + 1) : '';
    this.deliver(s, banner + text.slice(prompt.index), events.filter(event => event.index >= prompt.index).map(event => ({ ...event, index: event.index - prompt.index + banner.length })));
  }
  private deliver(s: Session, text: string, events: IntegrationEvent[]) {
    let visible = ''; let from = 0;
    const take = (to: number) => {
      const segment = this.redacted(s, text.slice(from, to)); from = to;
      if (!segment) return;
      visible += segment;
      if (s.command) s.command.capture = limit(s.command.capture + segment, COMMAND_LIMIT * 3);
    };
    for (const event of events) { take(event.index); this.event(s, event); }
    take(text.length);
    if (!visible) return;
    s.seq++; s.output = limit(s.output + visible, OUTPUT_LIMIT); this.onOutput({ id: s.id, seq: s.seq, data: visible });
    this.clearElevation(s);
    if (s.command) this.checkElevation(s);
  }
  private event(s: Session, event: IntegrationEvent) {
    if (event.kind === 'P') { s.cwd = event.arg || null; return; }
    if (event.kind === 'A' || event.kind === 'B') {
      if (s.integration === 'pending') { if (s.integrationTimer) clearTimeout(s.integrationTimer); s.integration = 'ready'; s.integrationDetail = null; s.integrationTimer = null; this.changed(); }
      if (!s.command) this.setState(s, 'prompt');
      return;
    }
    const command = s.command;
    if (event.kind === 'C') {
      this.setState(s, 'running');
      if (command) { command.capture = ''; command.started = true; }
      return;
    }
    const code = /^-?\d+$/.test(event.arg) ? Number(event.arg) : null;
    // A prompt redraw before the command line was accepted is not a completion.
    if (command && (command.started || command.capture.includes('\n'))) this.finish(s, command, code);
    else if (!command && s.state === 'running') s.lastExitCode = code;
    if (!s.command) this.setState(s, 'prompt');
  }
  private finish(s: Session, command: Command, exitCode: number | null) {
    let output = plain(command.capture);
    if (!command.started) output = withoutEcho(output, command.input);
    output = output.trim();
    const result: CommandResult = { id: command.id, status: exitCode === 0 ? 'completed' : 'failed', exitCode, output: limit(output, COMMAND_LIMIT), truncated: output.length > COMMAND_LIMIT };
    if (command.interrupt) clearTimeout(command.interrupt);
    s.command = null; s.lastExitCode = exitCode; s.lastCommand = this.progressOf(command, result); s.redact = null; this.clearElevation(s);
    if (s.turnFinished || s.owner?.phase === 'returning-control') s.owner = null;
    else if (s.owner) { s.owner.phase = 'working'; s.owner.command = undefined; }
    command.resolve(result); this.changed();
  }
  private redacted(s: Session, text: string): string {
    if (!s.redact) return text;
    if (Date.now() > s.redact.until) { s.redact = null; return text; }
    return text.split(s.redact.text).join('********');
  }
  private clearElevation(s: Session) {
    if (s.elevationCheck) { clearTimeout(s.elevationCheck); s.elevationCheck = null; }
    if (s.elevation) { s.elevation = null; this.changed(); }
  }
  // Raise a password request only when a running command's output has settled on a password prompt.
  private checkElevation(s: Session) {
    s.elevationCheck = setTimeout(() => {
      s.elevationCheck = null;
      const command = s.command; if (!command || s.elevation || !this.alive(s)) return;
      const match = PASSWORD_PROMPT.exec(plain(command.capture).slice(-300)); if (!match) return;
      s.elevation = { id: randomUUID(), sessionId: s.id, connectionId: s.connectionId, command: command.text, prompt: match[1].trim().slice(-200) }; this.changed();
    }, 250);
  }
  respondElevation(id: string, password: string | null) {
    const s = [...this.sessions.values()].find(session => session.elevation?.id === id);
    if (!s) throw new Error('Password prompt expired.');
    if (password !== null && (!password || password.length > 1024 || /[\x00-\x1f\x7f]/.test(password))) throw new Error('Invalid password.');
    this.clearElevation(s);
    if (password === null) { s.backend.write('\x03'); return; }
    // Guard against programs that echo their input: mask the password in output that follows shortly.
    if (password.length >= 4) s.redact = { text: password, until: Date.now() + 5_000 };
    s.backend.write(`${password}\r`);
  }
  private ready(s: Session) {
    if (s.integration === 'pending') throw new Error('Shell integration is still starting. Wait a moment, then retry.');
    if (s.integration !== 'ready') throw new Error(`Agent commands are unavailable in this terminal. ${s.integrationDetail ?? ''}`.trim());
    if (s.state === 'input') throw new Error('The user has unsent input at the prompt. Ask them to submit or clear it.');
    if (s.state !== 'prompt') throw new Error('The shell is still running a previous command. Wait for its prompt.');
  }
  async execute(s: Session, commandText: string, timeoutSeconds: number, signal: AbortSignal): Promise<CommandResult> {
    if (!s.owner) throw new Error('Terminal is unavailable for a new command.');
    if (s.command) throw new Error('A previous command is still running. Wait for it or read the terminal.');
    if (!commandText.trim() || commandText.length > 16_000) throw new Error('Command must contain 1–16,000 characters.');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(commandText)) throw new Error('Command must not contain control characters.');
    this.ready(s);
    const id = randomUUID();
    let resolve!: (result: CommandResult) => void;
    const completed = new Promise<CommandResult>(r => { resolve = r; });
    const input = commandInput(s.shell === 'powershell' ? 'powershell' : 'posix', commandText, s.bracketedPaste);
    const command: Command = { id, text: commandText, input, capture: '', started: false, startedAt: Date.now(), interrupt: null, resolve, completed };
    s.command = command; this.setState(s, 'running'); s.owner.phase = 'command-running'; s.owner.command = commandText; this.changed();
    s.backend.write(input);
    const timeout = Math.min(120, Math.max(1, timeoutSeconds));
    return await Promise.race([completed, new Promise<CommandResult>((done, reject) => {
      const timer = setTimeout(() => done({ ...this.partial(command), note: 'Still running. Check the output, then use wait_for_terminal or interrupt_command.' }), timeout * 1000);
      void completed.finally(() => clearTimeout(timer));
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Turn stopped; the running command was interrupted.')); }, { once: true });
    })]);
  }
}
