import { contextBridge, ipcRenderer } from 'electron';
import type { ShellmateApi } from '../shared/types';
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke('shellmate:call', method, args);
const api: ShellmateApi = {
  snapshot: () => call('snapshot'), chatContext: (id, draft) => call('chatContext', id, draft), setTheme: theme => call('setTheme', theme),
  createWorkspace: name => call('createWorkspace', name), renameWorkspace: (id, name) => call('renameWorkspace', id, name), setActiveWorkspace: id => call('setActiveWorkspace', id),
  createConversation: () => call('createConversation'), renameConversation: (id, title) => call('renameConversation', id, title), setWorkspaceAccess: (connectionId, access) => call('setWorkspaceAccess', connectionId, access),
  setWorkspaceWebAccess: access => call('setWorkspaceWebAccess', access),
  sendMessage: (id, text) => call('sendMessage', id, text), cancelTurn: id => call('cancelTurn', id),
  saveConnection: input => call('saveConnection', input), deleteConnection: id => call('deleteConnection', id), setWorkspaceConnection: (id, included) => call('setWorkspaceConnection', id, included),
  connect: id => call('connect', id), disconnect: id => call('disconnect', id), resize: (id, cols, rows) => call('resize', id, cols, rows), write: (id, text) => call('write', id, text), takeOver: id => call('takeOver', id),
  resolveApproval: (id, allow) => call('resolveApproval', id, allow), trustHostKey: (id, allow) => call('trustHostKey', id, allow), respondElevation: (id, password) => call('respondElevation', id, password),
  listNotes: id => call('listNotes', id), saveNote: (id, note) => call('saveNote', id, note), deleteNote: (id, noteId) => call('deleteNote', id, noteId),
  startLogin: () => call('startLogin'), cancelLogin: () => call('cancelLogin'), logout: () => call('logout'),
  saveChatProvider: input => call('saveChatProvider', input), deleteChatProvider: id => call('deleteChatProvider', id), listChatModels: id => call('listChatModels', id), testChatModel: input => call('testChatModel', input),
  saveChatModel: input => call('saveChatModel', input), deleteChatModel: id => call('deleteChatModel', id), setActiveChat: input => call('setActiveChat', input),
  testCodexModel: slug => call('testCodexModel', slug), saveCodexModel: input => call('saveCodexModel', input), deleteCodexModel: id => call('deleteCodexModel', id),
  saveWebSearch: input => call('saveWebSearch', input), testWebSearch: () => call('testWebSearch'), openExternal: url => call('openExternal', url),
  onChanged: callback => { const listener = () => callback(); ipcRenderer.on('shellmate:changed', listener); return () => ipcRenderer.removeListener('shellmate:changed', listener); },
  onTerminal: callback => { const listener = (_event: unknown, data: { id: string; seq: number; data: string }) => callback(data); ipcRenderer.on('shellmate:terminal', listener); return () => ipcRenderer.removeListener('shellmate:terminal', listener); }
};
contextBridge.exposeInMainWorld('shellmate', api);
