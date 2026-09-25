import type { ShellmateApi } from '../shared/types';

const methods = [
  'snapshot', 'chatContext', 'setTheme', 'createWorkspace', 'renameWorkspace', 'setActiveWorkspace',
  'createConversation', 'renameConversation', 'setWorkspaceAccess', 'setWorkspaceWebAccess', 'sendMessage', 'cancelTurn',
  'saveConnection', 'deleteConnection', 'setWorkspaceConnection', 'connect', 'disconnect', 'resize', 'write', 'takeOver',
  'resolveApproval', 'trustHostKey', 'respondElevation', 'listNotes', 'saveNote', 'deleteNote',
  'startLogin', 'cancelLogin', 'logout', 'saveChatProvider', 'deleteChatProvider', 'listChatModels',
  'testChatModel', 'saveChatModel', 'deleteChatModel', 'setActiveChat', 'testCodexModel', 'saveCodexModel', 'deleteCodexModel',
  'saveWebSearch', 'testWebSearch', 'openExternal'
] as const;

export async function installBrowserBridge(): Promise<void> {
  const session = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!session.ok || !session.headers.get('content-type')?.startsWith('application/json')) throw new Error('Shellmate browser host is unavailable.');
  const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
    const response = await fetch('/api/call', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-shellmate-browser': '1' }, body: JSON.stringify({ method, args }) });
    const payload = await response.json() as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'Shellmate operation failed.');
    return payload.result;
  };
  const api = {} as ShellmateApi;
  for (const method of methods) (api as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => call(method, ...args);
  const events = new EventSource('/api/events', { withCredentials: true });
  api.onChanged = callback => { const listener = () => callback(); events.addEventListener('changed', listener); return () => events.removeEventListener('changed', listener); };
  api.onTerminal = callback => {
    const listener = (event: Event) => { try { callback(JSON.parse((event as MessageEvent).data)); } catch { /* Ignore malformed events. */ } };
    events.addEventListener('terminal', listener);
    return () => events.removeEventListener('terminal', listener);
  };
  window.shellmate = api;
}
