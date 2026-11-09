import type { MaterialFile } from './automation.js';

export type CollectionStage = 'plan'|'discover'|'fetch'|'extract'|'assets'|'data'|'render'|'verify';
export interface CollectionCheck { id:'A1'|'A2'|'A3'|'A4'|'A5'|'A6'|'A7'; status:'verified'|'failed'|'unverified'; reason:string; evidence:string[] }
export interface CollectionOptions { maxPages:number; maxDepth:number; maxAssets:number; maxTotalBytes:number; delay:number; retryFailed:boolean; seedUrls?:string[] }
export interface CollectionOperation { id:string; operation:string; status:'running'|'completed'|'failed'; startedAt:number; finishedAt?:number; pid?:number; error?:string; receipt?:unknown }
export interface CollectionObjective { description:string; affectedObjects:string[]; evidence:string[]; acceptance:string; operation: string; options?:Partial<CollectionOptions>; payload?:Record<string,unknown> }
export interface AcceptedCollectionAssetGapEntry {
  collection:'assets'|'files'|'stylesheets'; kind:'asset'|'stylesheet'; url:string; status:'failed'; note:string;
}
/** A human decision bound to the exact observed failures, never a future-gap waiver. */
export interface AcceptedCollectionAssetGap {
  id:string; taskId:string; collectionId:string; inputVersionId:string; actor:'human'; acceptedAt:number;
  reason:string; stateHash:string; evidencePath:'site/accepted-source-gaps.json'; entries:AcceptedCollectionAssetGapEntry[];
}
/** Independent host browser observation; it never replaces static source/extraction. */
export interface SourceRenderedEvidence {
  id:string; collectionId:string; inputVersionId:string; engineVersion:string; pageId:string; url:string;
  rawPath:string; rawSha256:string; extractPath:string; extractSha256:string;
  observationPath:string; observationSha256:string; screenshotPath:string; screenshotSha256:string;
  capturedAt:number; viewport:'desktop'; text:string; visibleText:string;
  frames:{url:string;text:string}[]; framesComplete:boolean; textTruncated:boolean;
}
export interface CollectionReviewReceipt { path:string;sha256:string;offset:number;chars:number;kind?:'file'|'engine'|'requirements'|'image' }
/** One logical review can span soft activity windows without resetting evidence or its model account. */
export interface CollectionReviewContinuation {
  workId:string; binding:string; threadId?:string; resumable:boolean; readReceipts:CollectionReviewReceipt[];
}
export interface CollectionRun {
  id:string; taskId:string; inputVersionId:string; sourceUrl:string; scope:'site';
  status:'collecting'|'reviewing'|'repairing'|'ready'|'blocked'; engineVersion:string; baseEngineVersion?:string;
  createdAt:number; updatedAt:number; completed:CollectionStage[]; options:CollectionOptions;
  operations:CollectionOperation[]; next?:CollectionObjective; checks:CollectionCheck[];
  reviewAttempt:number; review?:unknown; summary?:unknown; materialVersionId?:string;
  lastOutcome?:{operation:string;evidencePath:string;status?:string};
  adoptions?: {kind:'rule'|'repair';trialId:string;state:'adopted'|'withdrawn';receiptPath:string;adoption?:unknown}[];
  files?:MaterialFile[]; manifestId?:string; snapshotHash?:string; error?:string; nextAt?:number;
  /** Only this explicit recollection task may advance the mutable run past a pinned snapshot. */
  revisionTaskId?:string;
  acceptedAssetGaps?:AcceptedCollectionAssetGap[];
  sourceRenderedEvidence?:SourceRenderedEvidence[];
  reviewContinuation?:CollectionReviewContinuation;
}
export interface CollectionSnapshot { id:string; collectionId:string; taskId:string; inputVersionId:string; engineVersion:string; createdAt:number; files:MaterialFile[]; originals:{path:string;sha256:string;size:number}[]; checks:CollectionCheck[]; review:unknown; manifestId:string; sha256:string; acceptedAssetGaps?:AcceptedCollectionAssetGap[]; sourceRenderedEvidence?:SourceRenderedEvidence[] }
