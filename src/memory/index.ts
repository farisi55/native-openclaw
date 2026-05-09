/**
 * memory/index.ts
 * Barrel — re-exports the memory layer.
 */
export { SemanticMemory } from './semantic-memory';
export type { MemoryChunk, RetrievedMemory } from './semantic-memory';

export { ContextCompressor } from './context-compressor';
export type { CompressionOptions, CompressedContext } from './context-compressor';
