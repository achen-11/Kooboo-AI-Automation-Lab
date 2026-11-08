import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(root,'../../package.json'));
const {chromium}=require('playwright');
const mermaidRoot=resolve(process.argv[2]||'/tmp/kooboo-diagram-archive-runtime/node_modules/mermaid');
const dist=resolve(mermaidRoot,'dist');
const beautifulRoot=resolve(process.argv[3]||'/tmp/kooboo-diagram-archive-runtime/node_modules/beautiful-mermaid');
const beautifulPackage=JSON.parse(await readFile(resolve(beautifulRoot,'package.json'),'utf8'));
if(beautifulPackage.version!=='1.1.3')throw Error('This rendering profile requires beautiful-mermaid 1.1.3.');
// This pinned adapter adjusts font metrics, padding, and separate edge routing,
// which 1.1.3 does not fully expose as public options. Never mutate the installed package.
const temp=await mkdtemp(resolve(tmpdir(),'kooboo-diagram-style-'));
const beautifulRequire=createRequire(resolve(beautifulRoot,'package.json'));
let renderer=await readFile(resolve(beautifulRoot,'dist/index.js'),'utf8');
for(const name of ['entities','elkjs/lib/elk.bundled.js']){
  const original='from '+JSON.stringify(name);
  if(!renderer.includes(original))throw Error('Unexpected renderer imports: '+name);
  renderer=renderer.replace(original,'from '+JSON.stringify(pathToFileURL(beautifulRequire.resolve(name)).href));
}
renderer+='\nFONT_SIZES.nodeLabel=16; FONT_SIZES.edgeLabel=13; FONT_SIZES.groupHeader=14; NODE_PADDING.horizontal=32; NODE_PADDING.vertical=22; DEFAULTS2.mergeEdges=false;\n';
await writeFile(resolve(temp,'renderer.mjs'),renderer);
const {renderMermaidSVG,parseMermaid}=await import(pathToFileURL(resolve(temp,'renderer.mjs')).href);
const profile={bg:'#181818',fg:'#83c5ff',surface:'#10283f',border:'#2d4557',line:'#93989d',accent:'#93989d',muted:'#b4bec8',font:'sans-serif',padding:32,nodeSpacing:42,layerSpacing:64,mergeEdges:false};
const manifest=JSON.parse(await readFile(resolve(root,'diagrams.json'),'utf8'));
const mime={'.mjs':'text/javascript','.js':'text/javascript','.json':'application/json'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;background:#181818;font-family:"PingFang SC","Hiragino Sans GB",sans-serif}#output{display:inline-block;padding:24px}svg{display:block}</style><div id="output"></div><script type="module">import mermaid from "/vendor/mermaid.esm.min.mjs";window.diagramMermaid=mermaid;</script></html>');return;}
    if(!pathname.startsWith('/vendor/'))throw Error('Not found');
    const path=resolve(dist,pathname.slice(8));
    if(!path.startsWith(dist+sep))throw Error('Not found');
    const bytes=await readFile(path);res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1800,height:1100},deviceScaleFactor:1.5});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>!!window.diagramMermaid);
  await page.evaluate(()=>window.diagramMermaid.initialize({startOnLoad:false,securityLevel:'strict'}));
  await mkdir(resolve(root,'svg'),{recursive:true});await mkdir(resolve(root,'png'),{recursive:true});
  const results=[];
  for(const d of manifest.diagrams.filter(d=>!process.env.DIAGRAM_ONLY||d.file===process.env.DIAGRAM_ONLY)){
    const graph=parseMermaid(d.source);
    const rawSvg=renderMermaidSVG(d.source,profile);
    const result=await page.evaluate(async({source,number,rawSvg,expectedNodes,expectedEdges})=>{
      // Compare independent parsers before replacing the archived images.
      const original=await window.diagramMermaid.mermaidAPI.getDiagramFromText(source);
      const rawVertices=original.db.getVertices();
      const vertices=rawVertices instanceof Map?[...rawVertices.values()]:Object.values(rawVertices);
      const edges=original.db.getEdges();
      const normalize=s=>s.replace(/<br\s*\/?>/gi,'\n').replace(/\\n/g,'\n').trim();
      for(const node of expectedNodes){
        const found=vertices.find(v=>v.id===node.id);
        if(!found||normalize(found.text)!==normalize(node.label))throw Error('Node differs: '+node.id);
      }
      const originalNodes=vertices.filter(v=>v.type!=='group');
      if(originalNodes.length!==expectedNodes.length)throw Error('Node count differs');
      const signature=e=>JSON.stringify([e.source??e.start,e.target??e.end,normalize(e.label??e.text??'')]);
      if(JSON.stringify(edges.map(signature).sort())!==JSON.stringify(expectedEdges.map(signature).sort()))throw Error('Edges differ');
      const output=document.getElementById('output');
      output.innerHTML=rawSvg;
      const element=output.querySelector('svg');
      // Use installed system fonts only; the exported image stays fully offline.
      element.querySelector('style').textContent=element.querySelector('style').textContent.replace(/@import[^;]+;/g,'')+'\ntext{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}';
      for(const rect of element.querySelectorAll('.node[data-shape="rectangle"] > rect,.node[data-shape="rounded"] > rect')){
        rect.setAttribute('rx','17');rect.setAttribute('ry','17');rect.setAttribute('stroke-width','1');
      }
      // ELK supplies orthogonal routes; round each bend without moving endpoints.
      for(const line of element.querySelectorAll('polyline.edge')){
        const points=Array.from(line.points).map(p=>({x:p.x,y:p.y}));
        let path='M '+points[0].x+' '+points[0].y;
        for(let i=1;i<points.length-1;i++){
          const [a,b,c]=[points[i-1],points[i],points[i+1]];
          const incoming=Math.hypot(b.x-a.x,b.y-a.y),outgoing=Math.hypot(c.x-b.x,c.y-b.y);
          if(!incoming||!outgoing)continue;
          const r=Math.min(8,incoming/2,outgoing/2);
          const before={x:b.x+(a.x-b.x)*r/incoming,y:b.y+(a.y-b.y)*r/incoming};
          const after={x:b.x+(c.x-b.x)*r/outgoing,y:b.y+(c.y-b.y)*r/outgoing};
          path+=' L '+before.x+' '+before.y+' Q '+b.x+' '+b.y+' '+after.x+' '+after.y;
        }
        path+=' L '+points.at(-1).x+' '+points.at(-1).y;
        const curve=document.createElementNS('http://www.w3.org/2000/svg','path');
        for(const attr of line.attributes)if(attr.name!=='points')curve.setAttribute(attr.name,attr.value);
        curve.setAttribute('d',path);curve.setAttribute('stroke-linecap','round');curve.setAttribute('stroke-linejoin','round');line.replaceWith(curve);
      }
      for(const marker of element.querySelectorAll('marker')){
        const polygon=marker.querySelector('polygon');if(!polygon)continue;
        const arrow=document.createElementNS('http://www.w3.org/2000/svg','polyline');
        arrow.setAttribute('points',polygon.getAttribute('points'));
        arrow.setAttribute('fill','none');arrow.setAttribute('stroke',polygon.getAttribute('stroke'));
        arrow.setAttribute('stroke-width','0.9');arrow.setAttribute('stroke-linecap','round');arrow.setAttribute('stroke-linejoin','round');polygon.replaceWith(arrow);
      }
      const box=element.viewBox.baseVal;
      const width=Math.ceil(box.width),height=Math.ceil(box.height);
      element.setAttribute('width',String(width));element.setAttribute('height',String(height));
      element.style.maxWidth='none';element.style.background='#181818';
      const background=document.createElementNS('http://www.w3.org/2000/svg','rect');
      background.setAttribute('width',String(width));background.setAttribute('height',String(height));background.setAttribute('fill','#181818');
      element.insertBefore(background,element.querySelector('defs')?.nextSibling||element.firstChild);
      const nodes=element.querySelectorAll('.node').length,edgeCount=element.querySelectorAll('.edge').length;
      if(nodes!==expectedNodes.length||edgeCount!==expectedEdges.length)throw Error('Rendered graph incomplete');
      await document.fonts.ready;
      // Check actual browser font measurements, rather than trusting estimates.
      for(const node of element.querySelectorAll('.node')){
        const shape=node.querySelector('rect');if(!shape)continue;
        const rect=shape.getBBox();
        for(const text of node.querySelectorAll('text')){
          const bounds=text.getBBox();
          if(bounds.x<rect.x-1||bounds.x+bounds.width>rect.x+rect.width+1)throw Error('Clipped label: '+node.dataset.id);
        }
      }
      return {svg:new XMLSerializer().serializeToString(element),width,height,nodes,edges:edgeCount};
    },{source:d.source,number:d.number,rawSvg,expectedNodes:[...graph.nodes.values()],expectedEdges:graph.edges});
    await page.evaluate(()=>document.fonts.ready);
    await writeFile(resolve(root,'svg',(d.filename||d.file)+'.svg'),result.svg+'\n');
    await page.locator('#output').screenshot({path:resolve(root,'png',(d.filename||d.file)+'.png'),timeout:30000});
    results.push({number:d.number,file:d.file,title:d.title,width:result.width,height:result.height,nodes:result.nodes,edges:result.edges,svgBytes:(await stat(resolve(root,'svg',(d.filename||d.file)+'.svg'))).size,pngBytes:(await stat(resolve(root,'png',(d.filename||d.file)+'.png'))).size});
    console.log(JSON.stringify({number:d.number,title:d.title,width:result.width,height:result.height}));
  }
  await writeFile(resolve(root,'render-results.json'),JSON.stringify({renderer:'beautiful-mermaid',version:beautifulPackage.version,layout:'ELK orthogonal, rounded bends',theme:'Codex screenshot reference',profile:{...profile,nodeRadius:17,bendRadius:8,fontSize:16,nodePadding:{horizontal:32,vertical:22}},validation:'Independent Mermaid parser: node labels and edge endpoints/labels matched; rendered node/edge counts matched; label bounds checked',diagrams:results},null,2)+'\n');
}finally{await browser?.close();await new Promise(ok=>server.close(ok));await rm(temp,{recursive:true,force:true});}
