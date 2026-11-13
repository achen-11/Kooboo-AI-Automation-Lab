import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AutomationStore } from './store.js';
import { TemplateWorkflowStore, readTemplateEvidence } from './template-workflow-store.js';

export function registerTemplateWorkflowApi(app: FastifyInstance, store: AutomationStore, directory: string) {
  const registry=new TemplateWorkflowStore(store),params=z.object({id:z.string().uuid()});
  app.get('/api/automation/template-checklists',async()=>({items:registry.list().length?registry.list():[registry.current()]}));
  app.post('/api/automation/template-checklists',async(request,reply)=>reply.code(201).send(registry.publish(request.body)));
  app.get('/api/automation/tasks/:id/template-workflow',async(request,reply)=>{
    const {id}=params.parse(request.params),task=store.task(id,false);
    return task?registry.response(task):reply.code(404).send({error:'任务不存在'});
  });
  app.get('/api/automation/tasks/:id/template-workflow/artifacts/:file',async(request,reply)=>{
    const {id,file}=params.extend({file:z.string().regex(/^[a-f0-9-]{36}\.(png|json)$/)}).parse(request.params),task=store.task(id,false);
    const evidence=task&&registry.evidence(task,file);if(!evidence)return reply.code(404).send({error:'证据不存在或不属于此工作流'});
    const bytes=readTemplateEvidence(directory,evidence);reply.header('X-Content-Type-Options','nosniff');
    if((request.query as {download?:string}).download==='1')reply.header('Content-Disposition',`attachment; filename="${file}"`);
    return reply.type(evidence.type).send(bytes);
  });
}
