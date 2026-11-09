import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';
import { init } from 'echarts';

// Real Vue state transitions and real ECharts SVG rendering; no browser or model calls.
const require=createRequire(import.meta.url),directory=mkdtempSync(join(tmpdir(),'dashboard-component-'));
let Dashboard;
before(async()=>{
  const filename=resolve('frontend/src/views/automation/DashboardView.vue'),{descriptor}=parse(readFileSync(filename,'utf8'),{filename});
  const compiled=compileScript(descriptor,{id:'dashboard-test',inlineTemplate:true}),outfile=join(directory,'component.cjs');
  const content="import TestChart from '../../components/AnalyticsChart.vue';\n"+compiled.content.replace("const AnalyticsChart = defineAsyncComponent(() => import('../../components/AnalyticsChart.vue'));", 'const AnalyticsChart = TestChart;');
  await build({stdin:{contents:content,resolveDir:dirname(filename),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile,plugins:[{name:'dashboard-services',setup(builder){
    builder.onResolve({filter:/^vue$/},()=>({path:require.resolve('vue'),external:true}));
    builder.onResolve({filter:/\/api$/},()=>({path:'api',namespace:'dashboard-test'}));
    builder.onResolve({filter:/\.vue$/},args=>({path:args.path,namespace:'dashboard-test'}));
    builder.onLoad({filter:/.*/,namespace:'dashboard-test'},args=>{
      let contents;
      if(args.path==='api')contents='export const api=(...args)=>globalThis.__dashboardServices.request(...args); export const message=e=>e.message;';
      else if(args.path.includes('BaseSelect'))contents="import {h} from 'vue';export default {props:['modelValue','options'],emits:['update:modelValue'],setup:(p,{attrs,emit})=>()=>h('select',{...attrs,value:p.modelValue,onChange:value=>emit('update:modelValue',value)})};";
      else if(args.path.includes('AnalyticsChart'))contents="import {h} from 'vue';export default {props:['option','label'],emits:['bucket','point'],setup:(p,{emit})=>()=>h('chart',{option:p.option,label:p.label,onBucket:i=>emit('bucket',i),onPoint:id=>emit('point',id)})};";
      else contents="import {h} from 'vue';export default {setup:(p,{slots})=>()=>h('section',{},slots.default?.())};";
      return {contents,loader:'js'};
    });
  }}]});Dashboard=require(outfile).default;
});
after(()=>rmSync(directory,{recursive:true,force:true}));
class HostNode extends EventTarget{constructor(tag,text=''){super();this.tag=tag;this.tagName=tag.toUpperCase();this.text=text;this.children=[];this.parent=null;this.props={};this.value='';}getRootNode(){return document;}}
const renderer=createRenderer({createElement:tag=>new HostNode(tag),createText:text=>new HostNode('#text',text),createComment:text=>new HostNode('#comment',text),
  insert(node,parent,anchor=null){if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);node.parent=parent;const index=parent.children.indexOf(anchor);parent.children.splice(index<0?parent.children.length:index,0,node);},
  remove(node){if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);node.parent=null;},setText(node,text){node.text=text;},setElementText(node,text){node.text=text;node.children=[];},parentNode:node=>node.parent,nextSibling:node=>node.parent?.children[node.parent.children.indexOf(node)+1]||null,
  patchProp(node,key,_previous,value){node.props[key]=value;if(key==='value'||key==='type')node[key]=value;},
});
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
const text=node=>node.text+node.children.map(text).join('');
async function settle(){await new Promise(resolve=>setImmediate(resolve));await nextTick();await new Promise(resolve=>setImmediate(resolve));await nextTick();}
function response(path){
  const q=new URL('http://local'+path).searchParams,start=Number(q.get('start')),end=Number(q.get('end'));
  const stages=[{stage:'evaluation',knownCny:2,recordedMs:1200000,requests:1,missingCosts:0}];
  const efficiency={selected:2,completed:1,active:1,queued:0,failed:0,interrupted:0,cancelled:0,pending:0,missingStarts:0,costSamples:1,timingSamples:1,averageCost:2,averageMs:1200000,averageElapsedMs:1200000,elapsedSamples:1,knownCny:2,missingCosts:0,quality:{passed:1,failed:0,unverified:0,missing:0},stages:[{stage:'evaluation',averageCost:2,averageMs:1200000}]};
  return {generatedAt:start,timezone:'Asia/Shanghai',range:{start,end,granularity:q.get('granularity')},overview:{resources:18,sites:16,workflows:22,running:1,queued:0},consumption:{knownCny:2,recordedMs:1200000,queueMs:0,requests:1,missingCosts:0,unplacedRequests:0,stages,executionMs:1200000,timing:{tasks:2,complete:2,incomplete:0}},efficiency,comparison:q.has('compareStart')?{start:Number(q.get('compareStart')),end:Number(q.get('compareEnd')),efficiency}:null,buckets:[{start,end,stages,queueMs:0,efficiency}],points:[{id:'run-1',name:'<test resource>',startedAt:start,durationMs:1200000,knownCny:2,costComplete:true}],pointTotal:1,runs:{items:[],total:0,page:1,pages:1}};
}
async function fixture(request){
  const previous=new Map(['document','Document','window','__dashboardServices'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  class HostDocument{activeElement=null;visibilityState='visible';}
  const calls=[];Object.defineProperty(globalThis,'Document',{value:HostDocument,configurable:true});Object.defineProperty(globalThis,'document',{value:new HostDocument(),configurable:true});Object.defineProperty(globalThis,'window',{value:{location:{hash:''}},configurable:true});
  Object.defineProperty(globalThis,'__dashboardServices',{value:{request:(path,options)=>{calls.push({path,options});return request?request(path,options):Promise.resolve(response(path));}},configurable:true});
  const container=new HostNode('root'),app=renderer.createApp({render:()=>h(Dashboard)});app.mount(container);await settle();
  return {calls,nodes:predicate=>descendants(container).filter(predicate),text:()=>text(container),button:label=>descendants(container).find(node=>node.tag==='button'&&text(node)===label),close(){app.unmount();for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}};
}

test('dashboard presets, custom Beijing hours and unit selection query the real component contract',async()=>{
  const f=await fixture();try{
    assert.ok(f.text().includes('资源'));assert.ok(f.text().includes('仍有 1 次进行中'));
    f.button('今日').props.onClick();await settle();let q=new URL('http://local'+f.calls.at(-1).path).searchParams;assert.equal(q.get('granularity'),'hour');assert.equal(Number(q.get('end'))-Number(q.get('start')),86400000);
    f.button('自定义').props.onClick();await nextTick();
    f.nodes(n=>n.props['aria-label']==='统计开始时间（北京时间）')[0].props['onUpdate:modelValue']('2026-11-09T12:00');f.nodes(n=>n.props['aria-label']==='统计结束时间（北京时间）')[0].props['onUpdate:modelValue']('2026-11-09T13:00');
    await nextTick();f.nodes(n=>n.tag==='form')[0].props.onSubmit({preventDefault(){}});await settle();q=new URL('http://local'+f.calls.at(-1).path).searchParams;assert.equal(Number(q.get('start')),Date.parse('2026-11-09T12:00:00+08:00'));assert.equal(Number(q.get('end'))-Number(q.get('start')),3600000);
    f.nodes(n=>n.props['aria-label']==='效率统计单位')[0].props.onChange('workflow');await settle();q=new URL('http://local'+f.calls.at(-1).path).searchParams;assert.equal(q.get('unit'),'workflow');assert.equal(q.get('page'),'1');
    f.nodes(n=>n.tag==='input'&&n.props.type==='checkbox')[0].props['onUpdate:modelValue'](true);await settle();
    q=new URL('http://local'+f.calls.at(-1).path).searchParams;assert.equal(Number(q.get('compareStart')),Date.parse('2026-11-09T11:00:00+08:00'));
    f.nodes(n=>n.props['aria-label']==='对比开始时间')[0].props['onUpdate:modelValue']('2026-11-09T16:00');f.nodes(n=>n.props['aria-label']==='对比结束时间')[0].props['onUpdate:modelValue']('2026-11-09T17:00');
    await nextTick();f.nodes(n=>n.tag==='form')[1].props.onSubmit({preventDefault(){}});await settle();q=new URL('http://local'+f.calls.at(-1).path).searchParams;assert.equal(Number(q.get('compareStart')),Date.parse('2026-11-09T16:00:00+08:00'));assert.equal(Number(q.get('compareEnd'))-Number(q.get('compareStart')),3600000);
  }finally{f.close();}
});

test('real ECharts renders both chart options in SVG without a browser; task clicks keep task identity',async()=>{
  const f=await fixture();try{const charts=f.nodes(n=>n.tag==='chart');assert.equal(charts.length,2);
    const hostDocument=Object.getOwnPropertyDescriptor(globalThis,'document');delete globalThis.document;
    try{for(const node of charts){const chart=init(null,null,{renderer:'svg',ssr:true,width:1000,height:320});try{chart.setOption(node.props.option);const svg=chart.renderToSVGString();assert.ok(svg.includes('<svg'));assert.ok(!svg.includes('NaN'));assert.equal(node.props.option.tooltip.renderMode,'richText');}finally{chart.dispose();}}}finally{Object.defineProperty(globalThis,'document',hostDocument);}
    const point=charts[1].props.option.series.find(s=>s.type==='scatter').data[0];assert.equal(point.value[1],20);assert.equal(point.runId,'run-1');charts[1].props.onPoint(point.runId);assert.equal(window.location.hash,'/tasks/run-1');
    charts[0].props.onBucket(0);await settle();assert.ok(f.text().includes('北京时间'));
  }finally{f.close();}
});

test('a slower obsolete response cannot replace newer filters, and the platform overview stays visible while reloading',async()=>{
  let release;let number=0;const f=await fixture(path=>{number++;if(number===2)return new Promise(resolve=>{release=()=>resolve({...response(path),overview:{resources:999,sites:0,workflows:0,running:0,queued:0}});});return Promise.resolve(response(path));});
  try{f.button('今日').props.onClick();await settle();assert.ok(f.text().includes('资源'));f.button('昨日').props.onClick();await settle();assert.equal(f.calls[1].options.signal.aborted,true);release();await settle();assert.ok(!f.text().includes('999'));assert.ok(f.text().includes('18'));}finally{f.close();}
});

test('unit and comparison updates retain mounted charts and update only the affected region', async () => {
  const pending=[];
  const f=await fixture(path=>pending.length===0&&path.includes('unit=evaluation')?Promise.resolve(response(path)):new Promise((resolve,reject)=>pending.push({path,resolve,reject})));
  try {
    const charts=f.nodes(n=>n.tag==='chart'), consumptionOption=charts[0].props.option, initialEfficiencyOption=charts[1].props.option;
    const unit=f.nodes(n=>n.props['aria-label']==='效率统计单位')[0];
    unit.props.onChange('workflow'); await settle();
    assert.deepEqual(f.nodes(n=>n.tag==='chart'),charts,'charts must stay mounted while the request is pending');
    assert.equal(f.nodes(n=>n.props['aria-label']==='效率统计单位')[0],unit);
    assert.ok(!f.text().includes('正在汇总统计…'));
    const first=pending[0], changed=response(first.path); changed.efficiency.averageMs=600000;
    first.resolve(changed); await settle();
    assert.deepEqual(f.nodes(n=>n.tag==='chart'),charts);
    assert.equal(charts[0].props.option,consumptionOption,'unit selection must leave consumption chart options untouched');
    assert.notEqual(charts[1].props.option,initialEfficiencyOption);
    const efficiencyOption=charts[1].props.option;
    const toggle=f.nodes(n=>n.tag==='input'&&n.props.type==='checkbox')[0];
    toggle.props['onUpdate:modelValue'](true); await settle();
    assert.deepEqual(f.nodes(n=>n.tag==='chart'),charts);
    assert.equal(f.nodes(n=>n.tag==='input'&&n.props.type==='checkbox')[0],toggle);
    pending[1].resolve(response(pending[1].path)); await settle();
    assert.equal(charts[0].props.option,consumptionOption);
    assert.equal(charts[1].props.option,efficiencyOption,'comparison must not redraw the primary efficiency chart');
    assert.ok(f.nodes(n=>n.props.class==='comparison-results').length);
    toggle.props['onUpdate:modelValue'](false); await settle();
    assert.equal(f.nodes(n=>n.props.class==='comparison-results').length,0,'comparison hides immediately when unchecked');
    pending[2].reject(Error('统计暂时不可用')); await settle();
    assert.deepEqual(f.nodes(n=>n.tag==='chart'),charts,'a failed refresh must keep the last successful content');
    assert.equal(charts[1].props.option,efficiencyOption);
    f.button('重试').props.onClick(); await settle();
    pending[3].resolve(response(pending[3].path)); await settle();
    assert.ok(!f.text().includes('统计暂时不可用'));
    assert.deepEqual(f.nodes(n=>n.tag==='chart'),charts);
  } finally {f.close();}
});

test('a comparison request overtaking a unit change still refreshes the selected unit data', async () => {
  const pending=[];let count=0;
  const f=await fixture(path=>++count===1?Promise.resolve(response(path)):new Promise(resolve=>pending.push({path,resolve})));
  try {
    const charts=f.nodes(n=>n.tag==='chart'),oldOption=charts[1].props.option;
    f.nodes(n=>n.props['aria-label']==='效率统计单位')[0].props.onChange('generation');await settle();
    f.nodes(n=>n.tag==='input'&&n.props.type==='checkbox')[0].props['onUpdate:modelValue'](true);await settle();
    assert.equal(f.calls[1].options.signal.aborted,true);
    const newest=pending[1];assert.equal(new URL('http://local'+newest.path).searchParams.get('unit'),'generation');
    newest.resolve(response(newest.path));await settle();
    const selectedOption=charts[1].props.option;
    assert.notEqual(selectedOption,oldOption);
    pending[0].resolve(response(pending[0].path));await settle();
    assert.equal(charts[1].props.option,selectedOption);
    assert.deepEqual(f.nodes(n=>n.tag==='chart'),charts);
  } finally {f.close();}
});

test('partial timing labels recorded coverage instead of claiming a full execution total', async () => {
  const f=await fixture(path=>{const value=response(path);value.consumption.executionMs=null;value.consumption.timing={tasks:30,complete:2,incomplete:28};return Promise.resolve(value);});
  try {
    assert.ok(f.text().includes('未完整记录'));assert.ok(f.text().includes('已记录 20 分 0 秒'));
    assert.ok(f.text().includes('完整计时 2 / 30 个任务'));
    f.button('耗时').props.onClick();await settle();
    assert.ok(f.text().includes('仅含已记录区间 · 28 个任务计时不全'));
  }finally{f.close();}
});
