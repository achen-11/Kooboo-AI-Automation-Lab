import type { CollectionRun } from '../../../shared/collection.js';

const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
function httpUrl(value:unknown){
  if(typeof value!=='string'||!/^https?:\/\//i.test(value)||value.trim()!==value||/\s/.test(value))return;
  try{const parsed=new URL(value);if(['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)return parsed;}catch{}
}

/** Plan only a larger soft page window over already discovered source records. */
export function planCollectionPageWindow(run:CollectionRun,state:unknown):CollectionRun['next']{
  if(run.next)return;
  const saved=object(state),source=httpUrl(run.sourceUrl),current=run.options.maxPages;
  if(!saved||saved.source!==run.sourceUrl||!source||!Number.isSafeInteger(current)||current<1||current>=10000)return;
  const discovered=object(saved.urls);if(!discovered)return;
  const records=Object.values(discovered),entries=records.map(object);
  if(!records.length||entries.some(record=>!record))return;
  const limited=entries.filter(record=>record!.action==='over-limit'&&record!.reason==='over-limit') as Record<string,unknown>[];
  if(!limited.length)return;
  const sameSource=(value:unknown)=>{const candidate=httpUrl(value);return candidate?.host===source.host?candidate:undefined;};
  // An invalid budget-limited record makes automatic expansion unsafe: fetch also resumes
  // records outside the seed list, so silently filtering one would not establish safety.
  if(limited.some(record=>typeof record.id!=='string'||!record.id||typeof record.path!=='string'||!record.path.startsWith('/')||!sameSource(record.url)))return;
  const urls=[...new Set(limited.map(record=>record.url as string))];
  const known=new Map<string,string>();for(const record of entries){const parsed=sameSource(record!.url);if(parsed)known.set(parsed.href,record!.url as string);}
  const retainedSeeds:string[]=[];
  for(const seed of run.options.seedUrls||[]){const parsed=sameSource(seed),actual=parsed&&known.get(parsed.href);if(!actual)return;retainedSeeds.push(actual);}
  const previous=[...new Set(retainedSeeds)];if(previous.length>1000)return;
  const seedUrls=[...new Set([...previous,...urls])].slice(0,1000),maxPages=Math.min(10000,Math.max(current+300,records.length));
  return {
    description:`已保存发现状态含 ${urls.length} 个仅因页数软窗口 over-limit 待取的来源对象；将页数窗口从 ${current} 扩至 ${maxPages}，继续原发现集合。`,
    operation:'fetch',evidence:['.work/state.json'],affectedObjects:urls.slice(0,10000),options:{maxPages,seedUrls},
    acceptance:'取回已真实发现且仅受页数软窗口限制的对象，保留原 URL 与完整查询参数。随后重新执行提取、素材、数据、渲染及验证并进行 A 段独立复核；剩余超限、深度限制或失败仍作为缺口保留，不能据此宣称全源站闭合。',
  };
}
