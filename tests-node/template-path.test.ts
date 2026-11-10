import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { templateTargetPath } from '../server/automation/template-path.js';
import { templateCapturePlan } from '../server/automation/template-capture.js';
import { validateCompleteness } from '../server/automation/completeness.js';
import type { AutomationTask, MaterialFile } from '../shared/automation.js';
import type { RequirementManifest } from '../shared/completeness.js';

const target='https://generated.test/',source='https://source.test/';
const manifest:RequirementManifest={id:'manifest',taskId:'task',revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'frozen source',expectation:'Complete site',paths:[source,source+'about?lang=zh'],viewports:['desktop','mobile'],expectedCount:2}]};

test('template source page URLs map only the trusted origin and preserve exact paths and query identity',()=>{
  assert.equal(templateTargetPath(source+'about?lang=zh#section',target,source),'/about?lang=zh');
  assert.equal(templateTargetPath('https://other.test/about?lang=zh',target,source),'https://other.test/about?lang=zh');
  assert.equal(templateTargetPath('https://name:password@source.test/about',target,source),'https://name:password@source.test/about');
  const task={id:randomUUID(),versionId:'input',siteRevision:'revision'} as AutomationTask;
  const before=structuredClone(manifest),plan=templateCapturePlan(task,manifest,target,source);
  assert.equal(plan.gaps.length,0);assert.equal(plan.slots.length,8);
  assert.deepEqual(plan.slots.filter(s=>s.role==='target').map(s=>s.url).sort(),[target,target,target+'about?lang=zh',target+'about?lang=zh'].sort());assert.deepEqual(manifest,before);
});

test('full source URLs and mapped target paths are validated against real target screenshots on both viewports',()=>{
  const files:MaterialFile[]=[],observations:Record<string,{url:string;role:string;viewport:string}>={};
  for(const path of ['/','/about?lang=zh'])for(const viewport of ['desktop','mobile'] as const){const name=randomUUID()+'.png';files.push({id:randomUUID(),name,type:'image/png',size:1,sha256:'a',role:'target',viewport});observations[name]={url:new URL(path,target).href,role:'target',viewport};}
  const raw=[{id:'pages',status:'verified',reason:'Inspected both pages and viewports',evidence:files.map(f=>f.name),checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:manifest.items[0].paths,checkedKeys:[]}];
  assert.equal(validateCompleteness(raw,manifest,files,observations,target,{},source).state,'complete');
  raw[0].sampledPaths=['/','/about?lang=zh'];assert.equal(validateCompleteness(raw,manifest,files,observations,target,{},source).state,'complete');
  const missing=Object.fromEntries(Object.entries(observations).filter(([,o])=>!(o.url.includes('about')&&o.viewport==='mobile')));
  assert.throws(()=>validateCompleteness(raw,manifest,files,missing,target,{},source),/about\?lang=zh.*mobile/);
  raw[0].sampledPaths=['/','/about?lang=en'];assert.throws(()=>validateCompleteness(raw,manifest,files,observations,target,{},source),/pages.*about\?lang=zh/);
  raw[0].sampledPaths=manifest.items[0].paths;assert.throws(()=>validateCompleteness(raw,manifest,files,observations,target),/对应.*真实截图/,'other scenarios without explicit template mapping retain strict origin checks');
});
