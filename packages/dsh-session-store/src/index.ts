/**
 * DSH session storage: discovery, listing, search, trash, and transfer.
 *
 * DSH discovers sessions by scanning the filesystem rather than by consulting
 * a registry, so this package can read and manage a harness home without
 * loading the harness. That is what makes it usable as a standalone CLI and as
 * a plugin running inside DSH itself.
 *
 * ```ts
 * const store = new SessionStore({ home: join(homedir(), '.dsh') });
 * await store.refresh();
 * const hits = store.search({ text: 'quantum' });
 * ```
 *
 * @module
 */

export { discoverArtifacts, isCurrentGeneration, readHeader } from './discover.ts';
export type { DiscoveredArtifact, SessionRecord } from './discover.ts';

export { SessionStore } from './store.ts';
export type {
  SearchQuery,
  SessionStoreOptions,
  TrashedSession,
  WorkspaceGroup,
} from './store.ts';

export {
  exportBundle,
  importBundle,
  readBundleManifest,
  verifyBundle,
  type BundleEntry,
  type BundleManifest,
  type ImportReport,
} from './bundle.ts';
