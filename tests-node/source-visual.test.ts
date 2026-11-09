import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { MaterialFile } from '../shared/automation.js';
import type { CollectionRun } from '../shared/collection.js';
import type { CollectionStore } from '../server/automation/collection/store.js';
import { captureSourceVisualBaseline, htmlSkeleton, sourceTemplateClusters, sourceVisualEvaluationContract, sourceVisualFoldImages, sourceVisualMaterial, sourceVisualRequired, type SourceVisualIndex } from '../server/automation/collection/source-visual.js';
import { sourceVisualBaselineImages } from '../server/automation/generator.js';

const page=(body:string)=>`<html><head><style>.x{}</style><script>var a='<div>'</script></head><body>${body}</body></html>`;
const detail=(title:string,items:number)=>page(`<div class="header"><ul class="nav"><li>A</li><li>B</li></ul></div><div class="detail"><h1>${title}</h1>${'<p>text</p>'.repeat(items)}</div><div class="footer">c</div>`);
const listing=page('<div class="header"><ul class="nav"><li>A</li></ul></div><div class="list"><ul><li>1</li></ul><div class="pager">1 2</div></div><div class="footer">c</div>');

test('page skeletons ignore text, scripts and repeated siblings, and cluster pages by layout',()=>{
  assert.equal(htmlSkeleton(detail('One',1)),htmlSkeleton(detail('Another title',5)));
  assert.notEqual(htmlSkeleton(detail('One',1)),htmlSkeleton(listing));
  assert.doesNotMatch(htmlSkeleton(detail('One',1)),/script|style/);
  const pages=[
    {id:'u1',url:'https://s.test/',path:'/',rawFile:'r1',depth:0,html:listing.replace('list','home')},
    {id:'u2',url:'https://s.test/cn/content/12',path:'/cn/content/12',rawFile:'r2',depth:2,html:detail('A',2)},
    {id:'u3',url:'https://s.test/cn/content/345',path:'/cn/content/345',rawFile:'r3',depth:2,html:detail('B',7)},
    {id:'u4',url:'https://s.test/cn/category/7',path:'/cn/category/7',rawFile:'r4',depth:1,html:listing},
  ];
  const clusters=sourceTemplateClusters(pages);
  assert.equal(clusters.length,3);assert.equal(clusters[0].members.length,2);assert.equal(clusters[0].urlTemplate,'/cn/content/{n}');
  assert.deepEqual(clusters[0].members.map(member=>member.id),['u2','u3']);
});

test('only migrations without a separate reference appearance require a source visual baseline',()=>{
  assert.equal(sourceVisualRequired({scenario:'migration',contentUrl:'https://a.test/',referenceUrl:''}),true);
  assert.equal(sourceVisualRequired({scenario:'migration',contentUrl:'https://a.test/',referenceUrl:'https://a.test/other'}),true);
  assert.equal(sourceVisualRequired({scenario:'migration',contentUrl:'https://a.test/',referenceUrl:'https://design.test/'}),false);
  assert.equal(sourceVisualRequired({scenario:'upgrade',contentUrl:'https://a.test/',referenceUrl:''}),false);
});

function workspace(){
  const root=mkdtempSync(resolve(tmpdir(),'source-visual-'));
  const write=(path:string,value:string)=>{const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,value);};
  const collections={workspace:()=>root,read:(_run:CollectionRun,path:string)=>readFileSync(resolve(root,path)),json:(_run:CollectionRun,path:string)=>JSON.parse(readFileSync(resolve(root,path),'utf8'))} as unknown as CollectionStore;
  const run={id:randomUUID(),inputVersionId:randomUUID(),sourceUrl:'https://s.test/',status:'collecting'} as CollectionRun;
  return {root,write,collections,run};
}

test('baseline capture exports template HTML and CSS originals, and records browser failures instead of inventing screens',async()=>{
  const w=workspace();try{
    w.write('.work/raw/u1.html',listing);w.write('.work/raw/u2.html',detail('A',1));w.write('.work/raw/u3.html',detail('B',3));
    w.write('.work/state.json',JSON.stringify({urls:{
      u1:{id:'u1',url:'https://s.test/',path:'/',action:'keep',rawFile:'.work/raw/u1.html',pageSlug:'01-index'},
      u2:{id:'u2',url:'https://s.test/n/1',path:'/n/1',action:'keep',rawFile:'.work/raw/u2.html',pageSlug:'02-n-1'},
      u3:{id:'u3',url:'https://s.test/n/2',path:'/n/2',action:'keep',rawFile:'.work/raw/u3.html',pageSlug:'03-n-2'},
      u4:{id:'u4',url:'https://s.test/gone',path:'/gone',action:'skip',rawFile:'.work/raw/u4.html'},
    },stylesheets:[{url:'https://s.test/res/site.css',status:'read'},{url:'https://s.test/res/missing.css',status:'read'},{url:'https://s.test/res/failed.css',status:'failed'}]}));
    w.write('site/visual/stale.txt','old capture');
    const requested:string[]=[];
    const request=(async(url:string)=>{requested.push(url);return url.endsWith('site.css')?new Response('body{color:#c00}',{status:200}):new Response('<html>404</html>',{status:404});}) as unknown as typeof fetch;
    const index=await captureSourceVisualBaseline(w.collections,w.run,{signal:AbortSignal.timeout(5000),request,launch:async()=>{throw new Error('browser unavailable');}});
    assert.deepEqual(requested,['https://s.test/res/site.css','https://s.test/res/missing.css']);
    assert.equal(index.templates.length,2);assert.equal(index.templates[0].urlTemplate,'/n/{n}');assert.equal(index.templates[0].pages,2);
    for(const template of index.templates){assert.ok(template.html.length>0);for(const path of template.html)assert.ok(existsSync(resolve(w.root,path)));assert.deepEqual(template.screens,[]);}
    assert.equal(readFileSync(resolve(w.root,index.styles[0].path!),'utf8'),'body{color:#c00}');assert.equal(index.styles[0].sha256,createHash('sha256').update('body{color:#c00}').digest('hex'));
    assert.match(index.styles[1].error!,/404/);
    assert.ok(index.limitations.some(line=>/browser unavailable/.test(line)));assert.ok(index.limitations.some(line=>/1 个样式表/.test(line)));
    assert.equal(existsSync(resolve(w.root,'site/visual/stale.txt')),false);
    assert.deepEqual(JSON.parse(readFileSync(resolve(w.root,'site/visual/index.json'),'utf8')),index);
    await assert.rejects(captureSourceVisualBaseline(w.collections,{...w.run,status:'ready'},{signal:AbortSignal.timeout(1000)}),/已冻结/);
  }finally{rmSync(w.root,{recursive:true,force:true});}
});

// Explicit opt-in: the normal regression suite never launches a browser.
test('real Chromium captures full-page and first-screen source screens per template from a local fixture',{skip:process.env.EVALUATOR_BROWSER_TEST!=='1',timeout:120000},async()=>{
  const server=createServer((request,response)=>{
    if(request.url==='/res/site.css'){response.writeHead(200,{'content-type':'text/css'});return response.end('.detail{background:#eef}');}
    response.writeHead(200,{'content-type':'text/html'});response.end(request.url==='/'?listing.replace('</body>','<div style="height:2400px"></div></body>'):detail('Fixture',3));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const w=workspace();try{
    const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;w.run.sourceUrl=origin+'/';
    w.write('.work/raw/u1.html',listing);w.write('.work/raw/u2.html',detail('A',1));
    w.write('.work/state.json',JSON.stringify({urls:{u1:{id:'u1',url:origin+'/',path:'/',action:'keep',rawFile:'.work/raw/u1.html'},u2:{id:'u2',url:origin+'/n/1',path:'/n/1',action:'keep',rawFile:'.work/raw/u2.html'}},stylesheets:[{url:origin+'/res/site.css',status:'read'}]}));
    const index=await captureSourceVisualBaseline(w.collections,w.run,{signal:AbortSignal.timeout(110000)});
    assert.deepEqual(index.limitations,[]);assert.equal(index.styles[0].size,24);
    const home=index.templates.find(template=>template.samplePaths.includes('/'))!;
    assert.deepEqual(home.screens.map(screen=>screen.viewport),['desktop','mobile']);
    const desktop=home.screens[0];assert.equal(desktop.settled,true);assert.ok(desktop.height>2400);assert.ok(desktop.foldPath);
    for(const path of [desktop.path,desktop.foldPath!,home.screens[1].path])assert.equal(readFileSync(resolve(w.root,path)).subarray(1,4).toString(),'PNG');
  }finally{server.close();rmSync(w.root,{recursive:true,force:true});}
});

test('generation attaches home-first source first screens within the image budget, and evaluation names the baseline',()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'source-visual-materials-'));try{
    mkdirSync(resolve(directory,'materials'));
    const files:MaterialFile[]=[];
    const add=(name:string,bytes:Buffer)=>{const file={id:randomUUID(),name,type:name.endsWith('.png')?'image/png':'application/json',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};writeFileSync(resolve(directory,'materials',file.id),bytes);files.push(file);return file;};
    const screen=(id:string,settled=true)=>({viewport:'desktop' as const,path:`site/visual/screens/${id}-desktop.png`,foldPath:`site/visual/screens/${id}-desktop-fold.png`,url:'https://s.test/'+id,width:1440,height:3000,clipped:false,settled,pendingImages:settled?0:2,blankImageRatio:0});
    const index:SourceVisualIndex={version:1,collectionId:'c',inputVersionId:'v',sourceUrl:'https://s.test/',capturedAt:1,styles:[],limitations:[],templates:[
      {id:'detail',urlTemplate:'/n/{n}',pages:40,samplePaths:['/n/1'],html:[],screens:[screen('detail',false)]},
      {id:'big',urlTemplate:'/big/{n}',pages:30,samplePaths:['/big/1'],html:[],screens:[screen('big')]},
      {id:'home',urlTemplate:'/',pages:1,samplePaths:['/'],html:[],screens:[screen('home'),{...screen('home'),viewport:'mobile',foldPath:undefined}]},
    ]};
    assert.deepEqual(sourceVisualFoldImages(index).map(shot=>shot.urlTemplate),['/','/n/{n}','/big/{n}']);
    add(sourceVisualMaterial,Buffer.from(JSON.stringify(index)));
    add('collection/site/visual/screens/home-desktop-fold.png',Buffer.alloc(300,1));add('collection/site/visual/screens/detail-desktop-fold.png',Buffer.alloc(300,2));add('collection/site/visual/screens/big-desktop-fold.png',Buffer.alloc(900,3));
    const result=sourceVisualBaselineImages({files},directory,{each:1000,total:700,count:6})!;
    assert.equal(result.images.length,2);assert.match(result.images[0].uri,/^data:image\/png;base64,/);
    assert.match(result.label,/1\. \/（https:\/\/s\.test\/home）；2\. \/n\/\{n\}（https:\/\/s\.test\/detail）：截图时仍有图片未加载/);
    assert.equal(sourceVisualBaselineImages({files:files.slice(1)},directory),undefined);
    assert.match(sourceVisualEvaluationContract(files),/权威依据/);assert.equal(sourceVisualEvaluationContract(files.slice(1)),'');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
