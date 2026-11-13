import type { TemplateCheckDefinition, TemplateConstraint, TemplateLayoutElement, TemplateLayoutSnapshot } from '../../shared/template-workflow.js';

export interface ScriptVerdict {passed:boolean;actual:string;measurements:Record<string,number|string|boolean|null>}
const anchor=(snapshot:TemplateLayoutSnapshot,selector:string|undefined)=>snapshot.elements.find(element=>element.selector===selector&&element.visible);
function compareConstraint(check:TemplateCheckDefinition,constraint:TemplateConstraint,source:TemplateLayoutSnapshot,target:TemplateLayoutSnapshot,mapping:Record<string,string>):ScriptVerdict|undefined {
  const expected=constraint.anchors.map(selector=>anchor(source,selector)),actual=constraint.anchors.map(selector=>anchor(target,mapping[selector]));
  if(expected.some(element=>!element)||actual.some(element=>!element))return;
  const a=expected as TemplateLayoutElement[],b=actual as TemplateLayoutElement[],t=check.tolerancePx;
  if(check.kind==='gutter'){
    const delta=Math.max(...a.map((element,index)=>Math.max(Math.abs(element.rect.x-b[index].rect.x),Math.abs((source.width-element.rect.x-element.rect.width)-(target.width-b[index].rect.x-b[index].rect.width)))));
    return {passed:delta<=t,actual:`正文边界最大偏差 ${Math.round(delta)}px`,measurements:{maxGutterDelta:delta,tolerance:t}};
  }
  if(check.kind==='line-count'&&constraint.preserveLines){
    // Changed copy is a semantic review, never an automatic CSS diagnosis.
    if(a.some((element,index)=>element.text!==b[index].text||element.lines===null||b[index].lines===null))return;
    const delta=Math.max(...a.map((element,index)=>Math.abs(element.lines!-b[index].lines!)));
    return {passed:delta===0,actual:`相同文案行数偏差 ${delta}`,measurements:{maxLineDelta:delta}};
  }
  if(a.length<2||b.length<2)return;
  if(check.kind==='spacing'){
    const expectedGap=a[1].rect.y-a[0].rect.y-a[0].rect.height,actualGap=b[1].rect.y-b[0].rect.y-b[0].rect.height,delta=Math.abs(expectedGap-actualGap);
    return {passed:delta<=t,actual:`间距 ${Math.round(actualGap)}px，参考 ${Math.round(expectedGap)}px`,measurements:{expectedGap,actualGap,delta,tolerance:t}};
  }
  if(check.kind==='relation'&&constraint.relation){
    const [first,second]=b.map(element=>element.rect);let passed=false;
    if(constraint.relation==='left-of')passed=first.x+first.width<=second.x+t;
    if(constraint.relation==='above')passed=first.y+first.height<=second.y+t;
    if(constraint.relation==='aligned-left')passed=Math.abs(first.x-second.x)<=t;
    if(constraint.relation==='aligned-top')passed=Math.abs(first.y-second.y)<=t;
    return {passed,actual:`锚点关系 ${constraint.relation}：${passed?'符合':'偏离'}`,measurements:{relation:constraint.relation,tolerance:t}};
  }
}
export function runTemplateScript(check:TemplateCheckDefinition,constraints:TemplateConstraint[],source:TemplateLayoutSnapshot,target:TemplateLayoutSnapshot,mapping:Record<string,string>):ScriptVerdict|undefined {
  if(source.truncated||target.truncated)return;
  const applicable=constraints.filter(constraint=>constraint.checkId===check.id);
  if(!applicable.length)return;
  const results=applicable.map(constraint=>compareConstraint(check,constraint,source,target,mapping));
  const failure=results.find(result=>result&&!result.passed);if(failure)return failure;
  if(results.some(result=>!result))return;
  return {passed:true,actual:results.map(result=>result!.actual).join('；'),measurements:Object.fromEntries(results.flatMap((result,index)=>Object.entries(result!.measurements).map(([key,value])=>[index+':'+key,value])))};
}
