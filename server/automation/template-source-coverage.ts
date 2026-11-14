import type { Requirement } from '../../shared/completeness.js';

export interface TemplateExcludedPath {path:string;reason:string}

/** The model and validator use this exact candidate list, without a hidden tail. */
export function templateCandidateLinks(reference:string,links:readonly string[]){
  const origin=new URL(reference).origin,result=new Set<string>();
  for(const link of links){
    let url:URL;try{url=new URL(link,reference);}catch{continue;}
    if(url.origin!==origin||url.username||url.password||!/^https?:$/.test(url.protocol))continue;
    url.hash='';
    if(/\.(?:png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|mp[34]|woff2?|ttf|css|js)$/i.test(url.pathname))continue;
    result.add(url.href);
  }
  return [...result];
}

/** Sampling reduces repeated visual work; exclusions classify non-business pages explicitly. */
export function templateSourceCoverage(input:{scope:'homepage'|'site';reference:string;pages:Set<string>;links:string[];items:Requirement[];excludedPaths?:TemplateExcludedPath[]}){
  const origin=new URL(input.reference).origin;
  const normalize=(path:string)=>{const url=new URL(path,input.reference);if(url.origin!==origin||url.username||url.password||!/^https?:$/.test(url.protocol))throw new Error('交付页面越出参考站范围：'+path);url.hash='';return url.href;};
  const declared=new Set<string>(),excluded=new Set<string>(),missing=new Set<string>();
  for(const item of input.excludedPaths||[]){if(!item.reason.trim())throw new Error('排除页面必须说明原因：'+item.path);excluded.add(normalize(item.path));}
  for(const item of input.items.filter(item=>item.kind==='page'||item.kind==='template')){
    for(const path of [...item.paths,...item.samples||[]])declared.add(normalize(path));
    const samples=item.kind==='template'&&item.samples?.length?item.samples:item.paths;
    for(const path of samples)if(!input.pages.has(normalize(path)))missing.add('尚未完成双端基线：'+path);
    if(item.kind==='template'&&!samples.length)missing.add('动态模板缺少已分析样本：'+item.id);
  }
  for(const path of input.pages)if(!declared.has(path)&&!excluded.has(path))missing.add('已分析页面未列入交付清单或显式排除：'+path);
  if(input.scope==='site')for(const url of templateCandidateLinks(input.reference,input.links)){
    if(!declared.has(url)&&!excluded.has(url)){const path=new URL(url);missing.add('已发现内页未归类：'+path.pathname+path.search);}
  }
  return [...missing];
}
