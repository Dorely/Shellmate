// Electron utility process that owns node-pty. node-pty's ConPTY spawn blocks its thread until a conout
// worker starts, and a debugger that pauses new workers would otherwise deadlock the main process.
import * as pty from 'node-pty';
import type { PtyHostReply, PtyHostRequest } from './local-pty';

const terminals = new Map<string, pty.IPty>();
const post = (message: PtyHostReply) => process.parentPort.postMessage(message);

process.parentPort.on('message', ({ data }: { data: PtyHostRequest }) => {
  const terminal = terminals.get(data.id);
  try {
    switch (data.type) {
      case 'spawn': {
        const spawned = pty.spawn(data.file, data.args, { name: 'xterm-256color', cols: data.cols, rows: data.rows, cwd: data.cwd, env: data.env, useConptyDll: true });
        terminals.set(data.id, spawned);
        post({ type: 'spawned', id: data.id });
        spawned.onData(output => post({ type: 'data', id: data.id, data: output }));
        spawned.onExit(({ exitCode }) => { terminals.delete(data.id); post({ type: 'exit', id: data.id, exitCode }); });
        break;
      }
      case 'write': terminal?.write(data.data); break;
      case 'resize': terminal?.resize(data.cols, data.rows); break;
      case 'kill': terminals.delete(data.id); terminal?.kill(); break;
    }
  } catch (error) {
    post({ type: 'error', id: data.id, message: error instanceof Error ? error.message : 'Local terminal operation failed.' });
  }
});
