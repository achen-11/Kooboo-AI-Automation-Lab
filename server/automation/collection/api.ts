import type { FastifyInstance } from 'fastify';
import type { AutomationStore } from '../store.js';
import { z } from 'zod';
import { CollectionStore } from './store.js';
import { collectionHash } from './runtime.js';
export function registerCollectionApi(app:FastifyInstance,store:AutomationStore,directory:string,owns:(id:string)=>boolean){
 const collections=new CollectionStore(store,directory);
 const params=z.object({id:z.string().uuid()});
 app.post('/api/automation/tasks/:id/collection/accept-current-assets',async(request,reply)=>{
   const {id}=params.parse(request.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});
   const body=z.object({reason:z.string().trim().min(10).max(1000),expectedStateHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(request.body);
   return collections.acceptCurrentAssetGaps(task,store.sanitize(body.reason),body.expectedStateHash,owns);
 });
 app.get('/api/automation/tasks/:id/collection',async(request,reply)=>{
   const {id}=params.parse(request.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});
   const run=collections.forTask(task);if(!run)return {collection:null};
   let index:{path:string;sha256:string;size:number}[]=[];try{index=run.materialVersionId?collections.snapshot(run.materialVersionId)?.originals||[]:collections.inventory(run,false);}catch{}
   const {page,pageSize}=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query);
   return {collection:{...run,files:undefined,review:undefined,operations:run.operations.map(o=>({...o,receipt:undefined})).slice(-30)},snapshot:run.materialVersionId?{id:run.materialVersionId,sha256:run.snapshotHash,files:run.files?.length}:null,artifacts:{items:index.slice((page-1)*pageSize,page*pageSize),page,pageSize,total:index.length}};
 });
 app.get('/api/automation/tasks/:id/collection/evidence',async(request,reply)=>{
   const {id}=params.parse(request.params),task=store.task(id),run=task&&collections.forTask(task);if(!run)return reply.code(404).send({error:'采集任务不存在'});
   const {path,offset,limit}=z.object({path:z.string().min(1).max(1000),offset:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(50000).default(12000)}).parse(request.query);
   const bytes=collections.read(run,path),text=bytes.toString('utf8');return {path,sha256:collectionHash(bytes),text:text.slice(offset,offset+limit),offset,totalChars:text.length,nextOffset:offset+limit<text.length?offset+limit:null};
 });
}
