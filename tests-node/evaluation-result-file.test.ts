import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AutomationTask, MaterialFile } from '../shared/automation.js';
import type { RequirementManifest } from '../shared/completeness.js';
import { dataIdentityEvaluationContract, readEvaluationResult, reviewWithValidation, type EvaluationResultDelivery } from '../server/automation/evaluator.js';

function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'evaluation-result-file-'));
  const task:AutomationTask={id:randomUUID(),kind:'evaluation',resourceId:'resource',versionId:'version',resourceName:'Sample',scenario:'migration',scope:'site',environmentId:'environment',generatedSiteId:'site',parentId:null,message:'review',status:'running',stopped:false,createdAt:1,updatedAt:1,error:'',context:'',threadId:'thread',report:null,siteUrl:'https://target.invalid/',model:null,rule:{id:'rule',name:'Rule',kind:'site',sop:'Review',references:'',createdAt:1,hash:'rule-hash',criteria:[{id:'business',label:'Records',weight:100,instruction:'Check records',required:true,viewports:['business'],scopes:['site']}]}};
  const evidence:MaterialFile={id:randomUUID(),name:'implementation-'+randomUUID()+'.json',type:'application/json',size:1,sha256:'a'.repeat(64),role:'target'};
  const valid={summary:'Current evidence supports this review',assessments:[{criterionId:'business',viewport:'business',score:90,reason:'Checked actual records',evidence:[evidence.name],passed:true}],issues:[],coverage:{verified:['records'],unverified:[],outOfScope:[]}};
  const input={prompt:'Review the current site',resultDirectory:directory,task,files:()=>[evidence],threshold:80,referenceRequired:false,onRepair:()=>{}};
  return {directory,task,evidence,valid,input,close(){rmSync(directory,{recursive:true,force:true});}};
}
const fixed='evaluation-result-'+randomUUID()+'.json';

test('full result is submitted through a nonce file while provider schema and final output contain only the pointer',async()=>{
  const f=fixture();try{
    let finalLength=0;
    const report=await reviewWithValidation({...f.input,run:async(prompt,delivery)=>{
      assert.ok(delivery);assert.match(prompt,new RegExp(delivery.resultFile.replaceAll('.','\\.')));assert.match(prompt,/不得在最终回复添加前导中文/);
      const pointerSchema=delivery.outputSchema as any;assert.deepEqual(Object.keys(pointerSchema.properties),['resultFile']);assert.equal(pointerSchema.properties.resultFile.const,delivery.resultFile);assert.equal(pointerSchema.additionalProperties,false);
      const fileSchema=JSON.parse(readFileSync(resolve(f.directory,delivery.schemaFile),'utf8'));assert.ok(fileSchema.properties.assessments);assert.ok(fileSchema.properties.issues);assert.ok(!fileSchema.properties.resultFile);
      writeFileSync(resolve(f.directory,delivery.resultFile),JSON.stringify(f.valid));const final=JSON.stringify({resultFile:delivery.resultFile});finalLength=final.length;return final;
    }});
    assert.equal(report.quality,'passed');assert.deepEqual(report.assessments,f.valid.assessments);assert.ok(finalLength<120);
  }finally{f.close();}
});

test('large completeness key arrays remain intact in the file and still undergo complete host validation',async()=>{
  const f=fixture();try{
    const keys=Array.from({length:4000},(_,index)=>'https://source.invalid/record/'+index+'?locale=zh-CN');
    const manifest:RequirementManifest={id:'manifest',taskId:f.task.id,revision:1,createdAt:1,sourceComplete:true,limitations:[],actor:'human',evidence:[],items:[{id:'all-records',title:'Records',kind:'data',required:true,source:'frozen',expectation:'Every record',paths:[],expectedCount:keys.length,expectedKeys:keys,viewports:['business']}]};
    const valid={...f.valid,completeness:[{id:'all-records',status:'verified',reason:'Every frozen key checked',evidence:[f.evidence.name],checkedViewports:['business'],actualCount:keys.length,sampledPaths:[],checkedKeys:keys}]};
    const report=await reviewWithValidation({...f.input,manifest,run:async(_prompt,delivery)=>{assert.ok(delivery);const schema=JSON.parse(readFileSync(resolve(f.directory,delivery.schemaFile),'utf8'));assert.ok(schema.required.includes('completeness'));writeFileSync(resolve(f.directory,delivery.resultFile),JSON.stringify(valid));return JSON.stringify({resultFile:delivery.resultFile});}});
    assert.equal(report.quality,'passed');assert.deepEqual(report.completeness!.checks[0].checkedKeys,keys);
    let calls=0;await assert.rejects(reviewWithValidation({...f.input,manifest,run:async(_prompt,delivery)=>{calls++;writeFileSync(resolve(f.directory,delivery!.resultFile),JSON.stringify({...valid,completeness:[{...valid.completeness[0],checkedKeys:keys.slice(1)}]}));return JSON.stringify({resultFile:delivery!.resultFile});}}),/全部记录标识/);assert.equal(calls,3);
  }finally{f.close();}
});

test('repair attempts issue a fresh nonce and stale submissions cannot be reused by a resumed thread',async()=>{
  const f=fixture();try{
    const deliveries:EvaluationResultDelivery[]=[],repairs:string[]=[];
    const report=await reviewWithValidation({...f.input,onRepair:message=>repairs.push(message),run:async(prompt,delivery)=>{
      assert.ok(delivery);deliveries.push(delivery);
      if(deliveries.length===1){writeFileSync(resolve(f.directory,delivery.resultFile),JSON.stringify({...f.valid,assessments:[]}));return JSON.stringify({resultFile:delivery.resultFile});}
      assert.match(prompt,/上一份评测结果未通过/);
      if(deliveries.length===2){writeFileSync(resolve(f.directory,deliveries[0].resultFile),JSON.stringify(f.valid));return JSON.stringify({resultFile:deliveries[0].resultFile});}
      writeFileSync(resolve(f.directory,delivery.resultFile),JSON.stringify(f.valid));return JSON.stringify({resultFile:delivery.resultFile});
    }});
    assert.equal(report.quality,'passed');assert.equal(deliveries.length,3);assert.equal(new Set(deliveries.map(row=>row.resultFile)).size,3);assert.equal(repairs.length,2);assert.match(repairs[1],/旧提交/);
  }finally{f.close();}
});

test('legacy inline strict JSON remains compatible even when a result directory is available',async()=>{
  const f=fixture();try{const report=await reviewWithValidation({...f.input,run:async()=>JSON.stringify(f.valid)});assert.equal(report.quality,'passed');}finally{f.close();}
});

test('data identity clarification survives file result repairs and preserves frozen baseline coverage',async()=>{
  const f=fixture();try{
    const guidance=dataIdentityEvaluationContract(),prompts:string[]=[];
    for(const text of ['dataIdentity.kind=page','relations','assets','JSON.stringify([parentSourceURL,childSourceURL])','parentRequirementIds / childRequirementIds','source-review-*','tool=extend_manifest','URL 数量与去重文件数','不得删除、缩减','静态页面改 kind','unverified'])assert.ok(guidance.includes(text));
    const report=await reviewWithValidation({...f.input,prompt:f.input.prompt+guidance,guidance,run:async(prompt,delivery)=>{prompts.push(prompt);writeFileSync(resolve(f.directory,delivery!.resultFile),JSON.stringify(prompts.length===1?{...f.valid,assessments:[]}:f.valid));return JSON.stringify({resultFile:delivery!.resultFile});}});
    assert.equal(report.quality,'passed');assert.equal(prompts.length,2);assert.ok(prompts.every(prompt=>prompt.includes(guidance)));
  }finally{f.close();}
});

for(const mode of ['prose-prefix','code-fence','wrong-file','traversal','absolute-path','extra-pointer-fields','missing-file','symlink','hardlink','directory','oversize','invalid-file-json','invalid-utf8','file-prose','missing-evidence'] as const){
  test(`result file submission rejects ${mode} without falling back to an existing old result`,async()=>{
    const f=fixture();try{
      const old='evaluation-result-'+randomUUID()+'.json';writeFileSync(resolve(f.directory,old),JSON.stringify(f.valid));let calls=0;
      await assert.rejects(reviewWithValidation({...f.input,run:async(_prompt,delivery)=>{
        calls++;assert.ok(delivery);const path=resolve(f.directory,delivery.resultFile);let result:unknown={resultFile:delivery.resultFile};
        if(mode==='wrong-file')result={resultFile:old};
        if(mode==='traversal')result={resultFile:'../'+delivery.resultFile};
        if(mode==='absolute-path')result={resultFile:path};
        if(mode==='extra-pointer-fields')result={resultFile:delivery.resultFile,summary:'Extra'};
        if(mode==='symlink')symlinkSync(resolve(f.directory,old),path);
        else if(mode==='hardlink')linkSync(resolve(f.directory,old),path);
        else if(mode==='directory')mkdirSync(path);
        else if(mode==='oversize')writeFileSync(path,Buffer.alloc(4*1024*1024+1,32));
        else if(mode==='invalid-file-json')writeFileSync(path,'{"summary":');
        else if(mode==='invalid-utf8'){const bytes=Buffer.from(JSON.stringify(f.valid));bytes[bytes.indexOf('Current')]=255;writeFileSync(path,bytes);}
        else if(mode==='file-prose')writeFileSync(path,'评测如下：'+JSON.stringify(f.valid));
        else if(mode==='missing-evidence')writeFileSync(path,JSON.stringify({...f.valid,assessments:[{...f.valid.assessments[0],evidence:['invented.json']}]}));
        else if(mode!=='missing-file')writeFileSync(path,JSON.stringify(f.valid));
        const final=JSON.stringify(result);return mode==='prose-prefix'?'已完成评测。\n'+final:mode==='code-fence'?'```json\n'+final+'\n```':final;
      }}));
      assert.equal(calls,3);assert.equal(f.task.report,null);
    }finally{f.close();}
  });
}

test('reader enforces the host fixed filename contract and the exact 4MiB maximum',()=>{
  const f=fixture();try{
    const path=resolve(f.directory,fixed),raw=JSON.stringify(f.valid);writeFileSync(path,raw+' '.repeat(4*1024*1024-Buffer.byteLength(raw)));assert.deepEqual(readEvaluationResult(JSON.stringify({resultFile:fixed}),f.directory,fixed),f.valid);
    assert.throws(()=>readEvaluationResult(JSON.stringify({resultFile:'../outside.json'}),f.directory,'../outside.json'),/本轮宿主固定名称/);
    writeFileSync(path,raw+' '.repeat(4*1024*1024-Buffer.byteLength(raw)+1));assert.throws(()=>readEvaluationResult(JSON.stringify({resultFile:fixed}),f.directory,fixed),/4MiB/);
  }finally{f.close();}
});
