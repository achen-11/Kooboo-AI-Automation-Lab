import type { AutomationReport, AutomationTask } from '../../shared/automation.js';

/** Exact identifiers only: an absent issue title is not proof that the defect was fixed. */
export function followupReportComparison(current:AutomationReport,previous?:AutomationReport|null) {
  const score=(report:AutomationReport|undefined|null,viewport:string)=>report?.scores.find(s=>s.viewport===viewport)?.value??null;
  const earlierIssues=new Set(previous?.issues.map(i=>i.title)),currentIssues=new Set(current.issues.map(i=>i.title));
  const key=(a:AutomationReport['assessments'][number])=>a.criterionId+':'+a.viewport;
  const earlierAssessments=new Map(previous?.assessments.map(a=>[key(a),a]));
  const earlierChecks=new Map(previous?.completeness?.checks.map(c=>[c.id,c]));
  return {
    note:'仅按固定指标/交付项ID及问题标题计算报告差异。分数上涨、标题消失或改名均不证明问题已解决；仍需核对本轮证据和实际图片，不据此自动宣称 improved 或通过。',
    hasPrevious:Boolean(previous),
    scores:[...new Set([...current.scores,...(previous?.scores||[])].map(s=>s.viewport))].map(viewport=>{
      const before=score(previous,viewport),after=score(current,viewport);
      return {viewport,previous:before,current:after,change:before===null||after===null?null:Number((after-before).toFixed(4))};
    }),
    assessments:current.assessments.map(a=>{const before=earlierAssessments.get(key(a));return {criterionId:a.criterionId,viewport:a.viewport,previousScore:before?.score??null,currentScore:a.score,previousPassed:before?.passed??null,currentPassed:a.passed};}),
    assessmentsNoLongerReported:previous?.assessments.filter(a=>!current.assessments.some(c=>key(c)===key(a))).map(a=>({criterionId:a.criterionId,viewport:a.viewport}))||[],
    completeness:{previousState:previous?.completeness?.state??null,currentState:current.completeness?.state??null,previousSourceComplete:previous?.completeness?.sourceComplete??null,currentSourceComplete:current.completeness?.sourceComplete??null,
      checks:current.completeness?.checks.map(c=>({id:c.id,previousStatus:earlierChecks.get(c.id)?.status??null,currentStatus:c.status}))||[],
      checksNoLongerReported:previous?.completeness?.checks.filter(c=>!current.completeness?.checks.some(n=>n.id===c.id)).map(c=>c.id)||[]},
    issueTitles:{newlyReported:previous?current.issues.filter(i=>!earlierIssues.has(i.title)).map(i=>i.title):[],noLongerReported:previous?.issues.filter(i=>!currentIssues.has(i.title)).map(i=>i.title)||[]},
    unverifiedCoverageCount:{previous:previous?.coverage.unverified.length??null,current:current.coverage.unverified.length},
  };
}

/** Preserve operational facts without resending entire SOPs and past repair messages. */
export function followupTaskContext(task:AutomationTask) {
  const optimization=task.optimization;
  return {...task,
    report:task.report?{summary:task.report.summary,quality:task.report.quality,scores:task.report.scores}:null,
    artifacts:task.artifacts?.filter(file=>file.type==='image/png'),
    collectionPendingReport:task.collectionPendingReport?{...task.collectionPendingReport,report:{summary:task.collectionPendingReport.report.summary,quality:task.collectionPendingReport.report.quality}}:undefined,
    migrationPendingReport:task.migrationPendingReport?{...task.migrationPendingReport,report:{summary:task.migrationPendingReport.report.summary,quality:task.migrationPendingReport.report.quality}}:undefined,
    generation:task.generation?{...task.generation,importedMaterials:undefined,importedMaterialCount:Object.keys(task.generation.importedMaterials||{}).length}:undefined,
    context:task.context.slice(-16000),message:task.message.slice(0,20000),
    optimization:optimization?{...optimization,policy:{...optimization.policy,sop:'见 SKILL.md'},recoveryPolicy:{...optimization.recoveryPolicy,sop:'见 SKILL.md'},rounds:optimization.rounds.map(({brief,images,...round})=>round)}:undefined,
    followup:task.followup?{...task.followup,policy:{...task.followup.policy,sop:'见 SKILL.md'},lastAction:task.followup.lastAction?{action:task.followup.lastAction.action,reason:task.followup.lastAction.reason}:undefined}:undefined,
  };
}
