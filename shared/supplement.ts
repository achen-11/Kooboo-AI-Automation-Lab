import type { MaterialFile } from './automation.js';

export type SupplementMode = 'manual' | 'ai-assisted';
export type SupplementStatus = 'collecting' | 'ready' | 'applied' | 'failed' | 'cancelled';

export interface SupplementalFileRef extends MaterialFile {
  source: 'manual' | 'ai-doc' | 'ai-screenshot' | 'ai-asset';
  sourceUrl?: string;
  description?: string;
}

export interface SupplementPreviewSummary {
  headline: string;
  collectedFrom: string[];
  highlights: string[];
  gaps: string[];
  selectedFiles: string[];
}

export interface TaskSupplementBatch {
  id: string;
  taskId: string;
  mode: SupplementMode;
  status: SupplementStatus;
  createdAt: number;
  updatedAt: number;
  note: string;
  sourceUrl?: string;
  replacementContentUrl?: string;
  replacementReferenceUrl?: string;
  skipSourceTransfer?: boolean;
  skipReferencePreflight?: boolean;
  allowFreeDesignWithoutReference?: boolean;
  autoApply?: boolean;
  inputFiles?: MaterialFile[];
  files: SupplementalFileRef[];
  summary?: SupplementPreviewSummary;
  error?: string;
  appliedAt?: number;
  /** Answer / upload receipt summary saved after syncing into target Kooboo site. */
  appliedResult?: {
    uploadedCount: number;
    answeredPending?: boolean;
    continuedConversation?: boolean;
  };
}

export interface TaskSupplementPendingUpload {
  callId: string;
  kind: string;
  question: string;
  description?: string;
  target?: 'mediaLibrary' | 'cmsFile' | 'iframe';
  accept?: string[];
  folder?: string;
  maxFiles?: number;
  purpose?: string;
}

export interface TaskSupplementContext {
  batches: TaskSupplementBatch[];
  pendingUpload?: TaskSupplementPendingUpload;
  effectiveContentUrl: string;
  effectiveReferenceUrl: string;
  canSupplement: boolean;
  hasTargetSite: boolean;
  interruptionCategory?: import('./human-diagnostics.js').DiagnosticCategory;
  referencePreflightFailed?: boolean;
  referencePreflightDetail?: string;
  skipReferencePreflight?: boolean;
  allowFreeDesignWithoutReference?: boolean;
}
