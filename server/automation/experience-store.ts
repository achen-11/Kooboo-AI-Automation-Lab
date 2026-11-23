import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AutomationStore } from './store.js';
import type { AutomationTask, Scenario } from '../../shared/automation.js';
import { scenarios } from '../../shared/automation.js';
import { defaultLearningSettings, type Experience, type ExperienceInput, type ExperienceStage, type ExperienceRevision, type LearningRun } from '../../shared/experience.js';
import { Conflict } from '../lib/store.js';

export const FOLLOWUP_RUNTIME_EPOCH = 1;
export const FOLLOWUP_EPOCH_MIGRATION_ID = `followup-runtime-epoch-v${FOLLOWUP_RUNTIME_EPOCH}`;
export const KOOBOO_SUBDOMAIN_CONFLICT_MIGRATION_ID = 'kooboo-subdomain-hyphen-conflict-v1';

export function hasKoobooSubdomainHyphenConflict(input: Pick<ExperienceInput, 'title' | 'conditions' | 'guidance'>): boolean {
  const text = [input.title, input.conditions, input.guidance].join('\n');
  if (!/subDomain|子域名|siteName/i.test(text)) return false;
  return (
    /(?:禁止|不能|不得|不要|不可|避免|非法|不合规|违规|不允许)[^。\n，；,;]{0,16}下划线|下划线[^。\n，；,;]{0,16}(?:非法|不合规|违规|被拒|禁止|不允许|不符合\s*DNS|非\s*DNS)/i.test(text)
    || /(?:只含|仅含|仅允许|只能使用|仅使用)[^。\n下划线]{0,24}(?:连字符|短横线|中划线|\bhyphen)/i.test(text)
    || /(?:改[为成用]|替换[为成]|换[为成])[^。\n，；,;下划线]{0,12}(?:连字符|短横线|中划线|\bhyphen)/i.test(text)
    || /下划线[^。\n，；,;]{0,16}(?:改[为成]|替换[为成]|换[为成])[^。\n，；,;]{0,12}(?:连字符|短横线|-)/i.test(text)
  );
}

export const learningSettingsSchema=z.object({use:z.boolean(),collect:z.boolean(),concurrency:z.number().int().min(1).max(3),maxTokens:z.number().int().min(1000).max(1000000000),maxMinutes:z.number().min(1).max(30),maxRequests:z.number().int().min(1).max(200),selectionSop:z.string().trim().min(1).max(50000),reflectionSop:z.string().trim().min(1).max(50000)});
export const experienceInput=z.object({title:z.string().trim().min(1).max(200),scenarios:z.array(z.enum(Object.keys(scenarios) as [keyof typeof scenarios,...(keyof typeof scenarios)[]])).min(1).max(5),stages:z.array(z.enum(['generation','followup','evaluation'])).min(1).max(3),conditions:z.string().trim().min(1).max(4000),exclusions:z.string().max(4000),guidance:z.string().trim().min(1).max(12000)}).strict();
export class ExperienceStore {
  constructor(readonly store:AutomationStore){
    store.db.exec(`CREATE TABLE IF NOT EXISTS auto_experiences(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_experience_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS auto_learning_runs(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_experience_migrations(id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auto_learning_queue ON auto_learning_runs(status,created_at);`);
    this.runStartupMigrations();
  }
  private latestActor(id:string):ExperienceRevision['actor']|undefined{
    const row=this.store.db.prepare('SELECT json FROM auto_experience_revisions WHERE id=? ORDER BY revision DESC LIMIT 1').get(id) as {json:string}|undefined;
    return row?(JSON.parse(row.json) as ExperienceRevision).actor:undefined;
  }
  runStartupMigrations(){
    const appliedCount=Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM auto_experience_migrations WHERE id IN (?,?)').get(FOLLOWUP_EPOCH_MIGRATION_ID,KOOBOO_SUBDOMAIN_CONFLICT_MIGRATION_ID) as {n:number}).n);
    if(appliedCount>=2)return;
    const hasMigration=(id:string)=>Boolean(this.store.db.prepare('SELECT 1 FROM auto_experience_migrations WHERE id=?').get(id));
    const listEnabled=()=>this.store.db.prepare("SELECT json FROM auto_experiences WHERE json_extract(json,'$.enabled')=1").all().map(r=>JSON.parse(String(r.json)) as Experience);
    this.store.db.transaction(()=>{
      if(!hasMigration(FOLLOWUP_EPOCH_MIGRATION_ID)){
        for(const exp of listEnabled()){
          if(this.latestActor(exp.id)==='human')continue;
          if((exp.runtimeEpoch??0)<FOLLOWUP_RUNTIME_EPOCH&&exp.stages.includes('followup')){
            if(exp.stages.every(s=>s==='followup')){
              this.save({title:exp.title,scenarios:exp.scenarios,stages:exp.stages,conditions:exp.conditions,exclusions:exp.exclusions,guidance:exp.guidance},{
                id:exp.id,revision:exp.revision,actor:'system',enabled:false,verdict:exp.evidence,runtimeEpoch:exp.runtimeEpoch??0,
                reason:'[系统升级自检] 平台跟进与恢复调度机制已升级（runtimeEpoch v1），旧调度机制下沉淀的 AI 跟进经验已自动退役停用；历史版本保留，如确认仍适用可手动恢复。',
              });
            }else{
              this.save({title:exp.title,scenarios:exp.scenarios,stages:exp.stages.filter(s=>s!=='followup'),conditions:exp.conditions,exclusions:exp.exclusions,guidance:exp.guidance},{
                id:exp.id,revision:exp.revision,actor:'system',enabled:true,verdict:exp.evidence,runtimeEpoch:exp.runtimeEpoch??0,
                reason:'[系统升级自检] 平台跟进与恢复调度机制已升级（runtimeEpoch v1），已自动移除该经验的 followup 阶段标签并保留其余阶段经验。',
              });
            }
          }
        }
        this.store.db.prepare('INSERT INTO auto_experience_migrations VALUES(?,?)').run(FOLLOWUP_EPOCH_MIGRATION_ID,Date.now());
      }
      if(!hasMigration(KOOBOO_SUBDOMAIN_CONFLICT_MIGRATION_ID)){
        for(const exp of listEnabled()){
          if(this.latestActor(exp.id)==='human')continue;
          if(hasKoobooSubdomainHyphenConflict(exp)){
            this.save({title:exp.title,scenarios:exp.scenarios,stages:exp.stages,conditions:exp.conditions,exclusions:exp.exclusions,guidance:exp.guidance},{
              id:exp.id,revision:exp.revision,actor:'system',enabled:false,verdict:exp.evidence,runtimeEpoch:exp.runtimeEpoch,
              reason:'[系统升级自检] 该经验关于 subDomain/子域名 禁用下划线或要求连字符的建议与 Kooboo 域名校验规则（仅允许英文字母、数字和下划线 _，禁止连字符 -）直接冲突，已自动停用；历史版本保留。',
            });
          }
        }
        this.store.db.prepare('INSERT INTO auto_experience_migrations VALUES(?,?)').run(KOOBOO_SUBDOMAIN_CONFLICT_MIGRATION_ID,Date.now());
      }
    });
  }
  get(id:string):Experience|undefined {const row=this.store.db.prepare('SELECT json FROM auto_experiences WHERE id=?').get(id);return row?JSON.parse(row.json):undefined;}
  page(page=1,size=20,search='',enabled?:boolean,scenario?:Scenario,stage?:ExperienceStage){
    const where=`WHERE (?='' OR json_extract(json,'$.title') LIKE ?)
      AND (? IS NULL OR json_extract(json,'$.enabled')=?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(auto_experiences.json,'$.scenarios') WHERE value=?))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(auto_experiences.json,'$.stages') WHERE value=?))`;
    const state=enabled===undefined?null:Number(enabled),args=[search,'%'+search+'%',state,state,scenario??null,scenario??null,stage??null,stage??null];
    const total=Number(this.store.db.prepare('SELECT COUNT(*) n FROM auto_experiences '+where).get(...args).n),pages=Math.max(1,Math.ceil(total/size));page=Math.min(page,pages);
    return {page,pages,total,items:this.store.db.prepare('SELECT json FROM auto_experiences '+where+" ORDER BY json_extract(json,'$.updatedAt') DESC, id ASC LIMIT ? OFFSET ?").all(...args,size,(page-1)*size).map(r=>JSON.parse(r.json) as Experience)};
  }
  history(id:string,page=1,size=10){const total=Number(this.store.db.prepare('SELECT COUNT(*) n FROM auto_experience_revisions WHERE id=?').get(id).n),pages=Math.max(1,Math.ceil(total/size));page=Math.min(page,pages);return {page,pages,total,items:this.store.db.prepare('SELECT json FROM auto_experience_revisions WHERE id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(id,size,(page-1)*size).map(r=>JSON.parse(r.json) as ExperienceRevision)};}
  save(input:ExperienceInput,options:{id?:string;revision?:number;actor:'human'|'ai'|'system';reason:string;enabled?:boolean;taskId?:string;evidence?:string[];verdict?:Experience['evidence'];runtimeEpoch?:number}):Experience {
    return this.store.db.transaction(()=>{
      const clean=experienceInput.parse(this.store.sanitize(input)),old=options.id?this.get(options.id):undefined;
      if(options.id&&(!old||old.revision!==options.revision))throw new Conflict('经验已更新，请刷新后重试');
      if(options.actor==='ai'&&old?.manualDisabled)throw new Conflict('人工停用的经验只能由人工修改或恢复');
      const now=Date.now(),enabled=options.enabled??old?.enabled??true;
      const changed=old&&(old.guidance!==clean.guidance||old.conditions!==clean.conditions||old.exclusions!==clean.exclusions||JSON.stringify(old.scenarios)!==JSON.stringify(clean.scenarios)||JSON.stringify(old.stages)!==JSON.stringify(clean.stages));
      const runtimeEpoch=options.runtimeEpoch!==undefined?options.runtimeEpoch:clean.stages.includes('followup')?FOLLOWUP_RUNTIME_EPOCH:old?.runtimeEpoch;
      const item:Experience={...clean,id:old?.id||randomUUID(),revision:(old?.revision||0)+1,enabled,manualDisabled:options.actor==='human'?!enabled:old?.manualDisabled||false,evidence:options.verdict||(changed?'unverified':old?.evidence)||'unverified',createdAt:old?.createdAt||now,updatedAt:now,sourceTaskId:options.taskId||old?.sourceTaskId||null,sourceEvidence:[...new Set([...(old?.sourceEvidence||[]),...(options.evidence||[])])].slice(-100),...(runtimeEpoch!==undefined?{runtimeEpoch}:{})};
      if(!old){const duplicates=this.store.db.prepare("SELECT json FROM auto_experiences WHERE json_extract(json,'$.title')=? OR json_extract(json,'$.guidance')=?").all(item.title,item.guidance);if(duplicates.length)throw new Conflict('相同标题或内容的经验已存在，请更新已有经验');}
      this.store.db.prepare('INSERT INTO auto_experiences VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(item.id,item.revision,JSON.stringify(item));
      this.store.db.prepare('INSERT INTO auto_experience_revisions VALUES(?,?,?)').run(item.id,item.revision,JSON.stringify({experience:item,actor:options.actor,reason:options.reason,time:now}));return item;
    });
  }
  workflow(task:AutomationTask){let current=task;const seen=new Set<string>();while(current.parentId&&!seen.has(current.id)){seen.add(current.id);const parent=this.store.task(current.parentId);if(!parent)break;current=parent;}return current;}
  candidates(task:AutomationTask,phase:ExperienceStage,query='',page=1,size=60){return this.store.db.prepare("SELECT json FROM auto_experiences WHERE json_extract(json,'$.enabled')=1 AND EXISTS(SELECT 1 FROM json_each(auto_experiences.json,'$.scenarios') WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(auto_experiences.json,'$.stages') WHERE value=?) AND (?='' OR json_extract(json,'$.title') LIKE ? OR json_extract(json,'$.conditions') LIKE ? OR json_extract(json,'$.guidance') LIKE ?) ORDER BY json_extract(json,'$.updatedAt') DESC LIMIT ? OFFSET ?").all(task.scenario,phase,query,'%'+query+'%','%'+query+'%','%'+query+'%',size,(page-1)*size).map(r=>JSON.parse(r.json) as Experience);}
  run(id:string):LearningRun|undefined {const row=this.store.db.prepare('SELECT json FROM auto_learning_runs WHERE id=? OR key=?').get(id,id);return row?JSON.parse(row.json):undefined;}
  put(run:LearningRun){run.updatedAt=Date.now();this.store.db.prepare('INSERT INTO auto_learning_runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json').run(run.id,run.key,run.status,run.createdAt,JSON.stringify(this.store.sanitize(run)));return run;}
  runs(taskId:string,page=1,size=10){const total=Number(this.store.db.prepare("SELECT COUNT(*) n FROM auto_learning_runs WHERE json_extract(json,'$.taskId')=?").get(taskId).n),pages=Math.max(1,Math.ceil(total/size));page=Math.min(page,pages);return {page,pages,total,items:this.store.db.prepare("SELECT json FROM auto_learning_runs WHERE json_extract(json,'$.taskId')=? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(taskId,size,(page-1)*size).map(r=>JSON.parse(r.json) as LearningRun)};}
  enqueue(task:AutomationTask,phase:ExperienceStage,kind:LearningRun['kind'],key:string){const old=this.run(key);if(old)return old;const root=this.workflow(task),policy=structuredClone(root.learningPolicy||task.learningPolicy||defaultLearningSettings);return this.put({id:randomUUID(),key,taskId:task.id,workflowId:root.id,phase,kind,status:'queued',policy,createdAt:Date.now(),updatedAt:Date.now(),threadId:'',reason:'',adoptions:[],produced:[],budgetId:'experience:'+root.id});}
  claim(ready:(run:LearningRun)=>boolean=()=>true){return this.store.db.transaction(()=>{const run=this.store.db.prepare("SELECT json FROM auto_learning_runs WHERE status='queued' AND json_extract(json,'$.kind')='reflection' ORDER BY created_at LIMIT 100").all().map(r=>JSON.parse(r.json) as LearningRun).find(ready);if(!run)return;run.status='running';return this.put(run);});}
  recover(){for(const row of this.store.db.prepare("SELECT json FROM auto_learning_runs WHERE status='running'").all()){const run=JSON.parse(row.json) as LearningRun;run.status='failed';run.reason='服务中断，本次经验决策未确认完成；保留已写入的版本和用量，不自动重发。';this.put(run);}}
}
