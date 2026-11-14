import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { TemplateWorkflowStore } from '../server/automation/template-workflow-store.js';
import { prepareReferenceMedia } from '../server/automation/generation-reference-media.js';
import { templateCandidateLinks, templateSourceCoverage } from '../server/automation/template-source-coverage.js';
import type { Requirement } from '../shared/completeness.js';
import { Vault } from '../server/lib/vault.js';
import { executeGeneration } from '../server/automation/generator.js';
import { GenerationContextStore } from '../server/automation/generation-context.js';
import type { generationSession } from '../server/automation/generation-session.js';
import type { AutomationTask, MaterialFile } from '../shared/automation.js';
import { sourceVisualMaterial } from '../server/automation/collection/source-visual.js';

function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'reference-media-')),db=new Database(':memory:'),store=new AutomationStore(db),registry=new TemplateWorkflowStore(store);
  const resource=store.saveResource({name:'Template',scenario:'site-template',description:'',contentUrl:'',referenceUrl:'https://source.test/',files:[],externalId:'',externalSource:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];registry.initialize(task);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0l8AAAAASUVORK5CYII=','base64');
  const folder=resolve(directory,'automation-runs',task.id,'evidence');mkdirSync(folder,{recursive:true});
  const files=Array.from({length:15},(_,n)=>{
    const name=randomUUID()+'.png';writeFileSync(resolve(folder,name),png);
    return {name,ownerTaskId:task.id,role:'reference' as const,url:'https://source.test/',viewport:n%2?'mobile' as const:'desktop' as const,type:'image/png',sha256:createHash('sha256').update(png).digest('hex'),size:png.length,siteRevision:null,href:''};
  });
  const record=registry.get(task)!;
  record.baseline={id:randomUUID(),revision:1,createdAt:1,inputVersionId:task.versionId,referenceUrl:'https://source.test/',contentUrl:null,scope:'site',pages:[{path:'/',title:'Home',views:[{id:'hero',title:'Hero',role:'hero',required:true,layouts:(['desktop','mobile'] as const).map(viewport=>({viewport,selector:'#hero',evidence:files.filter(file=>file.viewport===viewport).map(file=>file.name),intent:'Reference',exceptions:'',constraints:[]}))}]}],contentMapping:'',limitations:[],complete:true,evidence:files,checklistId:record.checklistId};registry.put(record);
  const sandboxes:{id:string;siteName:string}[]=[],calls:{name:string;siteId:string}[]=[];
  let loseCreation=false,normalizedReceipt=false;
  const request=async(_path:string,body:any,siteId?:string)=>{
    calls.push({name:body.name,siteId:siteId!});
    if(body.name==='list_sandbox')return {contents:[{result:[...sandboxes]}]};
    assert.equal(body.name,'create_sandbox');assert.deepEqual(body.arguments.contentTypes,[]);
    const site={id:randomUUID(),siteName:body.arguments.siteName};sandboxes.push(site);
    if(loseCreation){loseCreation=false;throw new Error('lost sandbox receipt');}
    return {contents:[{result:site}]};
  };
  const target={siteId:randomUUID(),apiOrigin:'https://kooboo.test',token:'fixture-token',request};
  const remote=new Map<string,{id:string;bytes:Buffer}>();let uploads=0,corrupt=false,wrongReceipt=false,loseReceipt=false;
  const fetcher=(async(input:any,init:any)=>{
    const url=new URL(String(input));assert.equal(url.origin,target.apiOrigin);assert.ok(sandboxes.some(site=>site.id===url.searchParams.get('SiteId')));assert.notEqual(url.searchParams.get('SiteId'),target.siteId);assert.equal(init.headers.Authorization,'Bearer fixture-token');
    if(init.method==='POST'){
      assert.equal(url.pathname,'/_api/v2/Upload/Image');assert.equal(url.searchParams.get('provider'),'default');
      const form=init.body as FormData,file=form.get('file') as File,path=String(form.get('Folder'))+'/'+file.name;
      const key=url.searchParams.get('SiteId')+path,bytes=Buffer.from(await file.arrayBuffer()),id=remote.get(key)?.id||randomUUID();remote.set(key,{id,bytes});uploads++;
      if(loseReceipt){loseReceipt=false;throw new Error('lost upload receipt');}
      return Response.json([{id:wrongReceipt?'00000000-0000-0000-0000-000000000000':id,url:normalizedReceipt?'/media-root'+path:path,size:normalizedReceipt?0:bytes.length}]);
    }
    assert.equal(url.pathname,'/_api/Download/Single');assert.equal(url.searchParams.get('type'),'media');
    const item=[...remote.values()].find(value=>value.id===url.searchParams.get('id'));
    return item?new Response(new Uint8Array(corrupt?Buffer.from('changed'):item.bytes)):new Response(null,{status:404});
  }) as typeof fetch;
  const run=()=>prepareReferenceMedia(task,store,directory,target,new AbortController().signal,fetcher);
  return {store,task,registry,directory,target,remote,files,resource,run,fetcher,sandboxes,calls,count:()=>uploads,setCorrupt:()=>{corrupt=true;},setWrongReceipt:()=>{wrongReceipt=true;},normalizeReceipt:()=>{normalizedReceipt=true;},loseCreation:()=>{loseCreation=true;},loseReceipt:()=>{loseReceipt=true;},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('all frozen reference PNGs have media IDs and page/view/viewport provenance; restart verifies bytes and reuses uploads',async()=>{
  const f=fixture();try{
    const first=await f.run();assert.equal(first!.entries.length,15,'does not silently stop at twelve images');assert.equal(f.count(),1,'identical bytes share one immutable media image');
    assert.notEqual(first!.siteId,f.target.siteId);assert.equal(first!.targetSiteId,f.target.siteId);
    for(const entry of first!.entries){assert.ok(entry.imageId);assert.equal(entry.sandbox,f.sandboxes[0].siteName);assert.equal(entry.sha256,f.files[0].sha256);assert.deepEqual(entry.views,[{pagePath:'/',viewId:'hero',viewport:entry.viewport}]);assert.equal(entry.ownerTaskId,f.task.id);}
    assert.deepEqual(await f.run(),first);assert.equal(f.count(),1);
    assert.equal(f.calls.filter(call=>call.name==='create_sandbox').length,1);
    f.remote.clear();await f.run();assert.equal(f.count(),2,'deleted media is restored to the same content-addressed path');
    f.setCorrupt();await assert.rejects(f.run,/字节冲突/);assert.equal(f.count(),2);
  }finally{f.close();}
});

test('uncertain upload receipts reconcile to the same media path; invalid receipts and changed local evidence cannot be delivered',async()=>{
  const f=fixture();try{
    f.loseReceipt();await assert.rejects(f.run,/lost upload/);assert.equal(f.remote.size,1);
    await f.run();assert.equal(f.remote.size,1,'no duplicate media URL after lost response');
    writeFileSync(resolve(f.directory,'automation-runs',f.task.id,'evidence',f.files[0].name),'tampered');
    await assert.rejects(f.run,/已变化/);
  }finally{f.close();}
  const wrong=fixture();try{wrong.setWrongReceipt();await assert.rejects(wrong.run,/回执/);}finally{wrong.close();}
  const corrupt=fixture();try{corrupt.setCorrupt();await assert.rejects(corrupt.run,/字节校验/);}finally{corrupt.close();}
});

test('sandbox creation reconciles a lost response and each target owns a distinct organization-wide name',async()=>{
  const f=fixture();try{
    f.loseCreation();f.normalizeReceipt();const first=await f.run();
    assert.equal(f.sandboxes.length,1);assert.ok(first!.entries.every(entry=>entry.path.startsWith('/media-root/')),'server paths and size metadata need not match the request');
    assert.deepEqual(await f.run(),first);assert.equal(f.calls.filter(call=>call.name==='create_sandbox').length,1);
    const second=await prepareReferenceMedia(f.task,f.store,f.directory,{...f.target,siteId:randomUUID()},new AbortController().signal,f.fetcher);
    assert.notEqual(second!.sandbox,first!.sandbox);assert.notEqual(second!.siteId,first!.siteId);assert.equal(f.sandboxes.length,2);
  }finally{f.close();}
});

test('template sampling retains every required URL while unknown static pages block complete source claims',()=>{
  const item=(kind:Requirement['kind'],paths:string[],samples?:string[]):Requirement=>({id:'pages',title:'Pages',kind,required:true,source:'source',expectation:'Match',paths,samples,expectedCount:null,viewports:['desktop','mobile']});
  const input={scope:'site' as const,reference:'https://source.test/',pages:new Set(['https://source.test/']),links:['/','/about','/products/1','/products/2','/image.png','https://external.test/']};
  assert.ok(templateSourceCoverage({...input,items:[item('page',['/'])]}).some(gap=>gap.includes('/about')));
  const covered={...input,pages:new Set([...input.pages,'https://source.test/about','https://source.test/products/1'])};
  assert.deepEqual(templateSourceCoverage({...covered,items:[item('page',['/','/about']),item('template',['/products/1','/products/2'],['/products/1'])]}),[]);
  assert.ok(templateSourceCoverage({...input,items:[item('page',['/','/about'])]}).some(gap=>gap.includes('双端基线')));
  assert.throws(()=>templateSourceCoverage({...input,items:[item('page',['https://external.test/'])]}),/越出参考站/);
  const tools=['/style-guide','/licenses','/changelog','/instructions','/404','/password'];
  const toolInput={...input,links:['/',...tools],items:[item('page',['/'])]};
  assert.equal(templateSourceCoverage(toolInput).length,tools.length,'tool pages require explicit classification');
  assert.deepEqual(templateSourceCoverage({...toolInput,excludedPaths:tools.map(path=>({path,reason:'Template author utility page'}))}),[]);
  assert.throws(()=>templateSourceCoverage({...toolInput,excludedPaths:[{path:'/style-guide',reason:' '}]}),/原因/);
  assert.throws(()=>templateSourceCoverage({...toolInput,excludedPaths:[{path:'https://elsewhere.test/',reason:'External'}]}),/越出/);
  const candidates=Array.from({length:55},(_,i)=>'/page-'+i);
  assert.deepEqual(templateCandidateLinks(input.reference,[...candidates,candidates[0]+'#section','/image.png','https://elsewhere.test/','mailto:hello@source.test']),candidates.map(path=>new URL(path,input.reference).href));
});

test('repair transfers registered target evidence with its original revision and open issue mapping through media references',async()=>{
  const f=fixture();try{
    const reportId=randomUUID(),name=randomUUID()+'.png',source=f.files[0];
    const folder=resolve(f.directory,'automation-runs',f.task.id,'evidence');writeFileSync(resolve(folder,name),readFileSync(resolve(folder,source.name)));
    const baselineId=f.registry.get(f.task)!.baseline!.id;
    const evidence={...source,name,role:'target',siteRevision:'reviewed-revision'};
    const evaluation={taskId:reportId,baselineId,evidence:[evidence],issues:[{status:'open',evidence:[name]}],checks:[{pagePath:'/',viewId:'hero',viewport:'desktop',evidence:[name]}]};
    f.store.db.prepare('INSERT INTO auto_template_evaluations VALUES(?,?,?)').run(reportId,f.task.id,JSON.stringify(evaluation));
    f.task.repairEvidence={reportId,files:[]};
    const result=await f.run(),target=result!.entries.find(entry=>entry.name===name)!;
    assert.equal(target.role,'target');assert.equal(target.siteRevision,'reviewed-revision');assert.deepEqual(target.views,[{pagePath:'/',viewId:'hero',viewport:'desktop'}]);
    assert.equal(result!.entries.filter(entry=>entry.role==='reference').length,15);
    f.task.repairEvidence.files=['unregistered.png'];await assert.rejects(f.run,/未登记/);
    f.task.repairEvidence={reportId:randomUUID(),files:[]};await assert.rejects(f.run,/匹配的冻结基线/);
  }finally{f.close();}
});

test('legacy repair PNGs and first-round migration baselines use sandbox media without a templateWorkflow',async()=>{
  const f=fixture();try{
    delete f.task.templateWorkflow;f.task.scenario='migration';f.task.siteRevision='original-report-revision';f.task.siteUrl='https://target.test/';
    const original=f.files[0],targetFile={...original,id:randomUUID(),role:'target' as const};
    f.task.report={summary:'Original review',assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'unverified',artifacts:[targetFile]};f.store.put(f.task);f.task.repairEvidence={reportId:f.task.id,files:[original.name]};
    const repair=await f.run();assert.equal(repair!.entries.length,1);assert.equal(repair!.entries[0].role,'target');assert.equal(repair!.entries[0].siteRevision,'original-report-revision');assert.equal(repair!.entries[0].sandbox,repair!.sandbox);
    const materials:MaterialFile[]=[],folder=resolve(f.directory,'materials');mkdirSync(folder,{recursive:true});
    const material=(name:string,bytes:Buffer,type:string):MaterialFile=>{
      const file={id:randomUUID(),name,type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};writeFileSync(resolve(folder,file.id),bytes);materials.push(file);return file;
    };
    const png=readFileSync(resolve(f.directory,'automation-runs',f.task.id,'evidence',original.name));
    const desktop='site/visual/screens/desktop.png',mobile='site/visual/screens/mobile.png';
    material('collection/'+desktop,png,'image/png');material('collection/'+mobile,png,'image/png');
    material(sourceVisualMaterial,Buffer.from(JSON.stringify({templates:[{screens:[{path:desktop,viewport:'desktop',url:'https://source.test/'},{path:mobile,viewport:'mobile',url:'https://source.test/'}]}]})),'application/json');
    delete f.task.repairEvidence;
    const baseline=await prepareReferenceMedia(f.task,f.store,f.directory,{...f.target,input:{files:materials},includeBaseline:true},new AbortController().signal,f.fetcher);
    assert.deepEqual(baseline!.entries.map(entry=>entry.viewport),['desktop','mobile']);assert.ok(baseline!.entries.every(entry=>entry.sandbox===baseline!.sandbox));
    assert.equal(await prepareReferenceMedia(f.task,f.store,f.directory,{...f.target,input:{files:materials},includeBaseline:false},new AbortController().signal,f.fetcher),undefined);
    assert.equal(await f.run(),undefined,'legacy task with no image evidence does not create an empty package');
    const before=f.count();materials[0].sha256='0'.repeat(64);
    await assert.rejects(()=>prepareReferenceMedia(f.task,f.store,f.directory,{...f.target,input:{files:materials},includeBaseline:true},new AbortController().signal,f.fetcher),/校验失败/);assert.equal(f.count(),before);
  }finally{f.close();}
});

for(const mode of ['workflow','legacy-repair','migration-baseline'] as const)test('the real generator sends '+mode+' through sandbox media without bridge imageInput',async()=>{
  const f=fixture(),kfiles=new Map<string,string>(),media=new Map<string,Buffer>(),sandbox={id:randomUUID(),siteName:'automation-ref-'+f.target.siteId.replace(/-/g,'')};let created=false;
  if(mode!=='workflow'){
    delete f.task.templateWorkflow;delete f.task.autonomy;f.task.requirementsEnabled=false;
    if(mode==='legacy-repair'){
      const image={...f.files[0],id:randomUUID(),role:'target' as const};
      f.task.report={summary:'Original report',assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'unverified',artifacts:[image]};
      f.task.repairEvidence={reportId:f.task.id,files:[image.name]};
      f.task.generation={repairBatch:{planKey:'old-attachment-batches',completed:0,total:2}};
    }else{
      const folder=resolve(f.directory,'materials');mkdirSync(folder,{recursive:true});const files:MaterialFile[]=[];
      const material=(name:string,bytes:Buffer,type:string)=>{const file={id:randomUUID(),name,type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};writeFileSync(resolve(folder,file.id),bytes);files.push(file);};
      const png=readFileSync(resolve(f.directory,'automation-runs',f.task.id,'evidence',f.files[0].name));
      for(const viewport of ['desktop','mobile'])material('collection/site/visual/screens/'+viewport+'.png',png,'image/png');
      material(sourceVisualMaterial,Buffer.from(JSON.stringify({templates:[{screens:['desktop','mobile'].map(viewport=>({path:'site/visual/screens/'+viewport+'.png',viewport,url:'https://source.test/'}))}]})),'application/json');
      f.store.saveResource({...f.resource,scenario:'migration',contentUrl:'https://source.test/',referenceUrl:'',files},f.resource.id,f.resource.revision);
      f.task.versionId=f.store.versions(f.resource.id)[0].id;f.task.scenario='migration';
    }
  }
  const server=createServer(async(request,response)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks),url=new URL(request.url!,'http://localhost');
      if(url.pathname==='/_api/v2/Upload/Image'){
        assert.equal(url.searchParams.get('SiteId'),sandbox.id);
        const form=await new Request(url,{method:'POST',headers:{'content-type':request.headers['content-type']!},body}).formData();
        const file=form.get('file') as File,id=randomUUID();media.set(id,Buffer.from(await file.arrayBuffer()));
        response.setHeader('Content-Type','application/json');response.end(JSON.stringify([{id,url:String(form.get('Folder'))+'/'+file.name,size:file.size}]));return;
      }
      if(url.pathname==='/_api/Download/Single'){assert.equal(url.searchParams.get('SiteId'),sandbox.id);const bytes=media.get(url.searchParams.get('id')!);response.statusCode=bytes?200:404;response.end(bytes);return;}
      assert.equal(url.pathname,'/_api/v2/AI/CallFunction');const input=JSON.parse(body.toString());
      if(input.name==='list_sandbox'||input.name==='create_sandbox'){
        assert.equal(url.searchParams.get('SiteId'),f.target.siteId);
        const result=input.name==='list_sandbox'?(created?[sandbox]:[]):sandbox;
        if(input.name==='create_sandbox'){assert.equal(input.arguments.siteName,sandbox.siteName);created=true;}
        response.setHeader('Content-Type','application/json');response.end(JSON.stringify({contents:[{result}]}));return;
      }
      assert.equal(input.name,'run_kscript');
      const result=runInNewContext('(function(){'+input.arguments.code+'})()',{k:{file:{read:(path:string)=>kfiles.get(path)??null,write:(path:string,text:string)=>kfiles.set(path,text)}}});
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({contents:[{result}]}));
    }catch(error){response.statusCode=500;response.end(String(error));}
  });
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
    const vault=new Vault(f.directory);vault.update({...vault.get(),environments:[{id:f.task.environmentId,name:'Fixture',origin,apiOrigin:origin,token:'fixture-token'}]});
    const site={id:randomUUID(),siteId:f.target.siteId,resourceId:f.task.resourceId,versionId:f.task.versionId,environmentId:f.task.environmentId,name:'Generated',url:'',createdAt:Date.now()};
    f.store.saveSite(site);f.task.generatedSiteId=site.id;f.task.learningPolicy={...f.task.learningPolicy!,use:false,collect:false};
    const conversationId=randomUUID();f.task.generation={...f.task.generation,prepared:true,conversationId};f.store.put(f.task);let sends=0;
    const session:typeof generationSession=async()=>({
      snapshot:async()=>({version:1,taskId:f.task.id,siteId:site.siteId,conversationId,runId:'old-run',ready:true,running:false,state:'unknown',observedAt:Date.now(),pending:null,context:[],canSend:true,imageInput:false}),
      deliver:async payload=>{
        sends++;assert.equal(payload.images,undefined);assert.match(payload.text!,/read_image/);assert.equal(f.task.generation?.repairBatch,undefined);
        const pkg=new GenerationContextStore(f.store).packages(f.task.id)[0],original=JSON.parse(pkg.original);assert.equal(original.referenceImages.entries.length,mode==='workflow'?15:mode==='legacy-repair'?1:2);assert.equal(media.size,1);assert.equal(original.referenceImages.siteId,sandbox.id);assert.ok(original.referenceImages.entries.every((entry:any)=>entry.sandbox===sandbox.siteName));
        const base=pkg.index.slice(0,pkg.index.lastIndexOf('/')+1),reader=kfiles.get(base+'reader.js')!;
        const received=runInNewContext(reader+';JSON.stringify(automationRead("referenceImages"))',{k:{file:{read:(path:string)=>kfiles.get(path)??null}}});
        assert.deepEqual(JSON.parse(received),original.referenceImages);throw new Error('fixture delivery inspected');
      },close:async()=>{}
    });
    await assert.rejects(executeGeneration(f.task,f.store,vault,f.directory,AbortSignal.timeout(10000),session),/fixture delivery inspected/);assert.equal(sends,1);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));f.close();}
});
