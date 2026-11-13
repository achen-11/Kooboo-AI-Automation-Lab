import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { TemplateLayoutSnapshot, TemplateViewport, TemplateView } from '../../shared/template-workflow.js';

/** Serialized into the page: no model-generated JavaScript is evaluated. */
export async function layoutInventory() {
  const gaps:string[]=[];
  const hostDigest=(globalThis as unknown as {__labTemplateSha256:(value:string,encoding:'utf8'|'base64')=>Promise<string>}).__labTemplateSha256;
  const digest=async(value:string)=>crypto.subtle?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join(''):hostDigest(value,'utf8');
  const digestBytes=async(bytes:ArrayBuffer)=>{if(crypto.subtle)return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');let binary='';const values=new Uint8Array(bytes);for(let i=0;i<values.length;i+=8192)binary+=String.fromCharCode(...values.subarray(i,i+8192));return hostDigest(btoa(binary),'base64');};
  const selector=(el:Element):string=>{if(el===document.body)return 'body';if(el.id&&document.querySelectorAll('#'+CSS.escape(el.id)).length===1)return '#'+CSS.escape(el.id);const parts:string[]=[];for(let node:Element|null=el;node&&node!==document.body;node=node.parentElement){const siblings=Array.from(node.parentElement?.children||[]);parts.unshift(node.tagName.toLowerCase()+':nth-child('+(siblings.indexOf(node)+1)+')');}return 'body>'+parts.join('>');};
  const candidates=Array.from(document.body.querySelectorAll('*'));
  if(candidates.length>3000)gaps.push('DOM 超过 3000 元素，测量不完整');
  const elements=[];
  for(const el of [document.body,...candidates.slice(0,3000)]){
    const style=getComputedStyle(el),r=el.getBoundingClientRect();
    if(!r.width||!r.height||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)continue;
    let hidden=false;for(let parent=el.parentElement;parent;parent=parent.parentElement){const ancestor=getComputedStyle(parent);if(ancestor.display==='none'||ancestor.visibility==='hidden'||ancestor.visibility==='collapse'||Number(ancestor.opacity)===0){hidden=true;break;}}if(hidden)continue;
    if(el.shadowRoot||['IFRAME','CANVAS','VIDEO'].includes(el.tagName))gaps.push('存在独立渲染或动态表面');
    if(style.animationName!=='none')gaps.push('存在运行中的动画');
    const rect={x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};
    const range=document.createRange();range.selectNodeContents(el);
    const textRects=Array.from(range.getClientRects()),lines=new Set(textRects.filter(v=>v.width&&v.height).map(v=>Math.round(v.top*2)/2));
    const ancestors=[];for(let parent=el.parentElement;parent;parent=parent.parentElement){const s=getComputedStyle(parent);ancestors.push([selector(parent),s.cssText,...Array.from(s).map(k=>s.getPropertyValue(k))]);}
    const html=el.outerHTML;if(html.length>1000000)gaps.push('区块内容超过签名上限');
    elements.push({selector:selector(el),tag:el.tagName.toLowerCase(),text:(el.textContent||'').trim().slice(0,2000),rect,visible:true,lines:el.children.length?null:lines.size,display:style.display,position:style.position,overflowX:style.overflowX,paddingLeft:parseFloat(style.paddingLeft)||0,paddingRight:parseFloat(style.paddingRight)||0,parentSelector:el.parentElement?selector(el.parentElement):null,signature:await digest(JSON.stringify([html.slice(0,1000000),rect,Array.from(style).map(k=>[k,style.getPropertyValue(k)]),ancestors]))});
  }
  const resources=new Set([...Array.from(document.querySelectorAll('link[rel="stylesheet"],script[src],img')).map(el=>(el as HTMLImageElement).currentSrc||(el as HTMLScriptElement).src||(el as HTMLLinkElement).href),...performance.getEntriesByType('resource').map(entry=>entry.name)].filter(Boolean));
  const dependencies=[...Array.from(document.querySelectorAll('style')).map(el=>el.textContent||'')];
  if(resources.size>60)gaps.push('资源超过 60 个，无法证明全局依赖未变');
  for(const url of [...resources].slice(0,60))try{const response=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error();const bytes=await response.arrayBuffer();if(bytes.byteLength>2000000)throw new Error();dependencies.push(url+':'+await digestBytes(bytes));}catch{gaps.push('资源内容无法独立核验');}
  const links=[...new Set(Array.from(document.querySelectorAll('a[href]')).map(el=>(el as HTMLAnchorElement).href).filter(href=>{try{const url=new URL(href);return url.origin===location.origin&&/^https?:$/.test(url.protocol)&&!url.username&&!url.password;}catch{return false;}}).map(href=>{const url=new URL(href);url.hash='';return url.href;}))];
  return {url:location.href,width:innerWidth,height:innerHeight,elements,links,truncated:candidates.length>3000,dependencyHash:gaps.length?null:await digest(JSON.stringify(dependencies.sort())),dependencyGaps:[...new Set(gaps)]};
}
const digestPages=new WeakSet<Page>();
export async function inspectTemplateLayout(page:Page,viewport:TemplateViewport):Promise<TemplateLayoutSnapshot>{
  // HTTP preview domains lack WebCrypto; this fixed hash bridge grants no file/network access.
  if(!digestPages.has(page)){await page.exposeFunction('__labTemplateSha256',(value:string,encoding:'utf8'|'base64')=>{if(typeof value!=='string'||value.length>8*1024*1024||!['utf8','base64'].includes(encoding))throw new Error('布局签名输入超限');return createHash('sha256').update(encoding==='base64'?Buffer.from(value,'base64'):value).digest('hex');});digestPages.add(page);}
  return {...await page.evaluate(layoutInventory),viewport};
}
export const layoutHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Unknown/global dependencies expand capture. Only proven unchanged static views inherit. */
export function planTemplateRegions(views:TemplateView[],viewport:TemplateViewport,current:TemplateLayoutSnapshot,previous?:TemplateLayoutSnapshot,mapping:Record<string,string>={},forceViews:string[]=[]) {
  const all={mode:'page' as const,selectors:[] as string[],inherited:[] as string[],reason:'首次采集或依赖无法证明未变，检查整页'};
  if(!previous||!current.dependencyHash||current.dependencyHash!==previous.dependencyHash||current.truncated||previous.truncated||current.dependencyGaps.length||previous.dependencyGaps.length)return all;
  const changed=new Set<number>();
  for(const id of forceViews){const index=views.findIndex(view=>view.id===id);if(index>=0){changed.add(index);if(index)changed.add(index-1);if(index+1<views.length)changed.add(index+1);}}
  for(const [index,view] of views.entries()){
    const selector=mapping[view.id],now=current.elements.filter(el=>el.selector===selector),old=previous.elements.filter(el=>el.selector===selector);
    if(!selector||now.length!==1||old.length!==1)return {...all,reason:'目标区块映射不完整，扩大整页采集'};
    if(now[0].signature!==old[0].signature){changed.add(index);if(index)changed.add(index-1);if(index+1<views.length)changed.add(index+1);}
  }
  if(!changed.size)return {mode:'inherited' as const,selectors:[],inherited:views.map(v=>v.id),reason:'当前布局、区块内容及全部可核验资源与上一修订一致；交互仍需本轮操作'};
  if(changed.size===views.length)return {...all,reason:'变化影响全部区块，检查整页'};
  return {mode:'regions' as const,selectors:views.filter((_,i)=>changed.has(i)).map(v=>mapping[v.id]),inherited:views.filter((_,i)=>!changed.has(i)).map(v=>v.id),reason:'当前测量确认局部变化，重采变化区块及相邻区块'};
}
