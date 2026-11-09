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
/** One template-level difference shared by many pages, counted from complete per-page differences. */
export interface CollectionTargetDefectGroup {
  template:string; kind:'text'|'link'|'navigation'|'title'|'http'; key:string;
  pages:number; templatePages:number; samplePaths:string[]; examples:string[]; evidence:string[];
  /** Set when the group merges fragments that each occur on a single page. */
  uniqueFragments?:number;
}
export interface CollectionTemplateCoverage { template:string; pages:number; verified:number; missing:number; unverified:number }
export interface CollectionTargetSummary {
  version:1; reportId:string; binding:string; state:CollectionTargetReport['state'];
  checkedPages:number; expectedPages:number; totalChecks:number; verifiedChecks:number;
  failures:Record<CollectionVerificationFailureClass,number>;
  defectGroups?:CollectionTargetDefectGroup[]; templateCoverage?:CollectionTemplateCoverage[];
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
  defectGroups?:CollectionTargetDefectGroup[]; templateCoverage?:CollectionTemplateCoverage[];
}
export interface CollectionRelationBinding {
  /** Selects an existing frozen list; it cannot supply or replace expected members. */
  sourcePath:string; table:string; parentField:string; childField:string; orderField?:string;
  /** Explicit source identity fields; omitted fields preserve the legacy primary-key contract. */
  parentIdentityField?:string; childIdentityField?:string; sourcePathField?:string;
}
