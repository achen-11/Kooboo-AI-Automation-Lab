import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { inspectionTools } from '../server/automation/inspection-tools.js';
import { defaultAutomationSettings, type MaterialFile } from '../shared/automation.js';
import { sourceReader } from '../server/automation/completeness.js';

test('large source HTML is bounded on the inspection wire while registered raw bytes and truncation remain available',async()=>{
  const html='<html><body>'+('中文 "quoted" \\ path '.repeat(10000))+'</body></html>';
  const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(html);});
  const directory=mkdtempSync(resolve(tmpdir(),'source-wire-')),db=new Database(':memory:'),store=new AutomationStore(db),files:MaterialFile[]=[];
  let inspection:Awaited<ReturnType<typeof inspectionTools>>|undefined;
  try{
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');
    const source=`http://127.0.0.1:${address.port}/`,resource=store.saveResource({name:'Source',scenario:'site-template',description:'',contentUrl:source,referenceUrl:'',files:[],externalSource:'',externalId:''});
    const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];
    inspection=await inspectionTools(task,store,new Vault(resolve(directory,'vault')),directory,directory,files,new AbortController().signal);
    const response=await fetch(inspection.env.INSPECTION_URL,{method:'POST',headers:{Authorization:'Bearer '+inspection.env.INSPECTION_TOKEN,'content-type':'application/json'},body:JSON.stringify({tool:'source',input:{kind:'source',url:source}})});
    assert.equal(response.status,200);const wire=await response.text(),reply=JSON.parse(wire);assert.ok(Buffer.byteLength(wire)<16000);assert.equal(reply.outputTruncated,true);assert.equal(reply.result.status,200);assert.equal(reply.result.truncated,false);
    const file=files.find(f=>f.name===reply.evidence)!;assert.ok(file);const bytes=readFileSync(resolve(directory,reply.evidencePath)),raw=JSON.parse(bytes.toString());
    assert.equal(raw.body,html);assert.equal(raw.truncated,false);assert.equal(reply.result.body,raw.body.slice(0,reply.result.body.length));assert.ok(Buffer.byteLength(reply.result.body)<=6000);assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal(store.task(task.id)?.artifacts?.find(f=>f.name===file.name)?.sha256,file.sha256);
    const legacy=await sourceReader(task,store,directory,value=>value)({kind:'source',url:source},new AbortController().signal) as {body:string;truncated:boolean};assert.equal(legacy.body,html.slice(0,100000));assert.equal(legacy.truncated,true,'other decision stages retain their existing bounded source contract');
  }finally{await inspection?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();rmSync(directory,{recursive:true,force:true});}
});
