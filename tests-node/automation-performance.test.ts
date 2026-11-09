import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { AutomationStore } from '../server/automation/store.js';
import { AutomationWorker } from '../server/automation/worker.js';
import { ExperienceStore } from '../server/automation/experience-store.js';
import { queueReflection } from '../server/automation/experience.js';
import { defaultAutomationSettings } from '../shared/automation.js';

async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'automation-performance-'));
  const services=await createApp({directory,serveWeb:false,startWorker:false});
  const store=services.automationStore;
  const resource=store.saveResource({name:'Performance fixture',scenario:'materials',description:'',contentUrl:'',referenceUrl:'',externalSource:'',externalId:'',files:[]});
  const site={id:randomUUID(),resourceId:resource.id,versionId:store.versions(resource.id)[0].id,environmentId:randomUUID(),siteId:randomUUID(),name:'Target',url:'https://target.test',createdAt:1};
  store.saveSite(site);
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'homepage',generatedSiteId:site.id,environmentId:site.environmentId,requirements:''},defaultAutomationSettings)[0];
  task.status='completed';task.stopped=true;store.put(task);
  const review=store.ensureEvaluation(task,defaultAutomationSettings);
  review.status='completed';review.stopped=true;
  review.context='PRIVATE_HISTORY'.repeat(100_000);
  review.report={summary:'Independent report',quality:'passed',scores:[{viewport:'desktop',value:95},{viewport:'mobile',value:95}],assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},artifacts:[]};
  store.publishSiteReport(review);store.put(review);
  const login=await services.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
  return {...services,store,site,task,review,headers,directory,async close(){await services.app.close();rmSync(directory,{recursive:true,force:true});}};
}

test('idle dispatch never reads full task history or usage, including already reflected reports',async()=>{
  const f=await fixture();try{
    f.review.learningPolicy={...f.review.learningPolicy!,collect:true};f.store.put(f.review);
    const run=queueReflection(f.review,f.store)!;run.status='failed';new ExperienceStore(f.store).put(run);
    f.vault.updateAutomation({...defaultAutomationSettings,enabled:true});
    const prepare=f.store.db.prepare.bind(f.store.db);
    f.store.db.prepare=sql=>{
      assert.ok(!/\bFROM\s+(?:auto_tasks|auto_usage)\b/i.test(sql),'idle dispatch must not deserialize history or calculate billing');
      return prepare(sql);
    };
    const worker=new AutomationWorker(f.store,f.vault,f.directory);
    await worker.tick();await worker.tick();
    assert.equal(f.store.reflectionCandidates().length,0,'failed reflections are retained rather than resubmitted every second');
  }finally{await f.close();}
});

test('compact routes preserve costs and report identity without reading full tasks or per-row billing',async()=>{
  const f=await fixture();try{
    const at=Date.parse('2026-11-08T10:00:00+08:00');
    f.store.usage.record(f.task.id,{id:'known',source:'kooboo',stage:'generation',model:'deepseek-flash-1017',endpoint:'https://api.deepseek.com/v1',startedAt:at,endedAt:at,status:'completed',basis:'request',raw:{input_tokens:1_000_000,output_tokens:0,input_tokens_details:{cached_tokens:0}}});
    f.store.usage.record(f.review.id,{id:'unknown',source:'codex',stage:'evaluation',model:'fixture',endpoint:'https://model.test',startedAt:at,endedAt:at,status:'unknown',basis:'request',raw:null});
    const expected=f.store.task(f.task.id)!.usage;
    const full=f.store.task(f.review.id,false)!;
    const prepare=f.store.db.prepare.bind(f.store.db);
    f.store.db.prepare=sql=>{assert.ok(!/\bFROM\s+auto_tasks\b/i.test(sql),'compact routes must use the lightweight index');return prepare(sql);};
    f.store.usage.summary=()=>{throw new Error('per-row billing');};
    for(const url of ['/api/automation/overview?view=compact','/api/automation/overview?view=status',`/api/automation/tasks/${f.task.id}/summary`,'/api/automation/site-deliveries',`/api/automation/site-deliveries/${f.site.id}/reports`,'/api/automation/notifications?view=compact&page=1']){
      const response=await f.app.inject({url,headers:f.headers});assert.equal(response.statusCode,200,url);assert.ok(!response.body.includes('PRIVATE_HISTORY'));
      if(url.includes('/tasks/'))assert.deepEqual(response.json().task.usage,expected);
      if(url==='/api/automation/site-deliveries'){
        const row=response.json().items[0];assert.equal(row.report.id,f.review.id);assert.equal(row.usage.requests,2);assert.equal(row.usage.knownCny,1);assert.equal(row.usage.missing,1);
      }
      if(url.endsWith('view=status'))assert.deepEqual(Object.keys(response.json()).sort(),['queue','settings']);
    }
    const status=await f.app.inject({url:'/api/automation/overview?view=compact&statusOnly=1',headers:f.headers});
    assert.equal(status.statusCode,200);assert.deepEqual(Object.keys(status.json()).sort(),['queue','settings']);
    f.store.db.prepare=prepare;
    assert.deepEqual(f.store.task(f.review.id,false),full,'list requests do not replace or trim stored evidence');
  }finally{await f.close();}
});

test('legacy index backfill preserves ordering and full history; failed index writes roll back task updates',async()=>{
  const f=await fixture();try{
    const before=f.store.tasks(),original=f.store.task(f.review.id,false)!;
    f.store.db.exec('DROP TABLE auto_task_index');
    const restored=new AutomationStore(f.store.db);
    assert.deepEqual(restored.headers().map(t=>t.id),before.map(t=>t.id));
    assert.deepEqual(restored.task(f.review.id,false),original);
    assert.ok(JSON.stringify(restored.headers()).length<10_000,'backfill omits large historical context');
    const legacy={...original,status:'interrupted' as const,updatedAt:original.updatedAt+1};
    restored.db.prepare('UPDATE auto_tasks SET status=?,json=? WHERE id=?').run(legacy.status,JSON.stringify(legacy),legacy.id);
    const upgraded=new AutomationStore(restored.db);
    assert.equal(upgraded.header(legacy.id)!.status,'interrupted','upgrading again repairs writes made by an older server');
    restored.put(original);
    restored.db.exec("CREATE TRIGGER reject_index BEFORE UPDATE ON auto_task_index BEGIN SELECT RAISE(ABORT,'index write rejected'); END");
    assert.throws(()=>restored.put({...original,status:'interrupted'}),/index write rejected/);
    assert.equal(restored.task(original.id,false)!.status,'completed');assert.equal(restored.header(original.id)!.status,'completed');
    restored.db.exec('DROP TRIGGER reject_index');
    const stale={...f.task,status:'running' as const,stopped:false};
    restored.put({...stale,status:'cancelling'});restored.put(stale);
    assert.equal(restored.header(stale.id)!.status,'cancelling','stale heartbeats cannot erase cancellation');
  }finally{await f.close();}
});
