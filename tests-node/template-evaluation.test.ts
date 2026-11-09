import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { ManifestStore } from '../server/automation/completeness.js';
import { executeEvaluation, codexClient } from '../server/automation/evaluator.js';
import { evaluationBrowser } from '../server/automation/browser.js';
import { defaultAutomationSettings, type MaterialFile } from '../shared/automation.js';
import { defaultLearningSettings } from '../shared/experience.js';

test('template execution performs host captures, independent short reviews, local preflight and complete aggregation without a real model or browser',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'template-execution-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(resolve(directory,'vault'));
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,model:[]}));});
  let opens=0,closes=0,threads=0,captures=0,preflights=0;
  try{
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`,environmentId=randomUUID();
    vault.update({...vault.get(),model:{endpoint:origin+'/v1',name:'test-model',apiKey:'fake-test-key'},environments:[{id:environmentId,name:'Test',origin,apiOrigin:origin,token:'fake-test-token'}]});
    const settings=structuredClone(defaultAutomationSettings);settings.learning={...defaultLearningSettings,use:false,collect:false};vault.updateAutomation({...settings,evaluationEndpoint:origin+'/v1',evaluationModel:'test-model'});
    const resource=store.saveResource({name:'Template',scenario:'site-template',description:'all pages',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalSource:'',externalId:''});
    const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,requirements:''},settings)[0];task.kind='evaluation';task.siteRevision='current';task.generatedSiteId=randomUUID();task.status='running';task.stopped=false;task.learningPolicy={...defaultLearningSettings,use:false,collect:false};task.rule={...task.rule!,criteria:[{id:'visual',label:'Visual',weight:100,instruction:'Review actual layout',required:true,viewports:['desktop','mobile'],scopes:['site']}]};
    store.saveSite({id:task.generatedSiteId,resourceId:resource.id,versionId:task.versionId,environmentId,siteId:randomUUID(),name:'Target',url:'https://target.test/',createdAt:Date.now()});store.put(task);
    new ManifestStore(store).save(task,{sourceComplete:true,limitations:[],evidence:[],items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'Fixed',expectation:'both paths and viewports',paths:['/','/about'],expectedCount:2,viewports:['desktop','mobile']}]},'human');
    let activeFiles:MaterialFile[]=[];
    const openBrowser=(async(_urls,work,_signal,initial,checkpoint,binding)=>{opens++;activeFiles=structuredClone(initial||[]);return {artifacts:activeFiles,env:{},capture:async(raw:unknown)=>{captures++;const slot=raw as {role:'target'|'reference';viewport:'desktop'|'mobile';url:string},file=randomUUID()+'.png',bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');const observation={...slot,file,binding:{...binding,capturePolicy:'settled-pc1440-mobile390-v1'},settlement:{settled:true}};
      for(const [name,data,type] of [[file,bytes,'image/png'],[file.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(work,'evidence',name),data);activeFiles.push({id:randomUUID(),name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),type,role:slot.role,viewport:slot.viewport,settled:true});}checkpoint?.(activeFiles);return observation;},close:async()=>{closes++;}};}) as typeof evaluationBrowser;
    const createClient=((_vault:Vault,_directory:string,env:Record<string,string>)=>({startThread:()=>{threads++;return {runStreamed:async(prompt:string)=>{const work=resolve(directory,'automation-runs',task.id),context=JSON.parse(readFileSync(resolve(work,'task.json'),'utf8'));const match=/evaluation-result-[a-f0-9-]{36}\.json/.exec(prompt);assert.ok(match);const resultFile=match[0];const raw={summary:context.batchId,assessments:context.task.rule.criteria.flatMap((c:any)=>c.viewports.map((viewport:string)=>({criterionId:c.id,viewport,score:90,passed:true,reason:'Actual pixels in mock review',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.viewport===viewport).map(f=>f.name)}))),issues:[],coverage:{verified:['reviewed'],unverified:[],outOfScope:[]},...(context.manifest?{completeness:context.manifest.items.map((item:any)=>({id:item.id,status:'verified',reason:'All required path/viewports inspected',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.role==='target').map(f=>f.name),checkedViewports:['desktop','mobile'],actualCount:2,sampledPaths:item.paths,checkedKeys:[]}))}:{})};writeFileSync(resolve(work,resultFile),JSON.stringify(raw));
      const response=await fetch(env.INSPECTION_URL,{method:'POST',headers:{Authorization:'Bearer '+env.INSPECTION_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({tool:'validate_result',resultFile})});assert.equal(response.status,200,await response.text());preflights++;
      return {events:(async function*(){yield {type:'thread.started',thread_id:randomUUID()};yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({resultFile})}};yield {type:'turn.completed',usage:{input_tokens:100,output_tokens:50}};})()};}};},resumeThread:()=>{throw new Error('template batches must use independent short threads');}})) as unknown as typeof codexClient;
    await executeEvaluation(task,store,vault,directory,new AbortController().signal,{openBrowser,createClient});assert.equal(opens,1);assert.equal(closes,1);assert.equal(captures,8);assert.equal(threads,3);assert.equal(preflights,3);assert.equal(task.report?.quality,'passed');assert.equal(task.report?.assessments.length,2);assert.equal(task.report?.completeness?.state,'complete');assert.equal(store.evaluations.get(task.id)?.state,'stopped');
    await executeEvaluation(task,store,vault,directory,new AbortController().signal,{openBrowser,createClient});assert.equal(captures,8,'same revision reuses registered captures');assert.equal(threads,3,'validated batch checkpoints prevent repeated model calls');
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();rmSync(directory,{recursive:true,force:true});}
});
