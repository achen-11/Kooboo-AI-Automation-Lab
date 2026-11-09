import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { parseFrozenAssetSource, compareAssetTargets, readTargetAsset, type AssetTargetObservation, type CollectionAssetBinding } from '../server/automation/collection/asset-target.js';

const sourceUrl='https://source.invalid/',targetBaseUrl='https://target.invalid/';
const digest=(bytes:Buffer,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
function fixture(count=2){
  const files=new Map<string,Buffer>(),assets=Array.from({length:count},(_,index)=>{
    const bytes=Buffer.from([0,255,254,index%256,128]),localPath='images/'+index+'.bin';files.set(localPath,bytes);
    return {url:new URL('/image/'+index,sourceUrl).href,localPath,status:'saved',hash:digest(bytes,'sha1'),bytes:bytes.length};
  });
  const state={source:sourceUrl,assets,stylesheets:[] as Record<string,unknown>[]},keys=assets.map(row=>row.url);
  const parse=(changes:Record<string,unknown>={})=>parseFrozenAssetSource({state,sourceUrl,expectedKeys:keys,expectedCount:keys.length,readFrozen:path=>{const bytes=files.get(path);if(!bytes)throw new Error('not frozen');return bytes;},...changes});
  const bindings=():CollectionAssetBinding[]=>assets.map(row=>({sourceUrl:row.url,materialPath:row.localPath,targetUrl:new URL('/media/'+row.localPath,targetBaseUrl).href}));
  const observations=():AssetTargetObservation[]=>bindings().flatMap((row,index)=>{const bytes=files.get(assets[index].localPath);return bytes?[{url:row.targetUrl,finalUrl:row.targetUrl,status:200,sha256:digest(bytes),size:assets[index].bytes}]:[];});
  return {state,assets,files,keys,parse,bindings,observations};
}

test('all frozen source URL identities are compared with actual binary digests, including external source keys',()=>{
  const f=fixture();f.assets[0].url='https://cdn.other.invalid/picture?version=1';f.keys[0]=f.assets[0].url;
  const source=f.parse(),result=compareAssetTargets(source,f.bindings(),f.observations(),targetBaseUrl);
  assert.equal(source.issues.length,0);assert.equal(result.state,'complete');assert.deepEqual(result.actualKeys,f.keys);assert.equal(result.requests.length,2);
  assert.equal(source.assets[0].sha256,digest(f.files.get(f.assets[0].localPath)!));assert.equal(source.assets[0].sha256.length,64);
});

test('846 source URLs may share 796 frozen files and identical target bytes without inventing identities',()=>{
  const f=fixture(796);
  for(let i=0;i<50;i++){f.assets.push({...f.assets[i],url:new URL('/duplicate/'+i,sourceUrl).href,status:'deduped'});f.keys.push(f.assets.at(-1)!.url);}
  const bindings=f.bindings();for(let i=796;i<846;i++)bindings[i].targetUrl=bindings[i-796].targetUrl;
  const observations=f.observations().slice(0,796),result=compareAssetTargets(f.parse(),bindings,observations,targetBaseUrl);
  assert.equal(f.files.size,796);assert.equal(result.state,'complete');assert.equal(result.actualKeys.length,846);assert.equal(result.requests.length,796);
});

test('81 failed assets are excluded as originals and cannot be included in a successful delivery count',()=>{
  const f=fixture();for(let index=0;index<81;index++)f.assets.push({url:new URL('/failed/'+index,sourceUrl).href,localPath:'',status:'failed',hash:'',bytes:0});
  const source=f.parse();assert.equal(source.excludedKeys.length,81);assert.equal(source.assets.length,2);assert.equal(compareAssetTargets(source,f.bindings().slice(0,2),f.observations().slice(0,2),targetBaseUrl).state,'complete');
  const all=f.parse({expectedKeys:f.assets.map(row=>row.url),expectedCount:83});assert.equal(all.assets.length,2);assert.equal(all.issues.filter(row=>row.reason.includes('未成功')).length,81);assert.equal(compareAssetTargets(all,[],[],targetBaseUrl).state,'unverified');
});

test('digest observations resume in 50-request windows without persisting or re-reading target binary payloads',()=>{
  const f=fixture(120),source=f.parse(),bindings=f.bindings(),actual=f.observations(),cache=new Map<string,AssetTargetObservation>(),reads=new Map<string,number>();
  let report=compareAssetTargets(source,bindings,[],targetBaseUrl),windows=0;
  while(report.state!=='complete'&&windows<4){
    windows++;let remaining=50;
    for(const url of report.requests){if(cache.has(url))continue;if(!remaining--)break;reads.set(url,(reads.get(url)||0)+1);cache.set(url,structuredClone(actual.find(row=>row.url===url)!));}
    report=compareAssetTargets(source,bindings,[...cache.values()],targetBaseUrl);
  }
  assert.equal(windows,3);assert.equal(report.state,'complete');assert.equal(reads.size,120);assert.ok([...reads.values()].every(count=>count===1));assert.ok([...cache.values()].every(row=>!('body' in row)&&!('bytes' in row)));
});

test('frozen state SHA256 hashes are also verified rather than treated as evidence by themselves',()=>{
  const f=fixture();f.assets[0].hash=digest(f.files.get(f.assets[0].localPath)!);assert.equal(f.parse().issues.length,0);f.assets[0].hash='0'.repeat(64);assert.ok(f.parse().issues.length);
});

for(const mode of ['count-only','missing-identity','duplicate-key','wrong-count','missing-source-hash','wrong-source-hash','wrong-source-size','missing-frozen-bytes','changed-frozen-bytes','unsafe-path','duplicate-source','source-mismatch','missing-state'] as const){
  test(`source completeness rejects ${mode}`,()=>{
    const f=fixture(),changes:Record<string,unknown>={};
    if(mode==='count-only')changes.expectedKeys=undefined;
    if(mode==='missing-identity'){changes.expectedKeys=f.keys.slice(1);changes.expectedCount=1;}
    if(mode==='duplicate-key')changes.expectedKeys=[f.keys[0],f.keys[0]];
    if(mode==='wrong-count')changes.expectedCount=796;
    if(mode==='missing-source-hash')f.assets[0].hash='';
    if(mode==='wrong-source-hash')f.assets[0].hash='0'.repeat(64);
    if(mode==='wrong-source-size')f.assets[0].bytes++;
    if(mode==='missing-frozen-bytes')f.files.delete(f.assets[0].localPath);
    if(mode==='changed-frozen-bytes')f.files.set(f.assets[0].localPath,Buffer.alloc(5));
    if(mode==='unsafe-path')f.assets[0].localPath='../private';
    if(mode==='duplicate-source')f.assets.push({...f.assets[0]});
    if(mode==='source-mismatch')f.state.source='https://another.invalid/';
    if(mode==='missing-state')changes.state={source:sourceUrl};
    const source=f.parse(changes);assert.ok(source.issues.length);assert.notEqual(compareAssetTargets(source,[],[],targetBaseUrl).state,'complete');
  });
}

test('read stylesheet metadata without frozen CSS bytes remains unverified',()=>{
  const f=fixture();f.state.stylesheets=Array.from({length:8},(_,index)=>({url:new URL('/css/'+index+'.css',sourceUrl).href,status:'read',bytes:100}));
  const keys=f.state.stylesheets.map(row=>row.url as string),source=f.parse({collection:'stylesheets',expectedKeys:keys,expectedCount:8});
  assert.equal(source.assets.length,0);assert.equal(source.issues.length,8);assert.ok(source.issues.every(row=>row.reason.includes('冻结原始字节')));assert.equal(compareAssetTargets(source,[],[],targetBaseUrl).state,'unverified');
});

for(const mode of ['no-binding','duplicate-binding','wrong-material','external-target','credentials','extra-source','different-bytes','same-size-different-bytes','missing-hash','duplicate-observation','external-final','not-found','unavailable','conflicting-target','count-only'] as const){
  test(`target comparison rejects ${mode}`,()=>{
    const f=fixture(),bindings=f.bindings(),observations=f.observations();
    if(mode==='no-binding')bindings.pop();
    if(mode==='duplicate-binding')bindings.push({...bindings[0]});
    if(mode==='wrong-material')bindings[0].materialPath=f.assets[1].localPath;
    if(mode==='external-target')bindings[0].targetUrl='https://outside.invalid/image';
    if(mode==='credentials')bindings[0].targetUrl='https://user:secret@target.invalid/image';
    if(mode==='extra-source')bindings.push({...bindings[0],sourceUrl:'https://unknown.invalid/'});
    if(mode==='different-bytes')observations[0].size++;
    if(mode==='same-size-different-bytes')observations[0].sha256=digest(Buffer.alloc(observations[0].size));
    if(mode==='missing-hash')observations[0].sha256='';
    if(mode==='duplicate-observation')observations.push({...observations[0]});
    if(mode==='external-final')observations[0].finalUrl='https://outside.invalid/';
    if(mode==='not-found')observations[0].status=404;
    if(mode==='unavailable')observations[0].status=503;
    if(mode==='conflicting-target')bindings[1].targetUrl=bindings[0].targetUrl;
    if(mode==='count-only')for(const observation of observations)observation.sha256='';
    const result=compareAssetTargets(f.parse(),bindings,observations,targetBaseUrl);assert.notEqual(result.state,'complete');
    if(['different-bytes','same-size-different-bytes','not-found'].includes(mode))assert.equal(result.state,'incomplete');
    if(['external-target','credentials','wrong-material','conflicting-target'].includes(mode))assert.ok(!result.requests.includes(bindings[0].targetUrl));
  });
}

test('target reader hashes genuine response bytes, follows only same-origin redirects and returns cacheable digests',async()=>{
  const bytes=Buffer.from([0,255,192,193,128,13,10]),requests:string[]=[],methods:string[]=[],headers:unknown[]=[];
  let external=0;const other=createServer((_req,res)=>{external++;res.end('outside');});
  const server=createServer((req,res)=>{requests.push(req.url!);methods.push(req.method!);headers.push(req.headers.authorization);if(req.url==='/redirect'){res.writeHead(302,{location:'/binary'}).end();return;}if(req.url==='/outside'){const address=other.address() as {port:number};res.writeHead(302,{location:`http://127.0.0.1:${address.port}/secret`}).end();return;}res.end(bytes);});
  const listen=(value:typeof server)=>new Promise<void>((done,reject)=>{value.once('error',reject);value.listen(0,'127.0.0.1',done);});
  try{
    await listen(server);await listen(other);const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const allowed=['/binary','/redirect','/outside'].map(path=>base+path),options={targetBaseUrl:base,allowedTargetUrls:allowed,signal:AbortSignal.timeout(10000)};
    const result=await readTargetAsset(base+'/redirect',options);assert.deepEqual(result,{url:base+'/redirect',finalUrl:base+'/binary',status:200,sha256:digest(bytes),size:bytes.length});
    assert.ok(!('body' in result));assert.ok(!('bytes' in result));assert.deepEqual(methods,['GET','GET']);assert.ok(headers.every(header=>header===undefined));
    await assert.rejects(readTargetAsset(base+'/outside',options),/重定向越出/);assert.equal(external,0);
    const before=requests.length;await assert.rejects(readTargetAsset(base+'/arbitrary',options),/未在当前冻结映射许可/);await assert.rejects(readTargetAsset('https://outside.invalid/file',options),/未在当前冻结映射许可/);assert.equal(requests.length,before);
    await assert.rejects(readTargetAsset(base+'/binary',{...options,maxBytes:3}),/超过字节上限/);
    const controller=new AbortController();controller.abort();await assert.rejects(readTargetAsset(base+'/binary',{...options,signal:controller.signal}));
  }finally{server.closeAllConnections();other.closeAllConnections();await Promise.all([new Promise<void>(done=>server.close(()=>done())),new Promise<void>(done=>other.close(()=>done()))]);}
});
