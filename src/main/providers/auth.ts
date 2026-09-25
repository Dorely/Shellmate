import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { SecureStore } from './secrets';

const AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const FLOW_TTL_MS = 10 * 60 * 1000;
const TOKEN_KEY = 'codex-oauth';

export type AuthStatus = { ready: boolean; pending: boolean; error: string | null };
export interface CodexAuthOptions {
  store: SecureStore;
  openExternal: (url: string) => void | Promise<void>;
  onChange?: (status: AuthStatus) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  redirectUri?: string;
}
type OAuthTokens = { accessToken: string; refreshToken?: string; expiresAt: number; scope?: string };
type PendingFlow = { state: string; verifier: string; createdAt: number; generation: number; server: Server; expiryTimer: ReturnType<typeof setTimeout> };

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message && !/token|secret|authorization|refresh/i.test(error.message)) return error.message;
  return fallback;
};

function verifier(): string {
  return randomBytes(32).toString('base64url');
}
function challenge(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url');
}
function randomState(): string { return randomBytes(24).toString('hex'); }

export class CodexAuth {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly redirectUri: string;
  private pending: PendingFlow | null = null;
  private statusValue: AuthStatus = { ready: false, pending: false, error: null };
  private tokens: OAuthTokens | null = null;
  private loadPromise: Promise<void> | null = null;
  private refreshPromise: Promise<string | null> | null = null;
  private mutationChain: Promise<void> = Promise.resolve();
  private refreshBlocked = false;
  private generation = 0;

  constructor(private readonly options: CodexAuthOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.redirectUri = options.redirectUri ?? REDIRECT_URI;
  }

  get status(): AuthStatus { return { ...this.statusValue }; }
  getStatus(): AuthStatus { return this.status; }

  /** Load persisted readiness for snapshots without refreshing or contacting a provider. */
  async initialize(): Promise<void> {
    try { await this.load(); }
    catch (error) { this.change({ ready: false, error: errorMessage(error, 'Secure storage is unavailable.') }); }
  }

  private change(patch: Partial<AuthStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.options.onChange?.(this.status);
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      const loadGeneration = this.generation;
      this.loadPromise = this.options.store.get(TOKEN_KEY).then(raw => {
        if (loadGeneration !== this.generation) return;
        if (!raw) return;
        try {
          const value = JSON.parse(raw) as OAuthTokens;
          if (typeof value.accessToken === 'string' && typeof value.expiresAt === 'number') this.tokens = value;
        } catch { /* Treat corrupt credentials as absent. */ }
        this.change({ ready: Boolean(this.tokens?.accessToken), error: null });
      });
    }
    await this.loadPromise;
  }

  async startLogin(): Promise<void> {
    await this.load();
    await this.cancelLogin();
    const flowGeneration = ++this.generation;
    const codeVerifier = verifier();
    const state = randomState();
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', this.redirectUri);
      if (requestUrl.pathname !== new URL(this.redirectUri).pathname) { response.writeHead(404).end(); return; }
      const code = requestUrl.searchParams.get('code');
      const returnedState = requestUrl.searchParams.get('state');
      const error = requestUrl.searchParams.get('error');
      void this.handleCallback(code, returnedState, error);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Shellmate</title>You may close this window.');
    });
    await new Promise<void>((resolve, reject) => server.listen(1455, '127.0.0.1', () => resolve()).once('error', reject));
    const expiryTimer = setTimeout(() => {
      if (this.pending?.state !== state) return;
      this.pending = null;
      this.generation++;
      server.close();
      this.change({ pending: false, error: 'Codex sign-in expired or was cancelled.' });
    }, FLOW_TTL_MS);
    expiryTimer.unref?.();
    const pending: PendingFlow = { state, verifier: codeVerifier, createdAt: this.now(), generation: flowGeneration, server, expiryTimer };
    this.pending = pending;
    this.change({ pending: true, error: null });
    const url = new URL(AUTH_ENDPOINT);
    url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: this.redirectUri, scope: SCOPE, state, code_challenge: challenge(codeVerifier), code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'pi' }).toString();
    try { await this.options.openExternal(url.toString()); } catch (error) { await this.cancelLogin(); this.change({ error: errorMessage(error, 'Unable to open the Codex sign-in page.') }); throw new Error('Unable to open the Codex sign-in page.'); }
  }

  /** Complete a loopback callback; exposed for a host that owns the HTTP route. */
  async handleCallback(code: string | null, state: string | null, oauthError: string | null = null): Promise<void> {
    await this.finishCallback(code, state, oauthError);
  }

  async cancelLogin(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    this.generation++;
    if (pending) {
      clearTimeout(pending.expiryTimer);
      await new Promise<void>(resolve => pending.server.close(() => resolve()));
    }
    this.change({ pending: false });
  }

  async logout(): Promise<void> {
    this.generation++;
    const inFlightRefresh = this.refreshPromise;
    await this.cancelLogin();
    // Let an already-started refresh observe the generation change before
    // removing the credential. This prevents a late refresh from restoring a
    // token after logout.
    if (inFlightRefresh) await inFlightRefresh.catch(() => undefined);
    this.tokens = null;
    this.refreshBlocked = false;
    this.refreshPromise = null;
    await this.mutationChain.catch(() => undefined);
    await this.options.store.delete(TOKEN_KEY);
    this.change({ ready: false, error: null });
  }

  async getAccessToken(): Promise<string> {
    await this.load();
    if (this.tokens && this.tokens.expiresAt > this.now() + 30_000) return this.tokens.accessToken;
    if (this.refreshBlocked) throw new Error('Codex sign-in expired; please sign in again.');
    if (!this.tokens?.refreshToken) throw new Error('Codex is not signed in.');
    const requestGeneration = this.generation;
    if (!this.refreshPromise) this.refreshPromise = this.refresh(this.tokens, this.generation).finally(() => { this.refreshPromise = null; });
    const token = await this.refreshPromise;
    if (!token) {
      if (requestGeneration === this.generation) this.change({ ready: false, error: 'Codex sign-in expired; please sign in again.' });
      throw new Error('Codex sign-in expired; please sign in again.');
    }
    return token;
  }

  private async finishCallback(code: string | null, state: string | null, oauthError: string | null): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.expiryTimer);
    this.change({ pending: false });
    // The browser may keep the callback response connection alive. Do not
    // make the token exchange wait for that connection to drain.
    pending.server.close();
    if (!state || state !== pending.state || pending.generation !== this.generation || this.now() - pending.createdAt > FLOW_TTL_MS) { this.change({ error: 'Codex sign-in expired or was cancelled.' }); return; }
    if (oauthError || !code) { this.change({ error: 'Codex sign-in was cancelled.' }); return; }
    try {
      const response = await this.fetcher(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: this.redirectUri, code_verifier: pending.verifier }), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('OAuth exchange failed.');
      const json = await response.json() as Record<string, unknown>;
      const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
      const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
      if (!accessToken) throw new Error('OAuth exchange failed.');
      const next: OAuthTokens = { accessToken, expiresAt: this.now() + expiresIn * 1000, refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined, scope: typeof json.scope === 'string' ? json.scope : undefined };
      if (pending.generation !== this.generation) return;
      if (!await this.persist(next, pending.generation)) return;
      this.tokens = next;
      this.refreshBlocked = false;
      this.change({ ready: true, pending: false, error: null });
    } catch (error) { this.change({ ready: false, pending: false, error: errorMessage(error, 'Codex sign-in failed.') }); }
  }

  private async refresh(previous: OAuthTokens, generation: number): Promise<string | null> {
    const response = await this.fetcher(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: previous.refreshToken! }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) this.refreshBlocked = true;
      return null;
    }
    const json = await response.json() as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
    if (!accessToken || generation !== this.generation || !this.tokens) return null;
    const next: OAuthTokens = { accessToken, expiresAt: this.now() + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000, refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : previous.refreshToken, scope: typeof json.scope === 'string' ? json.scope : previous.scope };
    if (!await this.persist(next, generation)) return null;
    this.tokens = next;
    this.refreshBlocked = false;
    this.change({ ready: true, error: null });
    return accessToken;
  }

  private async persist(next: OAuthTokens, generation: number): Promise<boolean> {
    let persisted = false;
    const operation = this.mutationChain.then(async () => {
      if (generation !== this.generation) return;
      await this.options.store.set(TOKEN_KEY, JSON.stringify(next));
      if (generation !== this.generation) {
        // Logout waits for this operation before deleting, so this cleanup
        // cannot race a newer credential write.
        const current = await this.options.store.get(TOKEN_KEY);
        if (current === JSON.stringify(next)) await this.options.store.delete(TOKEN_KEY);
        return;
      }
      persisted = true;
    });
    this.mutationChain = operation.catch(() => undefined);
    await operation;
    return persisted;
  }
}
