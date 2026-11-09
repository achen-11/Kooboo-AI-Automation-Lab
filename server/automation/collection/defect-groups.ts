import type { CollectionTargetCheck, CollectionTargetDefectGroup, CollectionTargetReport, CollectionTemplateCoverage } from '../../../shared/collection-target.js';

const navigationText=/^(?:\d{1,4}|[«»‹›<>←→]|\.{3}|…|上一页|下一页|首页|尾页|末页|\[\s*返\s*回\s*\]|返\s*回|more\s*[→>]?|查看更多|更多)$/i;
const norm=(value:string)=>value.replace(/\s+/g,' ').trim();

/** Same-shaped legacy paths share one rendering template; digits never identify a template. */
export function collectionPageTemplate(path:string):string {
  try{path=new URL(path,'http://template.invalid').pathname;}catch{}
  return path.replace(/\d+/g,'{n}')||'/';
}
function linkPattern(value:string,sourceOrigin?:string):string {
  try{const parsed=new URL(value,sourceOrigin||'http://template.invalid'),pattern=parsed.pathname.replace(/\d+/g,'{n}');return sourceOrigin&&parsed.origin===new URL(sourceOrigin).origin?pattern:parsed.host+pattern;}
  catch{return value.replace(/\d+/g,'{n}');}
}

interface PageDefects { status:CollectionTargetCheck['status']; missingText?:readonly string[]; missingLinks?:readonly string[]; titleMismatch?:boolean; httpStatus?:number; evidence?:readonly string[] }
interface Bucket { template:string; kind:CollectionTargetDefectGroup['kind']; key:string; paths:Set<string>; examples:Set<string>; evidence:Set<string> }

/** Groups complete per-page differences before any display truncation. Every failing page joins at least one group. */
export class CollectionDefectGroups {
  private readonly buckets=new Map<string,Bucket>();
  private readonly coverage=new Map<string,CollectionTemplateCoverage>();
  constructor(private readonly sourceOrigin?:string){}
  addPage(path:string,defects:PageDefects){
    const template=collectionPageTemplate(path),row=this.coverage.get(template)||{template,pages:0,verified:0,missing:0,unverified:0};
    row.pages++;row[defects.status]++;this.coverage.set(template,row);
    if(defects.status!=='missing')return;
    const add=(kind:Bucket['kind'],key:string,example?:string)=>{
      const id=JSON.stringify([template,kind,key]),bucket=this.buckets.get(id)||{template,kind,key,paths:new Set(),examples:new Set(),evidence:new Set()};
      bucket.paths.add(path);if(example&&bucket.examples.size<3)bucket.examples.add(example.slice(0,200));
      for(const name of defects.evidence||[])if(bucket.evidence.size<3)bucket.evidence.add(name);
      this.buckets.set(id,bucket);
    };
    let grouped=false;
    if(defects.httpStatus&&(defects.httpStatus<200||defects.httpStatus>=300)){add('http','HTTP '+defects.httpStatus);grouped=true;}
    if(defects.titleMismatch){add('title','页面 title 与来源不同');grouped=true;}
    for(const text of new Set((defects.missingText||[]).map(norm).filter(Boolean))){add(navigationText.test(text)?'navigation':'text',text.slice(0,200),text);grouped=true;}
    for(const link of new Set(defects.missingLinks||[])){add('link',linkPattern(link,this.sourceOrigin),link);grouped=true;}
    if(!grouped)add('text','目标正文、标题或链接与来源不一致（差异未细分）');
  }
  /** Sorted by affected pages; single-page fragments merge per template so unique body gaps stay countable. */
  result(limit=60):{defectGroups:CollectionTargetDefectGroup[];templateCoverage:CollectionTemplateCoverage[]} {
    const shared:CollectionTargetDefectGroup[]=[],singles=new Map<string,Bucket&{fragments:number}>();
    for(const bucket of this.buckets.values()){
      if(bucket.paths.size>1||bucket.kind==='http'||bucket.kind==='title'){shared.push(this.group(bucket));continue;}
      const id=JSON.stringify([bucket.template,bucket.kind]),merged=singles.get(id)||{template:bucket.template,kind:bucket.kind,key:'',paths:new Set<string>(),examples:new Set<string>(),evidence:new Set<string>(),fragments:0};
      merged.fragments++;for(const path of bucket.paths)merged.paths.add(path);
      for(const example of bucket.examples)if(merged.examples.size<3)merged.examples.add(example);
      for(const name of bucket.evidence)if(merged.evidence.size<3)merged.evidence.add(name);
      singles.set(id,merged);
    }
    for(const merged of singles.values())shared.push({...this.group({...merged,key:merged.kind==='link'?'各页独有链接':'各页独有片段'}),uniqueFragments:merged.fragments});
    const defectGroups=shared.sort((a,b)=>b.pages-a.pages||a.template.localeCompare(b.template)||a.key.localeCompare(b.key)).slice(0,limit);
    const templateCoverage=[...this.coverage.values()].sort((a,b)=>b.missing-a.missing||b.pages-a.pages||a.template.localeCompare(b.template));
    return {defectGroups,templateCoverage};
  }
  private group(bucket:Bucket):CollectionTargetDefectGroup {
    return {template:bucket.template,kind:bucket.kind,key:bucket.key,pages:bucket.paths.size,templatePages:this.coverage.get(bucket.template)?.pages||bucket.paths.size,samplePaths:[...bucket.paths].slice(0,5),examples:[...bucket.examples],evidence:[...bucket.evidence]};
  }
}

const kindLabels:Record<CollectionTargetDefectGroup['kind'],string>={text:'正文',link:'链接',navigation:'导航/分页',title:'标题',http:'响应'};
/** Titles stay stable across rounds; changing counts live in the detail. */
export function collectionDefectGroupIssue(group:CollectionTargetDefectGroup){
  return {severity:'major' as const,title:`B段宿主核验：模板 ${group.template} ${kindLabels[group.kind]}差异「${group.key}」`.slice(0,240),
    detail:(`影响 ${group.pages}/${group.templatePages} 个同模板来源路径${group.uniqueFragments?`，共 ${group.uniqueFragments} 处各页独有内容`:''}；示例路径：${group.samplePaths.join('、')}`+(group.examples.length?`；缺失示例：${group.examples.join(' | ')}`:'')).slice(0,3000),
    evidence:group.evidence};
}

/** Legacy reports kept only eight fragments per page; their groups are labelled approximate. */
export function collectionDefectGroups(report:CollectionTargetReport,limit=60):{defectGroups:CollectionTargetDefectGroup[];templateCoverage:CollectionTemplateCoverage[];approximate:boolean} {
  if(report.defectGroups&&report.templateCoverage)return {defectGroups:report.defectGroups.slice(0,limit),templateCoverage:report.templateCoverage,approximate:false};
  const groups=new CollectionDefectGroups();
  for(const check of report.checks){
    if(check.kind!=='page'||!check.id.startsWith('page:'))continue;
    groups.addPage(check.sourcePath||check.id.slice(5),{status:check.status,missingText:check.differences?.missingTextFragments,missingLinks:check.differences?.missingLinkUrls,httpStatus:Number(/HTTP (\d{3})/.exec(check.reason)?.[1])||undefined,evidence:check.evidence});
  }
  return {...groups.result(limit),approximate:true};
}
