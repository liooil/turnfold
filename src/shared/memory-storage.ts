// 内存版 Storage（shared，无平台依赖）：测试与临时会话用。
import type {Storage, StorageCapability, StorageEntry} from "./storage";

export class MemoryStorage implements Storage {
  private readonly values = new Map<string, Uint8Array>();
  private readonly updated = new Map<string, string>();

  constructor(
    public readonly id: string,
    private readonly capabilityValue: StorageCapability
  ) {}

  async capability() {
    return this.capabilityValue;
  }

  async list(prefix = "") {
    const entries: StorageEntry[] = [];
    for (const [key, data] of this.values) {
      if (!key.startsWith(prefix)) continue;
      entries.push({key, size: data.byteLength, updatedAt: this.updated.get(key) || ""});
    }
    return entries.sort((left, right) => left.key.localeCompare(right.key));
  }

  async read(key: string) {
    return this.values.get(key)?.slice() ?? null;
  }

  async write(key: string, data: Uint8Array) {
    this.values.set(key, data.slice());
    this.updated.set(key, new Date().toISOString());
  }

  async remove(key: string) {
    this.values.delete(key);
    this.updated.delete(key);
  }

  async readMany(keys: string[]) {
    return keys.map((key) => this.values.get(key)?.slice() ?? null);
  }

  async writeMany(entries: Array<{key: string; data: Uint8Array}>) {
    const timestamp = new Date().toISOString();
    for (const {key, data} of entries) {
      this.values.set(key, data.slice());
      this.updated.set(key, timestamp);
    }
  }

  async removeMany(keys: string[]) {
    for (const key of keys) {
      this.values.delete(key);
      this.updated.delete(key);
    }
  }
}
