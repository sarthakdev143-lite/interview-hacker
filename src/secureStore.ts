import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OverlayPreset, PublicSettings } from './types/contracts';

interface PersistedStore {
  encryptedApiKey?: string;
  language?: string;
  model?: string;
  overlayPreset?: OverlayPreset;
  overlayOpacity?: number;
  historyEnabled?: boolean;
}

const DEFAULT_SETTINGS: Omit<PublicSettings, 'apiKeyStored'> = {
  language: 'en',
  model: 'llama-3.3-70b-versatile',
  overlayPreset: 'bottom-right',
  overlayOpacity: 0.95,
  historyEnabled: false,
};

export class SecureStore {
  constructor(private readonly userDataPath: string) {}

  private get filePath() {
    return path.join(this.userDataPath, 'settings.json');
  }

  private async readStore(): Promise<PersistedStore> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as PersistedStore;
    } catch {
      return {};
    }
  }

  private async writeStore(next: PersistedStore) {
    await fs.mkdir(this.userDataPath, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2), 'utf8');
  }

  async getSettings(): Promise<PublicSettings> {
    const store = await this.readStore();
    return {
      language: store.language ?? DEFAULT_SETTINGS.language,
      model: store.model ?? DEFAULT_SETTINGS.model,
      overlayPreset: store.overlayPreset ?? DEFAULT_SETTINGS.overlayPreset,
      overlayOpacity: store.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity,
      historyEnabled: store.historyEnabled ?? DEFAULT_SETTINGS.historyEnabled,
      apiKeyStored: Boolean(store.encryptedApiKey || process.env.GROQ_API_KEY?.trim()),
    };
  }

  async updateSettings(
    updates: Partial<Omit<PublicSettings, 'apiKeyStored'>>,
  ): Promise<PublicSettings> {
    const current = await this.readStore();
    const merged: PersistedStore = {
      ...current,
      ...updates,
    };
    await this.writeStore(merged);
    return this.getSettings();
  }

  async saveApiKey(apiKey: string) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable on this device.');
    }

    const current = await this.readStore();
    const encrypted = safeStorage.encryptString(apiKey).toString('base64');
    await this.writeStore({
      ...current,
      encryptedApiKey: encrypted,
    });
  }

  async clearApiKey() {
    const current = await this.readStore();
    delete current.encryptedApiKey;
    await this.writeStore(current);
  }

  async getApiKey(): Promise<string | null> {
    const current = await this.readStore();
    if (!current.encryptedApiKey) {
      return null;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable on this device.');
    }

    return safeStorage.decryptString(
      Buffer.from(current.encryptedApiKey, 'base64'),
    );
  }
}
