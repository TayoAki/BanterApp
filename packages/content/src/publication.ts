import type { PublicationStatus } from '@marshmemos/contracts';
import production from './publication/production.json' with { type: 'json' };
import development from './publication/development.json' with { type: 'json' };

export type ManifestName = 'production' | 'development';

export interface PublicationManifest {
  manifest: ManifestName;
  note: string;
  publish_all_drafts?: boolean;
  frameworks: Record<string, { status: PublicationStatus; reviewed_by?: string; reviewed_at?: string }>;
  prompts: Record<string, { status: PublicationStatus; reviewed_by?: string; reviewed_at?: string }>;
  lessons: Record<string, { status: PublicationStatus; reviewed_by?: string; reviewed_at?: string }>;
  examples: Record<string, { status: PublicationStatus; reviewed_by?: string; reviewed_at?: string }>;
}

const MANIFESTS: Record<ManifestName, PublicationManifest> = {
  production: production as PublicationManifest,
  development: development as PublicationManifest,
};

export function loadManifest(name: ManifestName): PublicationManifest {
  return MANIFESTS[name];
}

export type ContentKind = 'frameworks' | 'prompts' | 'lessons' | 'examples';

/**
 * Effective publication status: an explicit manifest entry wins; otherwise
 * the seed status, except the development manifest treats drafts as
 * published so the flow can run locally (clearly labeled, never in prod).
 */
export function effectiveStatus(
  manifest: PublicationManifest,
  kind: ContentKind,
  id: string,
  seedStatus: PublicationStatus,
): PublicationStatus {
  const entry = manifest[kind][id];
  if (entry) return entry.status;
  if (manifest.publish_all_drafts && seedStatus === 'draft') return 'published';
  return seedStatus;
}

export interface Viewer {
  /** Server-held capability, never a client flag. */
  editor: boolean;
}

/** Whether a viewer may see an item with the given effective status. */
export function visibleTo(viewer: Viewer, status: PublicationStatus): boolean {
  if (status === 'published') return true;
  if (status === 'draft') return viewer.editor;
  return false; // retired content is hidden from everyone in listings
}
