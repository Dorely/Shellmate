import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AccessMode, ChatContext, ChatProviderEntry, ConnectionInput, ConnectionSummary, Conversation, Note, SearchBackendId, Snapshot, TerminalSnapshot, WebSource } from '../shared/types';
import { readTheme, setTheme, terminalThemes, type ThemeName } from './theme';
import { DEFAULT_CONTEXT_LIMIT } from '../shared/chat-models';
import logo from './assets/logo.png';

const api = () => window.shellmate;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Operation failed.';
const emptyConnection = (): ConnectionInput => ({ name: '', kind: 'ssh', host: '', port: 22, username: '', auth: 'password', privateKeyPath: '', shell: 'auto', localShellPath: '', localShellArgs: '', localCwd: '' });
const connectionInput = (value: ConnectionSummary): ConnectionInput => ({ id: value.id, name: value.name, kind: value.kind, host: value.host, port: value.port, username: value.username, auth: value.auth, privateKeyPath: value.privateKeyPath, shell: value.shell, localShellPath: value.localShellPath, localShellArgs: value.localShellArgs, localCwd: value.localCwd });

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const openLink = (url: string) => (event: React.MouseEvent) => { event.preventDefault(); void api().openExternal(url).catch(() => undefined); };
/** Trims trailing sentence punctuation, and a closing bracket that was not opened inside the URL. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']']]) while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, '');
  return url;
}
function LinkedText({ text }: { text: string }) {
  const parts: React.ReactNode[] = []; let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]); const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<a key={start} href={url} onClick={openLink(url)} title={url}>{url}</a>);
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
const sourceLabel = (source: WebSource) => { if (source.title) return source.title; try { return new URL(source.url).hostname; } catch { return source.url; } };
const accessLabel: Record<AccessMode, string> = { disabled: 'off', ask: 'ask', autonomous: 'autonomous' };

const integrationLabel: Record<TerminalSnapshot['integration'], string> = { ready: '', pending: ' · integration starting', unavailable: ' · agent commands unavailable', unsupported: ' · manual only' };

function TerminalPane({ profile, session, theme, onConnect, onDisconnect, onTakeOver }: { profile: ConnectionSummary; session?: TerminalSnapshot; theme: ThemeName; onConnect: () => void; onDisconnect: () => void; onTakeOver: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const owner = useRef(session?.owner);
  owner.current = session?.owner;
  useEffect(() => {
    if (!session || !host.current) return;
    const term = new Terminal({ convertEol: false, cursorBlink: true, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12, lineHeight: 1.35, theme: terminalThemes[theme], scrollback: 3000 });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); terminal.current = term;
    term.write(session.output); fit.fit();
    let lastSeq = session.seq;
    const stopEvents = api().onTerminal(event => { if (event.id === session.id && event.seq > lastSeq) { lastSeq = event.seq; term.write(event.data); } });
    const input = term.onData(data => { if (!owner.current) void api().write(profile.id, data).catch(() => undefined); });
    const resize = new ResizeObserver(() => { if (!host.current) return; fit.fit(); void api().resize(profile.id, term.cols, term.rows).catch(() => undefined); });
    resize.observe(host.current);
    return () => { resize.disconnect(); input.dispose(); stopEvents(); term.dispose(); terminal.current = null; };
  }, [session?.id, profile.id]);
  useEffect(() => { if (terminal.current) terminal.current.options.theme = terminalThemes[theme]; }, [theme]);
  return <div className="terminal-pane">
    <div className="terminal-heading"><span className={`status-dot ${session ? 'on' : ''}`} /> <strong>{profile.name}</strong><span className="subtle">{profile.kind === 'ssh' ? `${profile.username}@${profile.host}:${profile.port}` : 'Local shell'}</span><span className="fill" />
      {session ? <button onClick={onDisconnect} disabled={Boolean(session.owner && session.owner.phase !== 'returning-control')}>Disconnect</button> : <button className="primary" onClick={onConnect}>Connect</button>}
    </div>
    {session ? <><div ref={host} className="terminal-canvas" aria-label={`${profile.name} terminal`} /><div className={`terminal-ownership ${session.owner ? 'owned' : ''}`}>
      {session.owner ? <><span className="agent-mark">✦</span> <span>Agent controlling · {session.owner.phase === 'command-running' ? 'Command running' : session.owner.phase === 'returning-control' ? 'Returning control…' : 'Working'}</span><span className="fill" /><button onClick={onTakeOver}>Take over</button></>
        : <><span className="status-dot on" /> You have control<span className="fill" /><span className="subtle" title={session.integrationDetail ?? undefined}>{session.shell}{integrationLabel[session.integration]}</span></>}
    </div></> : <div className="terminal-empty"><div className="terminal-empty-icon">⌘</div><strong>Terminal disconnected</strong><span>This connection is available to workspace chats according to its access setting.</span><button className="primary" onClick={onConnect}>Connect {profile.name}</button></div>}
  </div>;
}

/** A destructive button that asks "are you sure" in place: the first click arms it, the second acts; leaving or Escape disarms it. */
function ConfirmButton({ label, confirmLabel, ariaLabel, title, disabled, onConfirm }: { label: React.ReactNode; confirmLabel: string; ariaLabel?: string; title?: string; disabled?: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return <button className={`danger ${armed ? 'armed' : ''}`} title={armed ? undefined : title} aria-label={armed ? confirmLabel : ariaLabel} disabled={disabled}
    onClick={() => { if (!armed) { setArmed(true); return; } setArmed(false); onConfirm(); }}
    onMouseLeave={() => setArmed(false)} onBlur={() => setArmed(false)} onKeyDown={e => { if (e.key === 'Escape') setArmed(false); }}>{armed ? confirmLabel : label}</button>;
}

function ConnectionDialog({ profile, onClose, onSave, onDelete }: { profile?: ConnectionSummary; onClose: () => void; onSave: (input: ConnectionInput) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [draft, setDraft] = useState<ConnectionInput>(profile ? connectionInput(profile) : emptyConnection());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) => setDraft(current => ({ ...current, [key]: value }));
  const save = async () => { setBusy(true); setError(''); try { await onSave(draft); onClose(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } };
  return <div className="modal-backdrop" role="presentation"><div className="dialog connection-dialog" role="dialog" aria-modal="true" aria-label={profile ? 'Edit connection' : 'Add connection'}>
    <div className="dialog-head"><h2>{profile ? 'Edit connection' : 'Add connection'}</h2><button onClick={onClose} aria-label="Close">×</button></div>
    <div className="dialog-body"><div className="form-grid">
      <label>Name<input value={draft.name} onChange={e => update('name', e.target.value)} placeholder="web-01" /></label>
      <label>Type<select value={draft.kind} onChange={e => update('kind', e.target.value as ConnectionInput['kind'])}><option value="ssh">SSH</option><option value="local">Local shell</option></select></label>
      {draft.kind === 'ssh' ? <>
        <label>Host<input value={draft.host} onChange={e => update('host', e.target.value)} placeholder="server.example.com" /></label>
        <label>Port<input type="number" value={draft.port} onChange={e => update('port', Number(e.target.value))} /></label>
        <label>Username<input value={draft.username} onChange={e => update('username', e.target.value)} /></label>
        <label>Authentication<select value={draft.auth} onChange={e => update('auth', e.target.value as ConnectionInput['auth'])}><option value="password">Password</option><option value="key">Private key</option></select></label>
        {draft.auth === 'key' && <label className="wide">Private key path<input value={draft.privateKeyPath} onChange={e => update('privateKeyPath', e.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" /></label>}
        <label className="wide">{draft.auth === 'password' ? 'SSH password' : 'Key passphrase'}<input type="password" value={draft.auth === 'password' ? draft.password ?? '' : draft.passphrase ?? ''} onChange={e => update(draft.auth === 'password' ? 'password' : 'passphrase', e.target.value)} placeholder={profile ? 'Leave blank to keep saved credential' : 'Enter credential'} /></label>
        {profile && <label className="check wide"><input type="checkbox" checked={(draft.auth === 'password' ? draft.passwordAction : draft.passphraseAction) === 'remove'} onChange={e => update(draft.auth === 'password' ? 'passwordAction' : 'passphraseAction', e.target.checked ? 'remove' : 'keep')} /> Remove saved {draft.auth === 'password' ? 'password' : 'passphrase'}</label>}
      </> : <>
        <label className="wide">Shell executable<input value={draft.localShellPath} onChange={e => update('localShellPath', e.target.value)} placeholder="Default shell" /></label>
        <label className="wide">Arguments<input value={draft.localShellArgs} onChange={e => update('localShellArgs', e.target.value)} /></label>
        <label className="wide">Working directory<input value={draft.localCwd} onChange={e => update('localCwd', e.target.value)} placeholder="App directory" /></label>
      </>}
      <label>Shell syntax<select value={draft.shell} onChange={e => update('shell', e.target.value as ConnectionInput['shell'])}><option value="auto">Detect</option><option value="posix">POSIX</option><option value="powershell">PowerShell</option><option value="cmd">cmd</option></select></label>
    </div>{error && <p className="error" role="alert">{error}</p>}</div>
    <div className="dialog-actions">{profile && onDelete && <ConfirmButton label="Delete connection" confirmLabel="Delete it and its notes everywhere?" onConfirm={() => void onDelete().then(onClose).catch(error => setError(errorText(error)))} />}<span className="fill" /><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void save()}>Save connection</button></div>
  </div></div>;
}

function ProvidersDialog({ snapshot, onClose, act }: { snapshot: Snapshot; onClose: () => void; act: (action: () => Promise<unknown>) => Promise<unknown> }) {
  const [label, setLabel] = useState(''); const [kind, setKind] = useState<ChatProviderEntry['kind']>('chat-completions'); const [url, setUrl] = useState(''); const [key, setKey] = useState(''); const [keyAction, setKeyAction] = useState<'keep' | 'remove'>('keep');
  const [editing, setEditing] = useState<string | undefined>(); const [providerId, setProviderId] = useState(''); const [slug, setSlug] = useState(''); const [efforts, setEfforts] = useState(''); const [test, setTest] = useState<string>(''); const [modelId, setModelId] = useState<string | undefined>(); const [contextLimit, setContextLimit] = useState(String(DEFAULT_CONTEXT_LIMIT));
  const [codexSlug, setCodexSlug] = useState(''); const [codexModelId, setCodexModelId] = useState<string | undefined>(); const [testedCodex, setTestedCodex] = useState('');
  const [searchBackend, setSearchBackend] = useState<SearchBackendId | ''>(snapshot.webSearch.backend ?? ''); const [searchKey, setSearchKey] = useState(''); const [removeSearchKey, setRemoveSearchKey] = useState(false); const [searchTest, setSearchTest] = useState('');
  const clearProvider = () => { setEditing(undefined); setLabel(''); setUrl(''); setKey(''); setKeyAction('keep'); };
  const clearModel = () => { setModelId(undefined); setSlug(''); setEfforts(''); setTest(''); setContextLimit(String(DEFAULT_CONTEXT_LIMIT)); };
  const edit = (entry: ChatProviderEntry) => { setEditing(entry.id); setLabel(entry.label); setKind(entry.kind); setUrl(entry.baseUrl); setKey(''); setKeyAction('keep'); };
  const saveProvider = async () => { const saved = await act(() => api().saveChatProvider({ id: editing, label, baseUrl: url, kind, apiKey: key || undefined, keyAction: key ? 'replace' : keyAction })); if (saved === null) return; clearProvider(); };
  const testModel = async () => { const response = await act(() => api().testChatModel({ providerId, slug, efforts: efforts.split(',').map(x => x.trim()).filter(Boolean) })); setTest(response === null ? '' : JSON.stringify(response)); };
  const saveModel = async () => { const saved = await act(() => api().saveChatModel({ id: modelId, providerId, slug, efforts: efforts.split(',').map(x => x.trim()).filter(Boolean), contextLimit: Number(contextLimit) })); if (saved === null) return; clearModel(); };
  const testCodex = async () => { setTestedCodex(''); const tested = await act(() => api().testCodexModel(codexSlug)); if (tested !== null) setTestedCodex(codexSlug.trim()); };
  const saveSearch = async () => { const saved = await act(() => api().saveWebSearch({ backend: searchBackend || null, apiKey: searchKey || undefined, keyAction: searchKey ? 'replace' : removeSearchKey ? 'remove' : 'keep' })); if (saved === null) return; setSearchKey(''); setRemoveSearchKey(false); setSearchTest(''); };
  const testSearch = async () => { setSearchTest(''); const count = await act(() => api().testWebSearch()); if (count !== null) setSearchTest(`Search returned ${String(count)} result${count === 1 ? '' : 's'}.`); };
  const searchDirty = (searchBackend || null) !== snapshot.webSearch.backend || Boolean(searchKey) || removeSearchKey;
  const saveCodex = async () => { const saved = await act(() => api().saveCodexModel({ id: codexModelId, slug: codexSlug })); if (saved === null) return; setCodexModelId(undefined); setCodexSlug(''); setTestedCodex(''); };
  const codexModels = snapshot.providers.chatModels.filter(model => model.id.startsWith('codex:') && !model.builtIn);
  const apiModels = snapshot.providers.chatModels.filter(model => !model.builtIn && !model.id.startsWith('codex:'));
  return <div className="modal-backdrop" role="presentation"><div className="dialog providers-dialog" role="dialog" aria-modal="true" aria-label="Chat providers">
    <div className="dialog-head"><h2>Chat providers</h2><button onClick={onClose} aria-label="Close">×</button></div><div className="dialog-body settings-grid">
      {snapshot.providers.error && <p className="error settings-error">{snapshot.providers.error}</p>}
      <section className="settings-section"><div className="section-heading"><h3>Codex account</h3><span className={snapshot.providers.codexReady ? 'good' : 'subtle'}>{snapshot.providers.codexReady ? 'Connected' : snapshot.providers.loginPending ? 'Waiting for login' : 'Disconnected'}</span></div>
        <div className="section-body"><div className="row"><p className="subtle">Use your OpenAI account for built-in and custom Codex models.</p><span className="fill" />{snapshot.providers.codexReady ? <button onClick={() => { setTestedCodex(''); void act(() => api().logout()); }}>Sign out</button> : snapshot.providers.loginPending ? <button onClick={() => void act(() => api().cancelLogin())}>Cancel login</button> : <button className="primary" onClick={() => void act(() => api().startLogin())}>Sign in</button>}</div>
          <div className="settings-list"><div className="overline">Custom Codex models</div>{codexModels.length ? codexModels.map(model => <div className="settings-row" key={model.id}><strong>{model.slug}</strong><span className="fill" /><button onClick={() => { setCodexModelId(model.id); setCodexSlug(model.slug); setTestedCodex(''); }}>Edit</button><button className="danger" onClick={() => void act(() => api().deleteCodexModel(model.id))}>Delete</button></div>) : <p className="empty-list">No custom Codex models.</p>}</div>
          <div className="settings-form"><div className="overline">{codexModelId ? 'Edit Codex model' : 'Add Codex model'}</div><div className="form-grid"><label className="wide">Model ID<input aria-label="Codex model ID" value={codexSlug} onChange={e => { setCodexSlug(e.target.value); setTestedCodex(''); }} placeholder="gpt-model-name" /></label></div>
            <div className="row"><button disabled={!snapshot.providers.codexReady || !codexSlug.trim()} onClick={() => void testCodex()}>Test at medium</button><button className="primary" disabled={!testedCodex || testedCodex !== codexSlug.trim()} onClick={() => void saveCodex()}>{codexModelId ? 'Save model' : 'Add model'}</button>{codexModelId && <button onClick={() => { setCodexModelId(undefined); setCodexSlug(''); setTestedCodex(''); }}>Cancel edit</button>}</div>
            {testedCodex && <small className="good">Passed at medium effort. Other efforts have not been tested.</small>}</div>
        </div>
      </section>
      <section className="settings-section"><div className="section-heading"><h3>API providers</h3><span className="subtle">Chat Completions · Responses · Anthropic</span></div>
        <div className="section-body"><div className="settings-list">{snapshot.providers.providers.length ? snapshot.providers.providers.map(entry => <div className="settings-row" key={entry.id}><span><strong>{entry.label}</strong><small>{entry.kind} · {entry.baseUrl}</small></span><span className="fill" /><button onClick={() => edit(entry)}>Edit</button><button className="danger" onClick={() => void act(() => api().deleteChatProvider(entry.id))}>Delete</button></div>) : <p className="empty-list">No API providers yet.</p>}</div>
          <div className="settings-form"><div className="overline">{editing ? 'Edit provider' : 'Add provider'}</div>
            <div className="form-grid"><label>Label<input value={label} onChange={e => setLabel(e.target.value)} placeholder="Local model" /></label><label>Transport<select value={kind} onChange={e => setKind(e.target.value as ChatProviderEntry['kind'])}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option><option value="anthropic">Anthropic</option></select></label><label className="wide">Base URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:1234/v1" /></label><label className="wide">API key<input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={editing ? 'Leave blank to keep saved key' : 'Optional for local servers'} /></label></div>
            {editing && <label className="check"><input type="checkbox" checked={keyAction === 'remove'} onChange={e => setKeyAction(e.target.checked ? 'remove' : 'keep')} /> Remove saved key</label>}
            <div className="row"><button className="primary" onClick={() => void saveProvider()}>{editing ? 'Update provider' : 'Add provider'}</button>{editing && <button onClick={clearProvider}>Cancel edit</button>}</div></div>
        </div>
      </section>
      <section className="settings-section"><div className="section-heading"><h3>API models</h3><span className="subtle">Models served by your API providers</span></div>
        <div className="section-body"><div className="settings-list">{apiModels.length ? apiModels.map(model => <div className="settings-row" key={model.id}><span><strong>{model.label}</strong><small>Efforts: {model.efforts.join(', ') || 'default'} · Context: {model.contextLimit.toLocaleString()} tokens · Built-in web search: {model.hostedSearch ? 'yes' : 'no'}</small></span><span className="fill" /><button onClick={() => { setModelId(model.id); setProviderId(snapshot.providers.providers.find(p => p.label === model.providerLabel)?.id ?? ''); setSlug(model.slug); setEfforts(model.efforts.join(', ')); setContextLimit(String(model.contextLimit)); setTest(''); }}>Edit</button><button className="danger" onClick={() => void act(() => api().deleteChatModel(model.id))}>Delete</button></div>) : <p className="empty-list">No API models yet. Add a provider, then test and save a model.</p>}</div>
          <div className="settings-form"><div className="overline">{modelId ? 'Edit model' : 'Add model'}</div>
            <div className="form-grid"><label>Provider<select value={providerId} onChange={e => setProviderId(e.target.value)}><option value="">Choose provider</option>{snapshot.providers.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label>Model ID<input value={slug} onChange={e => setSlug(e.target.value)} placeholder="model-name" /></label><label>Reasoning efforts, comma separated<input value={efforts} onChange={e => setEfforts(e.target.value)} placeholder="Leave blank for provider default" /></label><label>Context window (tokens)<input type="number" min={8000} max={10000000} step={1000} value={contextLimit} onChange={e => setContextLimit(e.target.value)} /></label></div>
            <div className="row"><button disabled={!providerId || !slug} onClick={() => void testModel()}>Test model and efforts</button><button className="primary" disabled={!test} onClick={() => void saveModel()}>Save tested model</button>{modelId && <button onClick={clearModel}>Cancel edit</button>}</div>{test && <pre className="test-result">{test}</pre>}</div>
        </div>
      </section>
      <section className="settings-section"><div className="section-heading"><h3>Web search</h3><span className="subtle">{snapshot.webSearch.backend ? `${snapshot.webSearch.backend === 'serpapi' ? 'SerpApi' : 'Tavily'}${snapshot.webSearch.keys[snapshot.webSearch.backend] ? '' : ' · key missing'}` : 'Not configured'}</span></div>
        <div className="section-body"><p className="subtle">Used for web_search when the model has no built-in search, or when the workspace asks before each web request.</p>
          <div className="settings-form"><div className="form-grid"><label>Search API<select value={searchBackend} onChange={e => { setSearchBackend(e.target.value as SearchBackendId | ''); setSearchKey(''); setRemoveSearchKey(false); setSearchTest(''); }}><option value="">None</option><option value="serpapi">SerpApi</option><option value="tavily">Tavily</option></select></label>
            {searchBackend && <label>API key<input type="password" aria-label="Search API key" value={searchKey} onChange={e => setSearchKey(e.target.value)} placeholder={snapshot.webSearch.keys[searchBackend] ? 'Leave blank to keep saved key' : 'Enter API key'} /></label>}</div>
            {searchBackend && snapshot.webSearch.keys[searchBackend] && <label className="check"><input type="checkbox" checked={removeSearchKey} onChange={e => setRemoveSearchKey(e.target.checked)} /> Remove saved key</label>}
            <div className="row"><button className="primary" disabled={!searchDirty} onClick={() => void saveSearch()}>Save web search</button><button disabled={searchDirty || !snapshot.webSearch.backend || !snapshot.webSearch.keys[snapshot.webSearch.backend]} onClick={() => void testSearch()}>Test saved search</button></div>
            {searchTest && <small className="good">{searchTest}</small>}</div>
        </div>
      </section>
    </div><div className="dialog-actions"><span className="fill" /><button onClick={onClose}>Done</button></div>
  </div></div>;
}

const titleHint = (item: Conversation) => item.titleSource === 'user' ? 'Named by you. Clear the title to let the assistant name it.' : 'Named by the assistant. Rename to set your own title.';

function TitleInput({ value, onDone }: { value: string; onDone: (value: string | null) => void }) {
  const [draft, setDraft] = useState(value); const done = useRef(false);
  const finish = (result: string | null) => { if (done.current) return; done.current = true; onDone(result); };
  return <input className="title-input" autoFocus aria-label="Conversation title" value={draft} maxLength={70} placeholder="Leave blank to let the assistant name it" onFocus={e => e.currentTarget.select()} onChange={e => setDraft(e.target.value)} onBlur={() => finish(draft)}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finish(draft); } else if (e.key === 'Escape') { e.preventDefault(); finish(null); } }} />;
}

function NameDialog({ title, label, initial, onClose, onSave }: { title: string; label: string; initial: string; onClose: () => void; onSave: (value: string) => Promise<unknown> }) {
  const [value, setValue] = useState(initial);
  const save = () => { if (value.trim()) void onSave(value.trim()).then(result => { if (result !== null) onClose(); }); };
  return <div className="modal-backdrop" role="presentation"><div className="dialog name-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <div className="dialog-head"><h2>{title}</h2><button onClick={onClose} aria-label="Close">×</button></div>
    <div className="dialog-body"><div className="form-grid"><label className="wide">{label}<input autoFocus value={value} maxLength={60} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') onClose(); }} /></label></div></div>
    <div className="dialog-actions"><span className="fill" /><button onClick={onClose}>Cancel</button><button className="primary" disabled={!value.trim()} onClick={save}>Save</button></div>
  </div></div>;
}

function NotesDrawer({ connection, act, onClose }: { connection: ConnectionSummary; act: (action: () => Promise<unknown>) => Promise<unknown>; onClose: () => void }) {
  const [notes, setNotes] = useState<Note[]>([]); const [active, setActive] = useState<string | null>(null); const [title, setTitle] = useState(''); const [content, setContent] = useState('');
  useEffect(() => { let live = true; void api().listNotes(connection.id).then(values => { if (live) setNotes(values); }); return () => { live = false; }; }, [connection.id]);
  const select = (note: Note) => { setActive(note.id); setTitle(note.title); setContent(note.content); };
  const reload = async () => setNotes(await api().listNotes(connection.id));
  const save = async () => { const note = await act(() => api().saveNote(connection.id, { id: active ?? undefined, title, content })) as Note; if (note) { setActive(note.id); await reload(); } };
  return <aside className="notes-drawer"><div className="drawer-head"><div><strong>Connection notes</strong><small>{connection.name}</small></div><button onClick={onClose} aria-label="Close notes">×</button></div><div className="note-list"><button className="new-note" onClick={() => { setActive(null); setTitle(''); setContent(''); }}>+ New note</button>{notes.map(note => <button key={note.id} className={active === note.id ? 'selected' : ''} onClick={() => select(note)}>{note.title}</button>)}</div><div className="note-editor"><input aria-label="Note title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Note title" /><textarea aria-label="Note content" value={content} onChange={e => setContent(e.target.value)} placeholder="Machine purpose, configuration, discoveries…" /><div className="row"><button className="primary" disabled={!title.trim()} onClick={() => void save()}>Save note</button>{active && <button className="danger" onClick={() => void act(() => api().deleteNote(connection.id, active)).then(() => { setActive(null); setTitle(''); setContent(''); void reload(); })}>Delete</button>}</div></div></aside>;
}

export default function App() {
  const [theme, chooseTheme] = useState<ThemeName>(readTheme);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [titleEdit, setTitleEdit] = useState<{ id: string; place: 'heading' | 'history' } | null>(null); const [workspaceDialog, setWorkspaceDialog] = useState<'create' | 'rename' | null>(null); const [selectedConnection, setSelectedConnection] = useState<string | null>(null); const [secondConnection, setSecondConnection] = useState<string | null>(null);
  const [showSplit, setShowSplit] = useState(false); const [showNotes, setShowNotes] = useState(false); const [showHistory, setShowHistory] = useState(false); const [showTargets, setShowTargets] = useState(false); const [showCatalog, setShowCatalog] = useState(false); const [showProviders, setShowProviders] = useState(false);
  const [editConnection, setEditConnection] = useState<ConnectionSummary | 'new' | null>(null); const [draft, setDraft] = useState(''); const [message, setMessage] = useState(''); const [context, setContext] = useState<ChatContext | null>(null); const [chatWidth, setChatWidth] = useState(35);
  const transcript = useRef<HTMLDivElement>(null); const follow = useRef(true); const refreshSeq = useRef(0);
  const refresh = useCallback(async () => { const index = ++refreshSeq.current; const value = await api().snapshot(); if (index === refreshSeq.current) setSnapshot(value); }, []);
  useEffect(() => { void refresh().catch(error => setMessage(errorText(error))); return api().onChanged(() => { void refresh().catch(() => undefined); }); }, [refresh]);
  useEffect(() => { if (snapshot?.theme) { setTheme(snapshot.theme); chooseTheme(snapshot.theme); } }, [snapshot?.theme]);
  const act = useCallback(async (action: () => Promise<unknown>) => { try { const result = await action(); await refresh(); setMessage(''); return result; } catch (error) { setMessage(errorText(error)); return null; } }, [refresh]);
  const workspaceConnections = useMemo(() => snapshot?.connections.filter(item => snapshot.workspaceConnections.some(entry => entry.connectionId === item.id)) ?? [], [snapshot]);
  const conversation = snapshot?.conversations.find(c => c.id === snapshot.activeConversationId) ?? snapshot?.conversations.at(-1);
  const activeConnection = workspaceConnections.find(item => item.id === selectedConnection) ?? workspaceConnections[0];
  const splitConnection = workspaceConnections.find(item => item.id === secondConnection && item.id !== activeConnection?.id) ?? workspaceConnections.find(item => item.id !== activeConnection?.id);
  const messages = snapshot?.messages.filter(item => item.conversationId === conversation?.id) ?? [];
  const targets = snapshot?.workspaceConnections ?? [];
  const approval = snapshot?.approvals.find(item => item.conversationId === conversation?.id);
  const webAccess = snapshot?.workspaces.find(item => item.id === snapshot.activeWorkspaceId)?.webAccess ?? 'ask';
  useEffect(() => { if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }, [messages.length, messages.at(-1)?.text, approval?.id, conversation?.id]);
  useEffect(() => { if (!conversation) return; let live = true; const timer = setTimeout(() => { void api().chatContext(conversation.id, draft).then(value => { if (live) setContext(value); }).catch(() => { if (live) setContext(null); }); }, 300); return () => { live = false; clearTimeout(timer); }; }, [conversation?.id, draft, messages.length, messages.at(-1)?.text, snapshot?.providers.activeChat.modelId]);
  const selectedModel = snapshot?.providers.chatModels.find(item => item.id === snapshot.providers.activeChat.modelId);
  const submit = () => { if (!conversation || !draft.trim()) return; const text = draft.trim(); setDraft(''); follow.current = true; void act(() => api().sendMessage(conversation.id, text)); };
  const connect = (id: string) => void act(() => api().connect(id));
  const disconnect = (id: string) => void act(() => api().disconnect(id));
  const takeOver = (id: string) => void act(() => api().takeOver(id));
  const changeAccess = (id: string, access: AccessMode) => void act(() => api().setWorkspaceAccess(id, access));
  const changeWebAccess = (access: AccessMode) => void act(() => api().setWorkspaceWebAccess(access));
  const changeTheme = (value: ThemeName) => { setTheme(value); chooseTheme(value); void act(() => api().setTheme(value)); };
  const selectConversation = (id: string) => { follow.current = true; void act(() => api().setActiveConversation(id)); };
  const commitTitle = (item: Conversation, value: string | null) => {
    setTitleEdit(null);
    if (value === null || value.trim() === item.title || (!value.trim() && item.titleSource !== 'user')) return;
    void act(() => api().renameConversation(item.id, value.trim()));
  };
  const saveConnection = async (input: ConnectionInput) => { const result = await api().saveConnection(input); await refresh(); if (!result) throw new Error('Connection could not be saved.'); };
  if (!snapshot) return <div className="loading">Loading Shellmate…</div>;
  return <div className="app-shell">
    <header className="app-header"><div className="brand"><img className="brand-mark" src={logo} alt="" /><strong>shellmate</strong></div><div className="header-divider" /><select aria-label="Workspace" value={snapshot.activeWorkspaceId} onChange={e => void act(() => api().setActiveWorkspace(e.target.value)).then(() => setSelectedConnection(null))}>{snapshot.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button title="Rename workspace" onClick={() => setWorkspaceDialog('rename')}>Rename</button><button title="New workspace" onClick={() => setWorkspaceDialog('create')}>+ Workspace</button><span className="subtle">{workspaceConnections.length} connections</span><span className="fill" />
       <label className="theme-control">Theme <select aria-label="Theme" value={theme} onChange={e => changeTheme(e.target.value as ThemeName)}><option value="graphite">Graphite</option><option value="light">Light</option><option value="forest">Forest</option></select></label><button onClick={() => setShowProviders(true)}>Providers</button>
    </header>
    <div className="work-area" style={{ '--chat-width': `${chatWidth}%` } as React.CSSProperties}>
      <section className="chat-pane">
        <div className="chat-model-bar">
           <select className="model-select" aria-label="Chat model" value={snapshot.providers.activeChat.modelId} onChange={e => void act(() => api().setActiveChat({ modelId: e.target.value, effort: e.target.value.startsWith('codex:') ? 'medium' : snapshot.providers.chatModels.find(item => item.id === e.target.value)?.efforts[0] ?? '' }))}>{snapshot.providers.chatModels.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
          {selectedModel?.efforts.length ? <select className="effort-select" aria-label="Reasoning effort" value={snapshot.providers.activeChat.effort} onChange={e => void act(() => api().setActiveChat({ modelId: selectedModel.id, effort: e.target.value }))}>{selectedModel.efforts.map(item => <option key={item} value={item}>{item}</option>)}</select> : null}
        </div>
        <div className="chat-heading"><div className="overline">Conversation</div><div className="row">{conversation && titleEdit?.id === conversation.id && titleEdit.place === 'heading' ? <TitleInput value={conversation.title} onDone={value => commitTitle(conversation, value)} /> : <button className="conversation-title" title={conversation ? titleHint(conversation) : undefined} onClick={() => conversation && setTitleEdit({ id: conversation.id, place: 'heading' })}>{conversation?.title ?? 'New conversation'} <span className="subtle">✎</span></button>}<span className="fill" /><button className={showHistory ? 'selected' : ''} title="Conversation history" onClick={() => setShowHistory(!showHistory)}>History</button><button title="New conversation" onClick={() => void act(() => api().createConversation())}>＋</button></div></div>
        {showHistory && <div className="history-list">{[...snapshot.conversations].reverse().map(item => titleEdit?.id === item.id && titleEdit.place === 'history' ? <TitleInput key={item.id} value={item.title} onDone={value => commitTitle(item, value)} /> : <div key={item.id} className={`history-row ${item.id === conversation?.id ? 'selected' : ''}`}>
          <button className="history-open" title={titleHint(item)} onClick={() => { selectConversation(item.id); setShowHistory(false); }}><span className="history-title">{item.title}</span>{snapshot.activeTurns.includes(item.id) && <span className="agent-mark" title="Responding">✦</span>}{snapshot.approvals.some(approval => approval.conversationId === item.id) && <span className="needs-attention">!</span>}</button>
          <button title="Rename conversation" aria-label={`Rename ${item.title}`} onClick={() => setTitleEdit({ id: item.id, place: 'history' })}>✎</button><ConfirmButton label="×" confirmLabel="Delete?" title={snapshot.activeTurns.includes(item.id) ? 'Stop the response before deleting' : 'Delete conversation'} ariaLabel={`Delete ${item.title}`} disabled={snapshot.activeTurns.includes(item.id)} onConfirm={() => void act(() => api().deleteConversation(item.id))} />
        </div>)}</div>}
         <div className="target-bar"><span className="subtle">Workspace connections</span>{workspaceConnections.map(profile => { const access = targets.find(item => item.connectionId === profile.id)?.access ?? 'ask'; const connected = snapshot.terminals.some(item => item.connectionId === profile.id); return <button className={`target-chip ${access}`} key={profile.id} onClick={() => setSelectedConnection(profile.id)} title={`${profile.name}: ${connected ? 'connected' : 'disconnected'}, ${access}`}><span className={`status-dot ${connected ? 'on' : ''}`} />{profile.name} · {access}</button>; })}<button className={`target-chip web-chip ${webAccess}`} onClick={() => setShowTargets(true)} title={`Web access: ${webAccess}`}>🌐 Web · {accessLabel[webAccess]}</button><button title="Connection permissions" onClick={() => setShowTargets(!showTargets)}>Access</button></div>
         {showTargets && <div className="target-picker"><div className="overline">Workspace agent access</div><div className="settings-row"><span><strong>Web</strong><small>Built-in model search runs only in Autonomous mode.</small></span><span className="fill" /><select aria-label="Web access" value={webAccess} onChange={e => changeWebAccess(e.target.value as AccessMode)}><option value="disabled">Disabled</option><option value="ask">Ask before each search or fetch</option><option value="autonomous">Autonomous</option></select></div>{workspaceConnections.map(profile => { const access = targets.find(target => target.connectionId === profile.id)?.access ?? 'ask'; return <div className="settings-row" key={profile.id}><strong>{profile.name}</strong><span className="fill" /><select aria-label={`${profile.name} assistant access`} value={access} onChange={e => changeAccess(profile.id, e.target.value as AccessMode)}><option value="disabled">Disabled</option><option value="ask">Ask before commands</option><option value="autonomous">Autonomous</option></select></div>; })}{conversation && snapshot.activeTurns.includes(conversation.id) && <small className="subtle">New access and increases apply to the next message. Restrictions apply immediately.</small>}</div>}
        <div className="transcript" ref={transcript} onScroll={e => { const target = e.currentTarget; follow.current = target.scrollHeight - target.scrollTop - target.clientHeight < 50; }}>
           {!messages.length && <div className="chat-empty"><span className="sparkle">✦</span><h2>Ask about your machines</h2><p>Workspace connections are available here automatically. Shellmate asks before running commands by default.</p></div>}
          {messages.map(item => <div key={item.id} className={`message ${item.role}`}><div className="message-label">{item.role === 'assistant' ? '✦ Shellmate' : item.role === 'tool' ? `${snapshot.connections.find(c => c.id === item.targetId)?.name ?? (item.toolName?.startsWith('web_') ? 'Web' : item.toolName === 'compaction' ? 'Context' : 'Tool')} · ${item.toolName ?? 'activity'}` : 'You'}<span className="fill" /><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><div className="message-text">{item.text ? <LinkedText text={item.text} /> : item.status === 'running' ? 'Thinking…' : ''}</div>{item.sources?.length ? <div className="message-sources"><span className="overline">Sources</span>{item.sources.map((source, index) => <a key={source.url} href={source.url} onClick={openLink(source.url)} title={source.url}>{index + 1}. {sourceLabel(source)}</a>)}</div> : null}{item.status === 'failed' && <small className="error">Failed</small>}</div>)}
          {approval && <div className="approval-card">{approval.kind === 'command' ? <><div className="approval-title">◆ Approval required · {snapshot.connections.find(c => c.id === approval.connectionId)?.name}</div><p>The assistant requests permission to run this command:</p><pre>{approval.command}</pre></> : <><div className="approval-title">◆ Approval required · Web</div><p>{approval.action === 'search' ? 'The assistant requests permission to search the web for:' : 'The assistant requests permission to fetch this URL:'}</p><pre>{approval.detail}</pre></>}<div className="row"><button className="primary" onClick={() => void act(() => api().resolveApproval(approval.id, true))}>Approve once</button><button onClick={() => void act(() => api().resolveApproval(approval.id, false))}>Reject</button></div></div>}
        </div>
         <div className="composer-shell"><div className="composer"><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} placeholder="Ask about your machines…" aria-label="Message Shellmate" /><div className="row"><span className="subtle">{targets.filter(item => item.access !== 'disabled').length} connections available</span><span className="fill" />{conversation && snapshot.activeTurns.includes(conversation.id) ? <button onClick={() => void act(() => api().cancelTurn(conversation.id))}>Stop response</button> : <button className="primary" onClick={submit} disabled={!draft.trim()}>Send ↑</button>}</div></div><div className="composer-meta"><span>Enter to send · Shift+Enter for newline</span><span>{context ? `Context ~${Math.round(context.tokens / 1000)}k${context.limit ? ` / ${Math.round(context.limit / 1000)}k` : ''}` : 'Context unavailable'}</span></div></div>
      </section>
      <div className="resize-handle" role="separator" aria-label="Resize chat" onPointerDown={event => { const start = event.clientX; const original = chatWidth; const total = event.currentTarget.parentElement?.clientWidth ?? 1200; event.currentTarget.setPointerCapture(event.pointerId); const move = (e: PointerEvent) => setChatWidth(Math.max(28, Math.min(48, original + (e.clientX - start) / total * 100))); const stop = () => { event.currentTarget.removeEventListener('pointermove', move); event.currentTarget.removeEventListener('pointerup', stop); }; event.currentTarget.addEventListener('pointermove', move); event.currentTarget.addEventListener('pointerup', stop); }} />
      <section className="terminal-area"><div className="terminal-tabs">{workspaceConnections.map(item => { const connected = snapshot.terminals.find(session => session.connectionId === item.id); return <button key={item.id} className={item.id === activeConnection?.id ? 'selected' : ''} onClick={() => setSelectedConnection(item.id)}><span className={`status-dot ${connected ? 'on' : ''}`} />{item.name}{connected?.owner && <span className="agent-mark" title="Agent controlling">✦</span>}</button>; })}<button onClick={() => setShowCatalog(!showCatalog)}>＋ Connections</button><span className="fill" /></div>
         {showCatalog && <div className="catalog"><div className="row"><strong>Connection catalog</strong><span className="fill" /><button onClick={() => setEditConnection('new')}>New connection</button><button onClick={() => setShowCatalog(false)} aria-label="Close catalog">×</button></div>{snapshot.connections.map(item => { const included = snapshot.workspaceConnections.some(entry => entry.connectionId === item.id); return <div className="settings-row" key={item.id}><strong>{item.name}</strong><span className="subtle">{item.kind === 'ssh' ? item.host : 'Local'}</span><span className="fill" /><button onClick={() => void act(() => api().setWorkspaceConnection(item.id, !included))}>{included ? 'Remove from workspace' : 'Open in workspace'}</button><button onClick={() => setEditConnection(item)}>Edit</button></div>; })}</div>}
        <div className="terminal-toolbar">{activeConnection ? <><span className="subtle">{activeConnection.kind === 'ssh' ? `${activeConnection.username}@${activeConnection.host}` : 'Local shell'}</span><span className="fill" /><button className={showSplit ? 'selected' : ''} onClick={() => setShowSplit(!showSplit)} disabled={workspaceConnections.length < 2}>◫ Split</button><button className={showNotes ? 'selected' : ''} onClick={() => setShowNotes(!showNotes)}>▤ Notes</button></> : <><span className="subtle">Add a connection to this workspace to begin.</span><span className="fill" /><button className="primary" onClick={() => setEditConnection('new')}>Add connection</button></>}</div>
         <div className="stage-body">{activeConnection ? <><div className={`terminals ${showSplit && splitConnection ? 'split' : ''}`}><TerminalPane key={activeConnection.id} profile={activeConnection} session={snapshot.terminals.find(session => session.connectionId === activeConnection.id)} theme={theme} onConnect={() => connect(activeConnection.id)} onDisconnect={() => disconnect(activeConnection.id)} onTakeOver={() => takeOver(activeConnection.id)} />{showSplit && splitConnection && <TerminalPane key={splitConnection.id} profile={splitConnection} session={snapshot.terminals.find(session => session.connectionId === splitConnection.id)} theme={theme} onConnect={() => connect(splitConnection.id)} onDisconnect={() => disconnect(splitConnection.id)} onTakeOver={() => takeOver(splitConnection.id)} />}</div>{showNotes && <NotesDrawer connection={activeConnection} act={act} onClose={() => setShowNotes(false)} />}</> : <div className="terminal-empty"><span className="terminal-empty-icon">⌘</span><strong>No connections in this workspace</strong><span>Create a local shell or SSH connection to begin.</span><button className="primary" onClick={() => setEditConnection('new')}>Add connection</button></div>}</div>
      </section>
    </div>
    <footer className="statusbar"><span>◆</span> Shellmate <span className="fill" />{snapshot.workspaces.find(item => item.id === snapshot.activeWorkspaceId)?.name} · Local data</footer>
    {message && <div className="toast" role="alert"><span>{message}</span><button onClick={() => setMessage('')}>×</button></div>}
    {snapshot.hostKeys.map(request => <div className="modal-backdrop" key={request.id}><div className="dialog attention-dialog" role="dialog" aria-modal="true" aria-label="SSH host key"><h2>{request.changed ? 'SSH host key changed' : 'Trust SSH host key?'}</h2><p>{request.host}:{request.port}</p><p>SHA-256 fingerprint</p><code>{request.fingerprint}</code><p className="subtle">Verify this fingerprint using a trusted source before accepting it.</p><div className="dialog-actions"><span className="fill" /><button onClick={() => void act(() => api().trustHostKey(request.id, false))}>Reject</button><button className="primary" onClick={() => void act(() => api().trustHostKey(request.id, true))}>Trust and connect</button></div></div></div>)}
    {snapshot.elevations.map(request => <ElevationDialog key={request.id} request={request} act={act} />)}
    {editConnection && <ConnectionDialog profile={editConnection === 'new' ? undefined : editConnection} onClose={() => setEditConnection(null)} onSave={saveConnection} onDelete={editConnection === 'new' ? undefined : async () => { await api().deleteConnection(editConnection.id); await refresh(); }} />}
    {showProviders && <ProvidersDialog snapshot={snapshot} onClose={() => setShowProviders(false)} act={act} />}
    {workspaceDialog === 'create' && <NameDialog title="New workspace" label="Workspace name" initial="" onClose={() => setWorkspaceDialog(null)} onSave={name => act(() => api().createWorkspace(name)).then(result => { if (result !== null) setSelectedConnection(null); return result; })} />}
    {workspaceDialog === 'rename' && <NameDialog title="Rename workspace" label="Workspace name" initial={snapshot.workspaces.find(item => item.id === snapshot.activeWorkspaceId)?.name ?? ''} onClose={() => setWorkspaceDialog(null)} onSave={name => act(() => api().renameWorkspace(snapshot.activeWorkspaceId, name))} />}
  </div>;
}

function ElevationDialog({ request, act }: { request: Snapshot['elevations'][number]; act: (action: () => Promise<unknown>) => Promise<unknown> }) {
  const [password, setPassword] = useState('');
  return <div className="modal-backdrop"><div className="dialog attention-dialog" role="dialog" aria-modal="true" aria-label="Terminal password request"><h2>Terminal password requested</h2><p>The agent’s command is waiting at this terminal prompt:</p><code>{request.prompt}</code><pre>{request.command}</pre><input autoFocus type="password" aria-label="Terminal password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void act(() => api().respondElevation(request.id, password)); }} /><div className="dialog-actions"><button onClick={() => void act(() => api().respondElevation(request.id, null))}>Cancel command</button><span className="fill" /><button className="primary" onClick={() => void act(() => api().respondElevation(request.id, password))}>Send to terminal</button></div></div></div>;
}
