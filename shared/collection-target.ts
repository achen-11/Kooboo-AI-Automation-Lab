import type { MaterialFile } from './automation.js';

export type CollectionVerificationFailureClass = 'confirmed-target-defect'|'source-limitation'|'contract-tool-defect'|'transient-incomplete';

/** Host-owned evidence contract; model-written evaluation output cannot establish this gate. */
export interface CollectionTargetCheck {
  id:string; kind:'binding'|'page'|'listing'|'data'|'relations'; status:'verified'|'missing'|'unverified';
  reason:string; sourcePath?:string; requirementId?:string; expectedKeys?:string[]; actualKeys?:string[]; evidence:string[];
  /** Only missing observations can be confirmed target defects. */
  failureClass?:CollectionVerificationFailureClass;
  differences?:{missingTextFragments:string[];missingLinkUrls:string[];textTruncated:boolean};
}
export interface CollectionTargetSummary {
  version:1; reportId:string; binding:string; state:CollectionTargetReport['state'];
  checkedPages:number; expectedPages:number; totalChecks:number; verifiedChecks:number;
  failures:Record<CollectionVerificationFailureClass,number>;
  samples:{id:string;kind:CollectionTargetCheck['kind'];status:CollectionTargetCheck['status'];failureClass:CollectionVerificationFailureClass;sourcePath?:string;requirementId?:string;reason:string;missingKeys:string[];unexpectedKeys:string[];expectedCount?:number;actualCount?:number;evidence:string[];differences?:CollectionTargetCheck['differences']}[];
  omittedChecks:number; limitations:string[];
}
export interface CollectionTargetReport {
  /** Legacy reports remain readable; only the current verifier may establish new proof. */
  verifierVersion?:number;
  version:1; id:string; taskId:string; inputVersionId:string; collectionId:string; collectionVersionId:string; snapshotHash:string;
  manifestId:string; manifestRevision:number; generatedSiteId:string; siteId:string; siteRevision:string; binding:string;
  /** Older reports without this hash remain readable but cannot establish a current gate. */
  manifestHash?:string;
  state:'complete'|'incomplete'|'unverified'|'pending'; checkedAt:number; nextAt?:number;
  checkedPages:number; expectedPages:number; checks:CollectionTargetCheck[]; artifacts:MaterialFile[];
  issues:{severity:'major';title:string;detail:string;evidence:string[]}[]; limitations:string[];
  summary?:CollectionTargetSummary;
}
export interface CollectionRelationBinding {
  /** Selects an existing frozen list; it cannot supply or replace expected members. */
  sourcePath:string; table:string; parentField:string; childField:string; orderField?:string;
  /** Explicit source identity fields; omitted fields preserve the legacy primary-key contract. */
  parentIdentityField?:string; childIdentityField?:string; sourcePathField?:string;
}
