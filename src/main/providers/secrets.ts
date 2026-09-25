import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type Ciphertext = Buffer | Uint8Array | string;
export type EncryptSecret = (plaintext: string) => Ciphertext | Promise<Ciphertext>;
export type DecryptSecret = (ciphertext: Buffer) => string | Promise<string>;

export interface SecureStoreOptions {
  /** A directory in the app's user-data area, never the repository. */
  directory?: string;
  encrypt: EncryptSecret;
  decrypt: DecryptSecret;
  isAvailable: () => boolean | Promise<boolean>;
}

function defaultDirectory(): string {
  const appData = process.env.APPDATA;
  if (process.platform === 'win32' && appData) return path.join(appData, 'Shellmate');
  return path.join(os.homedir(), '.config', 'shellmate');
}

function safeName(name: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid secure-store key.');
  return name;
}

/**
 * Builds a store-safe secret name for a namespaced id. Names may not contain path
 * separators, so callers must not use "/" between the namespace and the id.
 */
export function secretName(namespace: string, id: string): string {
  return safeName(`${namespace}-${id}`);
}

function toBuffer(value: Ciphertext): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  return Buffer.from(value);
}

/**
 * Small file-backed store for values already protected by the platform's
 * encryption primitive. Plaintext is never written and a missing platform
 * primitive is an explicit configuration error.
 */
export class SecureStore {
  private readonly directory: string;

  constructor(private readonly options: SecureStoreOptions) {
    this.directory = options.directory ?? defaultDirectory();
  }

  async available(): Promise<boolean> {
    return Boolean(await this.options.isAvailable());
  }

  private async requireAvailable(): Promise<void> {
    if (!(await this.available())) throw new Error('Secure storage is unavailable on this device.');
  }

  private file(name: string): string {
    return path.join(this.directory, `${safeName(name)}.bin`);
  }

  async get(name: string): Promise<string | null> {
    await this.requireAvailable();
    try {
      const encrypted = await fs.readFile(this.file(name));
      return await this.options.decrypt(encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Unable to read secure storage.');
    }
  }

  async set(name: string, value: string): Promise<void> {
    await this.requireAvailable();
    if (typeof value !== 'string') throw new Error('Secure-store values must be strings.');
    await fs.mkdir(this.directory, { recursive: true });
    const destination = this.file(name);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const encrypted = toBuffer(await this.options.encrypt(value));
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(encrypted);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async delete(name: string): Promise<void> {
    await this.requireAvailable();
    await fs.rm(this.file(name), { force: true });
  }
}
