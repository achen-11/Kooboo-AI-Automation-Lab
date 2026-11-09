import { z } from 'zod';
import type { AutomationReport, AutomationTask, CollectionReportObservation, FollowupAction } from '../../../shared/automation.js';
import type { CollectionRun } from '../../../shared/collection.js';

export const recollectionObjectiveSchema=z.object({
  description:z.string().trim().min(10).max(4000),
  affectedObjects:z.array(z.string().trim().min(2).max(2000)).min(1).max(100),
  evidence:z.array(z.string().min(1).max(100)).min(1).max(30),
  acceptance:z.string().trim().min(10).max(4000),
  operation:z.enum(['plan','discover','fetch','extract','assets','data','render','verify']),
  options:z.object({maxPages:z.number().int().min(300).max(10000).optional(),maxDepth:z.number().int().min(6).max(30).optional(),maxAssets:z.number().int().min(5000).max(50000).optional(),maxTotalBytes:z.number().int().min(2*1024**3).max(20*1024**3).optional(),delay:z.number().min(0.1).max(30).optional(),retryFailed:z.literal(true).optional(),seedUrls:z.array(z.url()).max(1000).optional()}).strict().optional(),
}).strict();

/** Only concrete reported source deficiencies justify A-stage work. Unknown global counts do not. */
export function collectionSourceGaps(report:AutomationReport|null|undefined){
  if(!report)return [];
  const sourceSubject=/(?:来源(?:资料|原件|正文|文件|数据|记录|页面|包|对象)?(?:中|内|本身)?|采集(?:资料|包|过程|结果)?)(?:缺少|缺失|遗漏|未采集|未覆盖|不完整|无法读取|未取得)|冻结(?:资料|原件|提取|全文)(?:缺失|不完整|不存在|无法|不能|缺少)|(?:source (?:package|data|originals?|pages?|files?)|collection (?:package|results?)).{0,24}(?:missing|incomplete|unavailable|not collected)/i;
  // Host B checks describe target defects unless original binding itself failed.
  const candidates=[...report.issues.filter(issue=>!/^B段宿主核验|^B段全量核验/.test(issue.title)).map(issue=>issue.title+'：'+issue.detail),...report.coverage.unverified].filter(text=>sourceSubject.test(text)&&(!/(?:总数|全站|全源站|global|total).{0,20}(?:未知|不明|unknown)/i.test(text)||/缺少|缺失|遗漏|未采集|未覆盖|missing|not collected/i.test(text)));
  const bindingGaps=report.collectionTarget?.checks.filter(check=>check.id==='binding-error'&&check.kind==='binding'&&check.status==='unverified'&&/冻结|原件|提取|全文/.test(check.reason)&&/缺|未包含|不完整|已变化|不能.{0,30}回指|无法.{0,30}(?:读取|回指)/.test(check.reason)).map(check=>check.reason)||[];
  return [...new Set([...candidates,...bindingGaps])].slice(0,40).map(text=>text.slice(0,3000));
}

export function validateRecollectionAction(task:AutomationTask,action:FollowupAction,observations:Record<string,CollectionReportObservation>){
  if(!task.autonomy||!task.collectionId||!task.collectionVersionId||task.scope!=='site'||!['migration','upgrade'].includes(task.scenario))throw new Error('只有已冻结来源的自主全站迁移/升级可安排定向补采');
  const objective=recollectionObjectiveSchema.parse(action.collectionObjective),reportId=task.optimization?.reportId;
  if(!reportId||objective.evidence.some(id=>!action.evidence.includes(id)||observations[id]?.reportId!==reportId))throw new Error('补采目标必须引用本轮 get_report 对当前独立报告的观察');
  const gaps=objective.evidence.flatMap(id=>observations[id].sourceGaps);
  for(const affected of objective.affectedObjects){
    let objectPath=affected;
    if(/^https?:\/\//i.test(affected)){const parsed=new URL(affected);if(parsed.username||parsed.password)throw new Error('补采来源对象不允许访问凭据');objectPath=parsed.pathname+parsed.search;}
    if(!(/^(?:\/[^\s]|\.work\/|data\/|site\/|assets\/)/.test(objectPath))||!gaps.some(text=>text.includes(affected)||text.includes(objectPath)))throw new Error('补采必须逐项指出报告实际缺失的具体来源 URL/路径；全源站总数未知不能单独回采：'+affected);
  }
  return objective;
}

export function validateRecollectionScope(run:CollectionRun,objective:z.infer<typeof recollectionObjectiveSchema>){
  const source=new URL(run.sourceUrl),sameHost=(value:string)=>{const candidate=new URL(value,run.sourceUrl);return !candidate.username&&!candidate.password&&['http:','https:'].includes(candidate.protocol)&&candidate.hostname.replace(/^www\./,'')===source.hostname.replace(/^www\./,'');};
  for(const affected of objective.affectedObjects)if(/^https?:\/\//i.test(affected)&&!sameHost(affected))throw new Error('补采对象不能越出固定来源主机');
  for(const seed of objective.options?.seedUrls||[])if(!sameHost(seed))throw new Error('补采入口不能越出固定来源主机');
  for(const key of ['maxPages','maxDepth','maxAssets','maxTotalBytes'] as const)if(objective.options?.[key]!==undefined&&objective.options[key]!<run.options[key])throw new Error('定向补采不能缩减已固定来源范围');
}
