// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ANSWER_MODEL,
  type OverlayPreset,
  type PublicSettings,
  type TranscriptionProvider,
} from './types/contracts';

interface PersistedStore {
  encryptedApiKey?: string;
  encryptedDeepgramApiKey?: string;
  language?: string;
  model?: string;
  overlayPreset?: OverlayPreset;
  overlayOpacity?: number;
  historyEnabled?: boolean;
  transcriptionProvider?: TranscriptionProvider;
}

const DEFAULT_SETTINGS: Omit<PublicSettings, 'apiKeyStored' | 'deepgramApiKeyStored'> = {
  language: 'en',
  model: DEFAULT_ANSWER_MODEL,
  overlayPreset: 'bottom-right',
  overlayOpacity: 0.95,
  historyEnabled: false,
  // Groq needs no second key and is free on the free tier.
  transcriptionProvider: 'groq',
};

/**
 * `basic_text` is Electron's Linux fallback when no keyring is available. It
 * "encrypts" with a hardcoded password, so the ciphertext is trivially
 * reversible — but `isEncryptionAvailable()` still returns true, which is how a
 * key ends up effectively plaintext in settings.json while the UI claims it is
 * in the OS keychain.
 */
const INSECURE_STORAGE_BACKENDS = new Set(['basic_text']);

const MAX_API_KEY_LENGTH = 512;

export function encryptionStatus(): { available: boolean; reason: string | null } {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      available: false,
      reason:
        'This device has no OS credential store available, so WingMan will not write your API key to disk.',
    };
  }

  if (process.platform === 'linux') {
    let backend = '';
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      // Older Electron, or a platform without the API: fall through and trust
      // isEncryptionAvailable().
      return { available: true, reason: null };
    }

    if (INSECURE_STORAGE_BACKENDS.has(backend)) {
      return {
        available: false,
        reason:
          'No system keyring was found (gnome-keyring or kwallet). Storing your API key here would leave it recoverable in plain text, so WingMan will not save it. Install a keyring, or set GROQ_API_KEY in the environment for this session.',
      };
    }
  }

  return { available: true, reason: null };
}

function requireEncryption() {
  const status = encryptionStatus();
  if (!status.available) {
    throw new Error(status.reason ?? 'OS encryption is unavailable on this device.');
  }
}

export class SecureStore {
  constructor(private readonly userDataPath: string) {}

  private get filePath() {
    return path.join(this.userDataPath, 'settings.json');
  }

  /**
   * True once a readable settings file has been seen.
   *
   * A read failure is indistinguishable from "no file yet" at the fs level, and
   * treating both as `{}` meant one truncated write turned into permanent,
   * silent loss of both encrypted API keys the next time any setting changed.
   */
  private storeIsReadable = false;

  private async readStore(): Promise<PersistedStore> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.storeIsReadable = true;
        return {};
      }
      this.storeIsReadable = false;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedStore;
      this.storeIsReadable = true;
      return parsed;
    } catch {
      // Preserve the damaged file instead of overwriting it: it is the only
      // copy of the encrypted keys, and it may still be recoverable by hand.
      this.storeIsReadable = false;
      const backupPath = `${this.filePath}.corrupt`;
      try {
        await fs.rename(this.filePath, backupPath);
        console.error(
          `[wingman] settings.json was unreadable and has been moved to ${backupPath}. Re-enter your API key.`,
        );
        this.storeIsReadable = true;
      } catch (renameError) {
        console.error('[wingman] Could not quarantine settings.json.', renameError);
      }
      return {};
    }
  }

  private async writeStore(next: PersistedStore) {
    await fs.mkdir(this.userDataPath, { recursive: true });

    // Write-then-rename. A direct write that is interrupted (power loss, a full
    // disk) leaves a truncated file, and the recovery path above cannot tell a
    // truncated file from a missing one.
    //
    // mode 0o600 because the default is 0o666 & ~umask, i.e. 0o644 on a typical
    // POSIX box — world-readable. The API keys inside are safeStorage
    // ciphertext rather than plaintext, but there is no reason to hand every
    // local account the ciphertext and the chance to tamper with it. The mode
    // is set on the temp file so the window between create and rename is not
    // itself readable; it is ignored on Windows, where the ACL inherited from
    // userData already governs access.
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(next, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Merge onto disk state, refusing to merge onto a failed read. */
  private async mergeStore(patch: PersistedStore, remove: (keyof PersistedStore)[] = []) {
    const current = await this.readStore();
    if (!this.storeIsReadable) {
      throw new Error(
        'WingMan could not read its settings file, so it will not overwrite it. Check the log for details.',
      );
    }

    const merged: PersistedStore = { ...current, ...patch };
    for (const key of remove) {
      delete merged[key];
    }
    await this.writeStore(merged);
    return merged;
  }

  async getSettings(): Promise<PublicSettings> {
    const store = await this.readStore().catch(() => ({}) as PersistedStore);
    return {
      language: store.language ?? DEFAULT_SETTINGS.language,
      model: store.model ?? DEFAULT_SETTINGS.model,
      overlayPreset: store.overlayPreset ?? DEFAULT_SETTINGS.overlayPreset,
      overlayOpacity: store.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity,
      historyEnabled: store.historyEnabled ?? DEFAULT_SETTINGS.historyEnabled,
      transcriptionProvider:
        store.transcriptionProvider ?? DEFAULT_SETTINGS.transcriptionProvider,
      apiKeyStored: Boolean(store.encryptedApiKey || process.env.GROQ_API_KEY?.trim()),
      deepgramApiKeyStored: Boolean(store.encryptedDeepgramApiKey),
    };
  }

  async updateSettings(
    updates: Partial<Omit<PublicSettings, 'apiKeyStored' | 'deepgramApiKeyStored'>>,
  ): Promise<PublicSettings> {
    await this.mergeStore(updates as PersistedStore);
    return this.getSettings();
  }

  private encryptKey(apiKey: unknown): string {
    if (typeof apiKey !== 'string') {
      throw new Error('API key must be a string.');
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error('API key cannot be empty.');
    }
    // No provider issues keys anywhere near this long; the bound is here so an
    // arbitrarily large string cannot be written into settings.json.
    if (trimmed.length > MAX_API_KEY_LENGTH) {
      throw new Error('That API key is not valid.');
    }

    requireEncryption();
    return safeStorage.encryptString(trimmed).toString('base64');
  }

  private decryptKey(encrypted: string | undefined): string | null {
    if (!encrypted) {
      return null;
    }

    requireEncryption();
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (error) {
      // A key encrypted under a different OS user, machine or keyring cannot be
      // recovered. Say so rather than surfacing a raw decrypt failure.
      console.error('[wingman] Stored API key could not be decrypted.', error);
      throw new Error(
        'Your saved API key could not be decrypted on this machine. Please re-enter it.',
      );
    }
  }

  async saveApiKey(apiKey: string) {
    await this.mergeStore({ encryptedApiKey: this.encryptKey(apiKey) });
  }

  async clearApiKey() {
    await this.mergeStore({}, ['encryptedApiKey']);
  }

  async getApiKey(): Promise<string | null> {
    const current = await this.readStore();
    return this.decryptKey(current.encryptedApiKey);
  }

  async saveDeepgramApiKey(apiKey: string) {
    await this.mergeStore({ encryptedDeepgramApiKey: this.encryptKey(apiKey) });
  }

  async clearDeepgramApiKey() {
    await this.mergeStore({}, ['encryptedDeepgramApiKey']);
  }

  async getDeepgramApiKey(): Promise<string | null> {
    const current = await this.readStore();
    return this.decryptKey(current.encryptedDeepgramApiKey);
  }
}
