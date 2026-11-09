import test from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionTargetCheck, CollectionTargetReport } from '../shared/collection-target.js';
import { collectionVerificationFailureClass, summarizeCollectionTargetReport } from '../server/automation/collection/verification-summary.js';

function report(checks:CollectionTargetCheck[]):CollectionTargetReport {return {version:1,id:'report',binding:'frozen-hash',state:'unverified',taskId:'task',inputVersionId:'input',collectionId:'collection',collectionVersionId:'snapshot',snapshotHash:'sha',manifestId:'manifest',manifestRevision:1,generatedSiteId:'site',siteId:'physical',siteRevision:'revision',checkedAt:1,checkedPages:10,expectedPages:20,checks,artifacts:[],issues:[],limitations:['Only the frozen original scope was checked.']};}

test('summary counts every class while keeping exact key differences and evidence samples bounded',()=>{
  const checks:CollectionTargetCheck[]=Array.from({length:100},(_,index)=>({id:'page:'+index,kind:'page',status:'missing',reason:'Confirmed missing data',expectedKeys:['same','missing-'+index],actualKeys:['same','extra-'+index],evidence:['observation-'+index,'full-difference-'+index]}));
  checks.push({id:'source',kind:'data',status:'unverified',failureClass:'source-limitation',reason:'Frozen CSS bytes missing',evidence:['collection/.work/state.json']},{id:'contract',kind:'binding',status:'unverified',reason:'Wrong binding',evidence:[]},{id:'read',kind:'data',status:'unverified',reason:'Read pending',evidence:[]},{id:'ok',kind:'data',status:'verified',reason:'All matched',evidence:[]});
  const summary=summarizeCollectionTargetReport(report(checks),{sampleLimit:5,keyLimit:1,evidenceLimit:1});
  assert.deepEqual(summary.failures,{'confirmed-target-defect':100,'source-limitation':1,'contract-tool-defect':1,'transient-incomplete':1});
  assert.equal(summary.totalChecks,104);assert.equal(summary.verifiedChecks,1);assert.equal(summary.samples.length,5);assert.equal(summary.omittedChecks,98);
  assert.equal(new Set(summary.samples.map(sample=>sample.failureClass)).size,4);
  assert.deepEqual(summary.samples[0].missingKeys,['missing-0']);assert.deepEqual(summary.samples[0].unexpectedKeys,['extra-0']);assert.deepEqual(summary.samples[0].evidence,['observation-0']);
});

test('unverified observations and binding failures cannot claim confirmed target defect',()=>{
  const common={id:'read',kind:'data' as const,status:'unverified' as const,reason:'Read failed',evidence:[]};
  assert.equal(collectionVerificationFailureClass({...common,failureClass:'confirmed-target-defect'}),'transient-incomplete');
  assert.equal(collectionVerificationFailureClass({...common,kind:'binding',status:'missing',failureClass:'confirmed-target-defect'}),'contract-tool-defect');
  const summary=summarizeCollectionTargetReport(report([common]),{sampleLimit:0});assert.equal(summary.samples.length,0);assert.equal(summary.omittedChecks,1);assert.equal(summary.failures['transient-incomplete'],1);
});

test('absence of an actual identity observation cannot be reported as confirmed missing keys',()=>{
  const summary=summarizeCollectionTargetReport(report([{id:'relations',kind:'relations',status:'unverified',expectedKeys:['expected-child'],reason:'Actual observation not obtained',evidence:['source-original.json']}]))!;
  assert.equal(summary.samples[0].expectedCount,1);assert.equal(summary.samples[0].actualCount,undefined);assert.deepEqual(summary.samples[0].missingKeys,[]);assert.deepEqual(summary.samples[0].unexpectedKeys,[]);
});
