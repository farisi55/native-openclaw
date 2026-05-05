/**
 * storage/index.ts
 * Barrel — re-exports the storage layer.
 */

export { JsonStore, KVStore } from './json-store';
export type { StoreRecord, JsonStoreOptions, KVStoreOptions } from './json-store';

export { SessionManager } from './session-manager';
export type { Session, CreateSessionOptions, AppendMessageOptions } from './session-manager';

export { SettingsManager } from './settings-manager';
export type { AppSettings } from './settings-manager';

export { MemoryManager } from './memory-manager';
export type { GlobalMemory, SessionMemory, MemoryStore, MemoryValue } from './memory-manager';
