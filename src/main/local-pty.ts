import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';

export type PtyHostRequest =
  | { type: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string };
export type PtyHostReply =
  | { type: 'spawned'; id: string }
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'error'; id: string; message: string };
export type LocalPty = { write(data: string): void; resize(cols: number, rows: number): void; close(): void };
type Terminal = { output(data: string): void; closed(reason: string): void; opening: { resolve(): void; reject(error: Error): void } | null };

// Keep a VS Code debug session's auto-attach hooks out of the PTY host and the shells it starts.
export function undebuggedEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  if (env.VSCODE_INSPECTOR_OPTIONS) delete env.NODE_OPTIONS;
  delete env.VSCODE_INSPECTOR_OPTIONS;
  return env;
}

// Runs local PTYs in a separate utility process so a blocked spawn can never freeze Electron's main thread.
export class LocalPtyHost {
  private host: UtilityProcess | null = null;
  private terminals = new Map<string, Terminal>();
  private started(): UtilityProcess {
    if (this.host) return this.host;
    const host = utilityProcess.fork(join(__dirname, 'pty-host.js'), [], { serviceName: 'Shellmate terminal host', env: undebuggedEnv() });
    host.on('message', (message: PtyHostReply) => this.reply(message));
    host.on('exit', () => {
      if (this.host === host) this.host = null;
      const terminals = [...this.terminals.values()]; this.terminals.clear();
      for (const terminal of terminals) {
        if (terminal.opening) terminal.opening.reject(new Error('The local terminal host exited.'));
        else terminal.closed('The local terminal host exited.');
      }
    });
    this.host = host;
    return host;
  }
  private reply(message: PtyHostReply) {
    const terminal = this.terminals.get(message.id); if (!terminal) return;
    if (message.type === 'spawned') { terminal.opening?.resolve(); terminal.opening = null; return; }
    if (message.type === 'data') { terminal.output(message.data); return; }
    this.terminals.delete(message.id);
    const reason = message.type === 'error' ? message.message : 'Local shell exited.';
    if (terminal.opening) terminal.opening.reject(new Error(reason));
    else terminal.closed(reason);
  }
  spawn(options: { file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }, output: (data: string) => void, closed: (reason: string) => void): Promise<LocalPty> {
    const id = randomUUID(); const host = this.started();
    const send = (message: PtyHostRequest) => { if (this.terminals.has(id)) host.postMessage(message); };
    const pty: LocalPty = {
      write: data => send({ type: 'write', id, data }),
      resize: (cols, rows) => send({ type: 'resize', id, cols, rows }),
      close: () => { send({ type: 'kill', id }); this.terminals.delete(id); }
    };
    return new Promise<LocalPty>((resolve, reject) => {
      this.terminals.set(id, { output, closed, opening: { resolve: () => resolve(pty), reject } });
      host.postMessage({ type: 'spawn', id, ...options } satisfies PtyHostRequest);
    });
  }
  shutdown() { this.terminals.clear(); this.host?.kill(); this.host = null; }
}
