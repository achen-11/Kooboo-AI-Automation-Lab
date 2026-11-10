import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Conflict } from '../lib/store.js';
import { GenerationContextStore, cleanupGenerationContext } from './generation-context.js';
import { koobooClient } from './kooboo.js';
import { randomUUID } from 'node:crypto';
import { retainStoppedFollowupReservations } from './budget-recovery.js';

export function registerGenerationContextApi(app: FastifyInstance, store: AutomationStore, vault: Vault, owns: (id: string) => boolean) {
  const params = z.object({ id: z.string().uuid() });
  const handoffs=new Set<string>();
  app.post('/api/automation/tasks/:id/generation-context/handoff',async request=>{
    const {id}=params.parse(request.params),task=store.task(id);
    if(!task||task.kind!=='generation'||task.scenario!=='site-template'||!task.repairEvidence||!task.stopped||owns(id)||handoffs.has(id)||!['interrupted','failed','queued'].includes(task.status)||!task.generatedSiteId||!task.generation?.conversationId)throw new Conflict('仅能交接已停止的 AI Site 修复任务');
    const brokenPending=task.generation.state==='waiting'&&task.generation.pending&&/reasoning_content|unsupported image/i.test(task.context+'\n'+task.error);
    if(!['failed','interrupted'].includes(task.generation.state||'')&&!brokenPending)throw new Conflict('缺少原会话失败终态，先核对执行状态');
    const site=store.site(task.generatedSiteId);
    if(!site||store.headers().some(t=>t.id!==id&&t.generatedSiteId===task.generatedSiteId&&(!t.stopped||owns(t.id)||t.delivery?.stopped===false||['queued','following-up'].includes(t.status))))throw new Conflict('同站仍有活动执行，不能更换会话');
    retainStoppedFollowupReservations(task,store,owns);
    handoffs.add(id);
    try{
      const {request:remote}=koobooClient(task,vault,AbortSignal.timeout(60000));
      const list=await remote('AIConversation/List',undefined,site.siteId);
      const old=Array.isArray(list)?list.find(c=>c.id===task.generation!.conversationId):undefined;
      if(!old)throw new Conflict('原会话不属于当前站点，禁止交接');
      const planned=task.generation.conversationHandoff;
      const handoff=planned&&planned.from===old.id?planned:{from:old.id,to:randomUUID()};
      task.generation.conversationHandoff=handoff;store.put(task);
      if(!list.some((c:{id:string})=>c.id===handoff.to)){
        const receipt=await remote('AIConversation/Create',{id:handoff.to,path:old.path,title:'修复接续 · '+task.resourceName,modelSelection:old.modelSelection,workspaceId:old.workspaceId},site.siteId);
        if(receipt?.id!==handoff.to)throw new Conflict('新会话回执尚未确认；保留交接身份，禁止发送委托');
      }
      const current=store.task(id)!;
      if(owns(id)||!current.stopped||current.generatedSiteId!==task.generatedSiteId)throw new Conflict('任务执行状态已变化，交接未发送');
      task.generation.conversationId=handoff.to;task.threadId=handoff.to;task.context='';
      delete task.generation.deliveryId;delete task.generation.deliveryState;delete task.generation.runId;delete task.generation.pending;delete task.generation.repairBatch;
      task.generation.state='unknown';task.generation.next={action:'continue',reason:'保留原站与原会话记录，用独立干净会话接续修复',evidence:[],message:'这是同站修复交接。旧会话 '+handoff.from+' 保留供追溯；先读取当前真实实现，按本任务已有的独立报告和附件修复，保留完成内容与数据。'};
      const root=store.root(task);
      if(root?.optimization){root.optimization.state='repairing';root.optimization.activeTaskId=id;root.optimization.reason='';root.optimization.nextSteps=[];delete root.optimization.stoppedAt;store.put(root,true);}
      task.status='queued';task.error='';delete task.interruption;if(task.followup)task.followup.state='resolved';store.put(task);
      store.event(id,`同站修复会话交接：${handoff.from} → ${handoff.to}；保留旧会话、站点、报告与累计用量，未重复建站。`);
      return task;
    }finally{handoffs.delete(id);}
  });
  app.get('/api/automation/tasks/:id/generation-context', async request => {
    const { id } = params.parse(request.params);
    if (!store.task(id)) throw new Conflict('任务不存在');
    return { packages: new GenerationContextStore(store).packages(id).map(({ original, files, ...metadata }) => ({ ...metadata, originalBytes: Buffer.byteLength(original), files: files.map(({ text, ...file }) => file) })) };
  });
  app.post('/api/automation/tasks/:id/generation-context/cleanup', async request => {
    const { id } = params.parse(request.params), task = store.task(id);
    if (!task || !task.stopped || owns(id) || !['completed', 'cancelled'].includes(task.status) || store.tasks().some(t => t.generatedSiteId === task.generatedSiteId && (!t.stopped || owns(t.id)))) throw new Conflict('仅在执行已确认结束且同站无活动任务时清理；中断任务保留恢复资料');
    const site = task.generatedSiteId && store.site(task.generatedSiteId);
    if (!site) throw new Conflict('缺少已绑定的生成站');
    await cleanupGenerationContext(task, store, koobooClient(task, vault, AbortSignal.timeout(60000)).request, site.siteId, true);
    return { states: new GenerationContextStore(store).packages(id).map(p => ({ id: p.id, state: p.state, error: p.error })) };
  });
}
