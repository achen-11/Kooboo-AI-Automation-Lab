import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { assertGenerationInput, cleanupGenerationContext, GenerationContextStore, generationContextReaderVersion, generationInputLimits, generationReaderLimits, prepareGenerationContext, shardContext, contextReader, type ContextRequest, type ContextPackage } from '../server/automation/generation-context.js';
import { GenerationInputError } from '../server/automation/errors.js';
import { isContextOverflow } from '../server/automation/generator.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'generation-context-')), app = await createApp({ directory, startWorker: false, serveWeb: false });
  const store = app.automationStore, resource = store.saveResource({ name: 'Migration', scenario: 'migration', contentUrl: 'https://example.test', referenceUrl: '', description: '', files: [], externalSource: '', externalId: '' });
  const task = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'site', environmentId: randomUUID(), requirements: 'repair', }, structuredClone(defaultAutomationSettings))[0];
  task.requirementsId = randomUUID(); task.siteRevision = randomUUID();
  const remote = new Map<string, string>(); let writes = 0, deletes = 0, fail = false;
  const request: ContextRequest = async (_path, body: any) => {
    if (fail) throw new Error('network interrupted');
    const result = runInNewContext('(function(){' + body.arguments.code + '})()', { k: { file: { read: (path: string) => remote.get(path) ?? null, write: (path: string, text: string) => { writes++; remote.set(path, text); }, delete: (path: string) => { deletes++; remote.delete(path); } } } });
    return { contents: [{ result }] };
  };
  return { ...app, directory, store, task, siteId: randomUUID(), remote, request, counts: () => ({ writes, deletes }), failure: (value: boolean) => { fail = value; }, async close() { await app.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function restore(root: string, texts: Map<string, string>): any {
  const node = JSON.parse(texts.get(root)!);
  if (node.type === 'value') return node.value;
  if (node.type === 'object') return Object.fromEntries(node.entries.map(([key, ref]: [string, string]) => [key, restore(ref, texts)]));
  const parts = node.parts.map((ref: string) => restore(ref, texts));
  return node.type === 'items' ? parts : node.type === 'array' ? parts.flat() : parts.join('');
}

test('large nested arrays, singleton records, repeated evidence and Unicode round-trip without losing a key', () => {
  const source = { instructions: '完整说明😀\n'.repeat(12000), manifest: { records: [{ id: 'one', evidence: 'repeat'.repeat(4000) }], relations: Array.from({ length: 2000 }, (_, i) => ({ category: '184', id: i, evidence: ['same.json'] })) } };
  const tree = shardContext(source), texts = new Map(tree.files.map(f => [f.name, f.text]));
  assert.deepEqual(restore(tree.root, texts), source);
  assert.ok(tree.files.every(f => f.size <= generationInputLimits.shardBytes));
  assert.ok(tree.files.length < 200, 'arrays are grouped, rather than a separate file per scalar');
});

test('small instructions and manifest stay in message and preserve a platform original', async () => {
  const f = await fixture(); try {
    const source = { instructions: '修复全部问题', guidance: '\n保持事实', manifest: { id: f.task.requirementsId, items: [{ id: 'a', required: true }] } };
    const result = await prepareGenerationContext(f.task, f.store, f.request, f.siteId, source);
    assert.equal(result.mode, 'message'); assert.match(result.text, /修复全部问题/); assert.match(result.text, /"required":true/); assert.equal(f.remote.size, 0);
    assert.deepEqual(JSON.parse(new GenerationContextStore(f.store).packages(f.task.id)[0].original), source);
  } finally { await f.close(); }
});

test('frozen collection contexts deliver the same scoped record-binding schema in message and reader packages',async()=>{
  for(const mode of ['message','kfile']){
    const f=await fixture();try{
      f.task.collectionVersionId=randomUUID();
      const manifest={items:[
        {id:'pages',kind:'page',required:true},{id:'template',kind:'template',required:true},
        {id:'records',kind:'data',required:true,dataIdentity:{kind:'page'}},{id:'legacy-records',kind:'data',required:true},
        {id:'seo',kind:'seo',required:true},{id:'interaction',kind:'interaction',required:true},
        {id:'relations',kind:'data',required:true,dataIdentity:{kind:'relations'}},{id:'assets',kind:'data',required:true,dataIdentity:{kind:'assets'}},
        {id:'optional',kind:'page',required:false},
      ]};
      const source={instructions:'Declare actual records',manifest,...(mode==='kfile'?{materials:[{name:'source.json',storage:'kfile'}]}:{})};
      const result=await prepareGenerationContext(f.task,f.store,f.request,f.siteId,source);assert.equal(result.mode,mode);
      const pkg=new GenerationContextStore(f.store).packages(f.task.id)[0],archived=JSON.parse(pkg.original),contract=archived.collectionRecordBindings;
      assert.deepEqual(archived.manifest,manifest);assert.equal('collectionRecordBindings' in source,false,'caller input stays intact');
      assert.deepEqual(contract.rowSchema.properties.requirementId.enum,['pages','template','records','legacy-records']);
      assert.deepEqual(contract.rowSchema.properties.targetKind.enum,['sqlite','content']);
      assert.deepEqual(contract.rowSchema.required,['id','requirementId','sourceUrl','targetKind','targetContainer','targetId']);
      assert.equal(contract.rowSchema.properties.identityKeyField.type,'string');assert.equal(contract.rowSchema.properties.identityKeyField.default,'id');
      assert.match(contract.rules.join('\n'),/真实记录自身须以 sourceUrl 或 oldUrl 唯一回指/);assert.match(contract.rules.join('\n'),/平台不会静默归一/);
      if(mode==='message')assert.ok(result.text.includes(JSON.stringify(contract)));
      else{
        assert.match(result.text,/automationRead\("collectionRecordBindings"\)/);
        const base=pkg.index.slice(0,pkg.index.lastIndexOf('/')+1),restored=runInNewContext(f.remote.get(base+'reader.js')+';JSON.stringify(automationRead("collectionRecordBindings"));',{k:{file:{read:(path:string)=>f.remote.get(path)??null}}});
        assert.deepEqual(JSON.parse(restored),contract);
      }
    }finally{await f.close();}
  }
});

test('total outgoing text switches to kfile, exact original survives, re-provisioning restores the same version', async () => {
  const f = await fixture(); try {
    const source = { instructions: '修复程序差异'.repeat(5000), guidance: '保留旧路径'.repeat(2000), manifest: { records: Array.from({ length: 483 }, (_, id) => ({ id, refs: Array.from({ length: 10 }, (_, i) => `${id}-${i}.json`) })) } };
    const first = await prepareGenerationContext(f.task, f.store, f.request, f.siteId, source), registry = new GenerationContextStore(f.store), pkg = registry.packages(f.task.id)[0];
    assert.equal(first.mode, 'kfile'); assert.ok(Buffer.byteLength(first.text) < generationInputLimits.textBytes); assert.equal(pkg.state, 'ready');
    const base = pkg.index.slice(0, pkg.index.lastIndexOf('/') + 1), index = JSON.parse(f.remote.get(pkg.index)!);
    assert.deepEqual(restore(index.root, new Map([...f.remote].map(([name, value]) => [name.slice(base.length), value]))), source);
    const restoredByReader=runInNewContext(f.remote.get(base+'reader.js')+'; JSON.stringify(automationRead());',{k:{file:{read:(name:string)=>f.remote.get(name)??null}}});
    assert.deepEqual(JSON.parse(restoredByReader),source,'the shipped executable decoder restores arrays and Unicode exactly');
    f.remote.set('business/data.json', 'keep');
    await cleanupGenerationContext(f.task, f.store, f.request, f.siteId, false); assert.equal(registry.packages(f.task.id)[0].state, 'retained'); assert.equal(f.counts().deletes, 0);
    await cleanupGenerationContext(f.task, f.store, f.request, f.siteId, true); assert.equal(registry.packages(f.task.id)[0].state, 'cleaned'); assert.deepEqual([...f.remote.keys()], ['business/data.json']);
    const restored = await prepareGenerationContext(f.task, f.store, f.request, f.siteId, source);
    assert.equal(restored.packageId, first.packageId); assert.equal(registry.packages(f.task.id).length, 1); assert.equal(f.remote.get(pkg.index), pkg.files.at(-1)!.text);
    f.task.siteRevision = randomUUID(); await prepareGenerationContext(f.task, f.store, f.request, f.siteId, source); assert.equal(registry.packages(f.task.id).length, 2);
  } finally { await f.close(); }
});

test('material helpers page the complete index and explicitly describe JSON without returning character keys', async () => {
  const f=await fixture();try{
    const materials=Array.from({length:73},(_,index)=>({name:'collection/data/'+index+'.json',id:'material-'+index,destination:'_materials/'+index+'.json',type:'application/json',size:600000,sha256:'a'.repeat(64),storage:'kfile'}));
    const source={instructions:'Process frozen materials',manifest:{items:[]},materials};
    const result=await prepareGenerationContext(f.task,f.store,f.request,f.siteId,source);assert.equal(result.mode,'kfile','small instructions still provision material helpers');
    const pkg=new GenerationContextStore(f.store).packages(f.task.id)[0],base=pkg.index.slice(0,pkg.index.lastIndexOf('/')+1),reader=f.remote.get(base+'reader.js')!;
    const execute=(code:string)=>JSON.parse(runInNewContext(reader+';JSON.stringify('+code+');',{k:{file:{read:(path:string)=>f.remote.get(path)??null}}}));
    const names:string[]=[];let offset=0;
    do{const page=execute('automationMaterials('+JSON.stringify({offset,limit:999999})+')');assert.ok(JSON.stringify(page).length<=generationReaderLimits.resultChars);assert.ok(page.items.length<=generationReaderLimits.items);assert.equal(page.total,materials.length);names.push(...page.items.map((item:any)=>item.name));if(page.nextOffset===null)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset;}while(offset<materials.length);
    assert.deepEqual(names,materials.map(file=>file.name));
    const rows=Array.from({length:12000},(_,id)=>({id,body:'complete original body'})),text=JSON.stringify(rows);assert.ok(text.length>500000);f.remote.set(materials[0].destination,text);
    const summary=execute('automationMaterialRead("collection/data/0.json",{format:"json"})');
    assert.equal(summary.valueType,'array');assert.equal(summary.total,rows.length);assert.ok(summary.items.every((item:any)=>item.valueType==='object'));assert.ok(JSON.stringify(summary).length<=generationReaderLimits.resultChars);
    const record=execute('automationMaterialRead("collection/data/0.json",{format:"json",path:[0]})');assert.equal(record.valueType,'object');assert.deepEqual(record.items.map((item:any)=>item.key),['id','body']);
    assert.deepEqual(execute('automationMaterials({prefix:"collection/data/72"})').items.map((item:any)=>item.name),[materials[72].name]);
    assert.doesNotMatch(result.text,/return \{index:idx,root:root\}|items:m\.items\.map/);
  }finally{await f.close();}
});

test('bounded text and typed JSON summaries preserve Unicode and escaped characters across all slices', async () => {
  const f=await fixture();try{
    const content='中文😀\u0000"\\\n'.repeat(900),json=JSON.stringify({records:[{id:'one'}],body:content});
    const materials=[{name:'source.json',id:'source',destination:'_materials/source.json',type:'application/json',size:Buffer.byteLength(json),sha256:'a'.repeat(64),storage:'kfile'}];
    await prepareGenerationContext(f.task,f.store,f.request,f.siteId,{instructions:'Read exact source',materials});f.remote.set(materials[0].destination,json);
    const pkg=new GenerationContextStore(f.store).packages(f.task.id)[0],base=pkg.index.slice(0,pkg.index.lastIndexOf('/')+1),reader=f.remote.get(base+'reader.js')!;
    const execute=(code:string)=>JSON.parse(runInNewContext(reader+';JSON.stringify('+code+');',{k:{file:{read:(path:string)=>f.remote.get(path)??null}}}));
    for(const format of ['text','json']){
      let offset=0,restored='';
      do{const opts={format,offset,chars:999999,...(format==='json'?{path:['body']}:{})};const part=execute('automationMaterialRead("source.json",'+JSON.stringify(opts)+')');assert.equal(part.valueType,'string');assert.ok(part.text.length<=generationReaderLimits.textChars);assert.ok(JSON.stringify(part).length<=generationReaderLimits.resultChars);restored+=part.text;if(part.nextOffset===null)break;assert.ok(part.nextOffset>offset);offset=part.nextOffset;}while(true);
      assert.equal(restored,format==='text'?json:content);
    }
    const summary=execute('automationMaterialRead("source.json",{format:"json"})');assert.equal(summary.valueType,'object');assert.equal(summary.total,2);assert.equal(summary.items.find((item:any)=>item.key==='records').valueType,'array');
    assert.throws(()=>execute('automationMaterialRead("source.json",{format:"json",path:["constructor"]})'),/Unknown JSON path/);
  }finally{await f.close();}
});

test('unknown files and binary materials never read or expose their content', async () => {
  const f=await fixture();try{
    const materials=[{name:'photo.png',id:'photo',destination:'/materials/photo.png',type:'image/png',size:30,sha256:'a'.repeat(64),storage:'file'}];
    await prepareGenerationContext(f.task,f.store,f.request,f.siteId,{instructions:'Use the image mapping',materials});
    f.remote.set(materials[0].destination,'binary-private-content');f.remote.set('unindexed-private.json','unindexed-private-content');
    const pkg=new GenerationContextStore(f.store).packages(f.task.id)[0],base=pkg.index.slice(0,pkg.index.lastIndexOf('/')+1),reader=f.remote.get(base+'reader.js')!,reads:string[]=[];
    const execute=(code:string)=>runInNewContext(reader+';'+code,{k:{file:{read:(path:string)=>{reads.push(path);return f.remote.get(path)??null;}}}});
    assert.throws(()=>execute('automationMaterialRead("unindexed-private.json")'),/Unknown or ambiguous material/);
    assert.throws(()=>execute('automationMaterialRead("photo.png")'),/not a text kfile/);
    assert.throws(()=>execute('automationMaterialRead("photo.png",{format:"json"})'),/not a text kfile/);
    assert.ok(!reads.includes('unindexed-private.json'));assert.ok(!reads.includes(materials[0].destination));
    assert.ok(!JSON.stringify(execute('automationMaterials()')).includes('private-content'));
  }finally{await f.close();}
});

test('the provided KScript example runs inside a function without shadowing the readonly global t', async () => {
  const f=await fixture();try{
    const materials=[{name:'one.txt',id:'one',destination:'_materials/one.txt',type:'text/plain',size:4,sha256:'a'.repeat(64),storage:'kfile'}];
    const result=await prepareGenerationContext(f.task,f.store,f.request,f.siteId,{instructions:'Use function-local variables',materials});
    const code=result.text.match(/首先执行：(return \(function\(\)\{[^\n]+?\}\)\(\);)/)?.[1];assert.ok(code);
    const translate=()=> 'translation';const sandbox:any={k:{file:{read:(path:string)=>f.remote.get(path)??null}}};Object.defineProperty(sandbox,'t',{value:translate,writable:false,configurable:true});
    // run_kscript accepts a top-level return. Preserve the example's own IIFE
    // and evaluate its expression in a scope with Kooboo's readonly global.
    const page=runInNewContext(code.replace(/^return /,''),sandbox);
    assert.equal(page.total,1);assert.equal(sandbox.t,translate);assert.equal(sandbox.readerBase,undefined);assert.equal(sandbox.automationReader,undefined);assert.equal(sandbox.automationMaterials,undefined);
  }finally{await f.close();}
});

test('reader version changes allocate a new package while legacy archives remain intact and same-version retries reuse it', async () => {
  const f=await fixture();try{
    const source={instructions:'legacy task document'.repeat(3000)},original=JSON.stringify(source),registry=new GenerationContextStore(f.store),legacyId=randomUUID(),legacyBase=`_automation-context/${f.task.id}/${legacyId}/`;
    const legacyHash=createHash('sha256').update(JSON.stringify({format:'automation-context-v2',taskId:f.task.id,versionId:f.task.versionId,siteId:f.siteId,siteRevision:f.task.siteRevision,manifestId:f.task.requirementsId,original})).digest('hex');
    const legacy:ContextPackage={id:legacyId,taskId:f.task.id,versionId:f.task.versionId,siteId:f.siteId,siteRevision:f.task.siteRevision,manifestId:f.task.requirementsId,hash:legacyHash,createdAt:1,original,index:legacyBase+'index.json',state:'retained',transport:'kfile',files:[]};registry.put(legacy);
    const result=await prepareGenerationContext(f.task,f.store,f.request,f.siteId,source),current=registry.packages(f.task.id).find(pkg=>pkg.id===result.packageId)!;
    assert.notEqual(current.id,legacy.id);assert.notEqual(current.hash,legacy.hash);assert.deepEqual(registry.packages(f.task.id).find(pkg=>pkg.id===legacy.id),legacy);
    const index=JSON.parse(f.remote.get(current.index)!);assert.equal(index.readerVersion,generationContextReaderVersion);assert.deepEqual(index.readerLimits,generationReaderLimits);
    assert.equal((await prepareGenerationContext(f.task,f.store,f.request,f.siteId,source)).packageId,current.id);assert.equal(registry.packages(f.task.id).length,2);
    const tree=shardContext(source),oldRemote=new Map(tree.files.map(file=>[legacyBase+file.name,file.text]));oldRemote.set(legacyBase+'index.json',JSON.stringify({format:'automation-context-v2',root:tree.root,sections:Object.keys(source)}));
    const restored=runInNewContext(contextReader(legacyBase)+';JSON.stringify(automationRead());',{k:{file:{read:(path:string)=>oldRemote.get(path)??null}}});assert.deepEqual(JSON.parse(restored),source,'the lossless reader still accepts v2 node trees');
  }finally{await f.close();}
});

test('partial upload never sends, cleanup failure is retained, changed/unowned files are never deleted', async () => {
  const f = await fixture(); try {
    const source = { instructions: 'a'.repeat(50000) }; let calls = 0;
    const flaky: ContextRequest = async (...args) => { if (++calls === 2) throw new Error('lost receipt'); return f.request(...args); };
    // Use nonrepeating records to require multiple upload batches.
    const big = { ...source, manifest: Array.from({ length: 100 }, (_, i) => ({ id: i, body: String(i).repeat(6000) })) };
    await assert.rejects(prepareGenerationContext(f.task, f.store, flaky, f.siteId, big), /lost receipt/);
    const registry = new GenerationContextStore(f.store); assert.equal(registry.packages(f.task.id)[0].state, 'archived'); assert.ok(f.remote.size > 0);
    await prepareGenerationContext(f.task, f.store, f.request, f.siteId, big);
    f.failure(true); await cleanupGenerationContext(f.task, f.store, f.request, f.siteId, true); assert.equal(registry.packages(f.task.id)[0].state, 'pending-cleanup'); f.failure(false);
    const pkg = registry.packages(f.task.id)[0]; f.remote.set(pkg.files[0].name, 'changed');
    await cleanupGenerationContext(f.task, f.store, f.request, f.siteId, true); assert.equal(f.remote.get(pkg.files[0].name), 'changed'); assert.equal(registry.packages(f.task.id)[0].state, 'pending-cleanup');
    const before = f.counts().deletes; await cleanupGenerationContext(f.task, f.store, f.request, randomUUID(), true); assert.equal(f.counts().deletes, before);
    await assert.rejects(prepareGenerationContext(f.task, f.store, f.request, f.siteId, big), /collision/);
  } finally { await f.close(); }
});

test('final envelope checks images, answers and combined bytes, and overflow signals are deterministic', () => {
  assert.throws(() => assertGenerationInput('中文'.repeat(10000)), GenerationInputError);
  assert.throws(() => assertGenerationInput('ok', Array.from({ length: 21 }, () => ({ uri: 'data:image/png;base64,AA==', mediaType: 'image/png' }))), GenerationInputError);
  assert.throws(() => assertGenerationInput('x'.repeat(24000), [{ uri: 'x'.repeat(24 * 1024 * 1024 - 100), mediaType: 'image/png' }]), GenerationInputError);
  assert.throws(() => assertGenerationInput(undefined, undefined, { result: 'x'.repeat(25 * 1024 * 1024) }), GenerationInputError);
  assert.equal(isContextOverflow('maximum context length exceeded'), true); assert.equal(isContextOverflow('context_length_exceeded'), true); assert.equal(isContextOverflow('上下文已经溢出'), true); assert.equal(isContextOverflow('network timeout'), false);
});
