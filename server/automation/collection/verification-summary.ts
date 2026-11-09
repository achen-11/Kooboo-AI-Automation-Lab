import type { CollectionTargetCheck, CollectionTargetReport, CollectionTargetSummary, CollectionVerificationFailureClass } from '../../../shared/collection-target.js';

/** Keep old reports readable; an unverified observation never authorizes target repair. */
export function collectionVerificationFailureClass(check:CollectionTargetCheck):CollectionVerificationFailureClass {
  if(check.status==='missing'&&check.kind!=='binding')return 'confirmed-target-defect';
  if(check.failureClass&&check.failureClass!=='confirmed-target-defect')return check.failureClass;
  return check.kind==='binding'?'contract-tool-defect':'transient-incomplete';
}

/** Counts cover the whole report. Samples carry exact keys and local evidence references. */
export function summarizeCollectionTargetReport(report:CollectionTargetReport,options:{sampleLimit?:number;keyLimit?:number;evidenceLimit?:number}={}):CollectionTargetSummary {
  const bound=(value:number|undefined,fallback:number,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?Math.min(value,max):fallback;
  const sampleLimit=bound(options.sampleLimit,12,100),keyLimit=bound(options.keyLimit,8,100),evidenceLimit=bound(options.evidenceLimit,4,30);
  const failures:CollectionTargetSummary['failures']={'confirmed-target-defect':0,'source-limitation':0,'contract-tool-defect':0,'transient-incomplete':0};
  const failed=report.checks.filter(check=>check.status!=='verified');
  for(const check of failed)failures[collectionVerificationFailureClass(check)]++;
  // Include each present failure class before filling the remaining sample budget.
  const selected:CollectionTargetCheck[]=[];
  for(const kind of Object.keys(failures) as CollectionVerificationFailureClass[]){const first=failed.find(check=>collectionVerificationFailureClass(check)===kind);if(first&&selected.length<sampleLimit)selected.push(first);}
  for(const check of failed)if(selected.length<sampleLimit&&!selected.includes(check))selected.push(check);
  return {version:1,reportId:report.id,binding:report.binding,state:report.state,checkedPages:report.checkedPages,expectedPages:report.expectedPages,totalChecks:report.checks.length,verifiedChecks:report.checks.length-failed.length,failures,
    samples:selected.map(check=>{const expected=new Set(check.expectedKeys||[]),actual=new Set(check.actualKeys||[]),comparable=Array.isArray(check.expectedKeys)&&Array.isArray(check.actualKeys);return {id:check.id,kind:check.kind,status:check.status,failureClass:collectionVerificationFailureClass(check),...(check.sourcePath?{sourcePath:check.sourcePath}:{}),...(check.requirementId?{requirementId:check.requirementId}:{}),reason:check.reason.slice(0,1200),missingKeys:comparable?[...expected].filter(key=>!actual.has(key)).slice(0,keyLimit):[],unexpectedKeys:comparable?[...actual].filter(key=>!expected.has(key)).slice(0,keyLimit):[],...(check.expectedKeys?{expectedCount:check.expectedKeys.length}:{}),...(check.actualKeys?{actualCount:check.actualKeys.length}:{}),evidence:check.evidence.slice(0,evidenceLimit),...(check.differences?{differences:{missingTextFragments:check.differences.missingTextFragments.slice(0,keyLimit).map(text=>text.slice(0,600)),missingLinkUrls:check.differences.missingLinkUrls.slice(0,keyLimit),textTruncated:check.differences.textTruncated||check.differences.missingTextFragments.some(text=>text.length>600)}}:{})};}),
    omittedChecks:failed.length-selected.length,limitations:report.limitations.slice(0,8).map(value=>value.slice(0,1200))};
}
