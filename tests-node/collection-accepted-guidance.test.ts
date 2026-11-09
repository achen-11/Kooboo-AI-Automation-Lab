import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutomationTask } from '../shared/automation.js';
import type { AcceptedCollectionAssetGap } from '../shared/collection.js';
import { acceptedAssetGapGuidance } from '../server/automation/collection/accepted-gaps.js';
import { reviewWithValidation } from '../server/automation/evaluator.js';

test('evaluation result repair retains host guidance for exact accepted material gaps', async () => {
  const acceptance:AcceptedCollectionAssetGap={id:'acceptance',taskId:'task',collectionId:'collection',inputVersionId:'input',actor:'human',acceptedAt:1,reason:'按当前素材继续',stateHash:'a'.repeat(64),evidencePath:'site/accepted-source-gaps.json',entries:[{collection:'files',kind:'asset',url:'https://source.invalid/manual.pdf',status:'failed',note:'http-403'}]};
  const guidance='\n'+acceptedAssetGapGuidance([acceptance]),prompts:string[]=[],repairs:number[]=[];
  await assert.rejects(reviewWithValidation({
    prompt:'独立评测'+guidance,guidance,task:{id:'task'} as AutomationTask,files:()=>[],threshold:80,referenceRequired:false,
    run:async prompt=>{prompts.push(prompt);return '{}';},onRepair:(_message,attempt)=>repairs.push(attempt),
  }));
  assert.equal(prompts.length,3);assert.deepEqual(repairs,[1,2]);
  for(const prompt of prompts){assert.ok(prompt.endsWith(guidance));assert.match(prompt,/确切1项/);assert.match(prompt,/新增缺口|新缺陷/);}
});
