import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import type { AutomationTask, FollowupAction } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { usageCapture } from './usage-proxy.js';
import { codexClient } from './evaluator.js';
import { generationSession, type GenerationObservation } from './generation-session.js';
import { readConversation, refreshSite, probeSite } from './kooboo.js';
import { FollowupRuntimeError } from './errors.js';

export const followupActionSchema=z.object({action:z.enum(['retry','continue','answer','evaluate','wait','interrupt']),reason:z.string().trim().min(1).max(6000),evidence:z.array(z.string()).min(1).max(30),message:z.string().trim().min(1).max(30000).optional(),answer:z.record(z.string(),z.unknown()).optional(),callId:z.string().max(100).optional(),waitSeconds:z.number().int().min(5).max(300).optional(),nextSteps:z.array(z.string().trim().min(1).max(2000)).min(1).max(10).optional()}).strict();
const toolInput=z.object({tool:z.enum(['get_task','get_conversation','get_site','probe_site','inspect_execution','act']),decision:followupActionSchema.optional()}).strict();
export interface RecoveryInspection { conversation?:Awaited<ReturnType<typeof readConversation>>; siteReady?:boolean; execution?:GenerationObservation }

/** Action requests are checked against host-owned observations, never against AI-written files. */
export function validateFollowupAction(raw:unknown,task:AutomationTask,inspection:RecoveryInspection,observations:Set<string>):FollowupAction {
  const action=followupActionSchema.parse(raw);
  if(action.evidence.some(id=>!observations.has(id)))throw new Error('行动引用了不存在的工具观察，请先查证');
  if(action.action==='interrupt'&&!action.nextSteps?.length)throw new Error('中断必须给出下一步做法');
  if(['retry','continue','answer','evaluate'].includes(action.action)&&!task.followup?.executionStopped)throw new Error('尚未确认原执行停止，只能查证、等待或明确中断');
  if(action.action==='retry'&&inspection.execution?.running)throw new Error('已观察到原会话仍在执行，不能重试');
  if(['continue','answer','evaluate'].includes(action.action)&&task.kind!=='generation')throw new Error('评测跟进只能重试评测、等待或中断，不能直接改站');
  if(action.action==='continue'||action.action==='answer') {
    if(!task.generatedSiteId||!task.generation?.prepared)throw new Error('站点或资料准备尚未完成，应先 retry 原准备步骤');
    const state=inspection.execution;
    if(!state?.ready||state.running)throw new Error('请先 inspect_execution，确认原会话已就绪且没有运行中的执行');
    if(task.generation.deliveryState==='sending'&&!(state.delivery?.id===task.generation.deliveryId&&state.delivery?.state==='accepted'))throw new Error('原发送结果仍不确定，禁止追加另一轮');
    if(action.action==='continue'&&(!action.message||state.pending))throw new Error('继续生成需要明确消息；有待输入调用时应使用 answer');
    if(action.action==='answer'&&(!action.answer||!state.pending||action.callId!==state.pending.callId))throw new Error('回答必须对应当前待输入调用及其参数');
  }
  if(action.action==='evaluate') {
    const final=inspection.conversation;
    if(!task.generatedSiteId||!task.siteUrl||!inspection.siteReady)throw new Error('请先获取生成站并 probe_site 确认可访问');
    if(task.generation?.deliveryState!=='completed'&&(!final||final.pendingCalls.length||final.lastRole!=='assistant'||!final.finalText.trim()))throw new Error('缺少已结束的交付记录，不能直接交接评测');
    if(inspection.execution?.running||inspection.execution?.pending)throw new Error('原执行仍在运行或等待输入，应先处理');
  }
  return action;
}

export type FollowupExecute=(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal)=>Promise<FollowupAction>;
type FollowupClient={startThread(options:ThreadOptions):Pick<Thread,'runStreamed'>;resumeThread(id:string,options:ThreadOptions):Pick<Thread,'runStreamed'>};
type FollowupClientFactory=(vault:Vault,directory:string,extra:Record<string,string>)=>FollowupClient;
export async function executeFollowup(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,createClient:FollowupClientFactory=codexClient):Promise<FollowupAction> {
  if(!task.followup)throw new Error('跟进配置缺失');
  const priorUsage=new Set(store.usage.entries(task.id).map(e=>e.source+':'+e.id)),priorTokens=task.followup.tokens;
  const work=resolve(directory,'followup-runs',task.id);mkdirSync(work,{recursive:true,mode:0o700});
  const inspection:RecoveryInspection={},observations=new Set<string>();let selected:FollowupAction|undefined;
  const toolAbort=new AbortController(),toolSignal=AbortSignal.any([signal,toolAbort.signal]);
  let browser:Awaited<ReturnType<typeof generationSession>>|undefined;
  let activeTool:Promise<unknown>|undefined;
  let toolCount=0,busy=false;
  const observe=(tool:string,value:unknown)=>{
    const id=`observation-${randomUUID()}`,safe=store.sanitize(value);observations.add(id);
    writeFileSync(resolve(work,id+'.json'),JSON.stringify(safe,null,2),{mode:0o600});
    task.followup!.observations.push(id);task.followup!.observations=task.followup!.observations.slice(-100);store.put(task);
    store.event(task.id,`AI 工具 ${tool} → ${id}\n${JSON.stringify(safe).slice(0,5000)}`);
    return {evidenceId:id,result:safe};
  };
  const tools=async(raw:unknown)=>{
    toolSignal.throwIfAborted();if(++toolCount>30)throw new Error('本轮跟进工具调用达到上限');
    const input=toolInput.parse(raw);
    if(selected){if(input.tool==='act'&&JSON.stringify(input.decision)===JSON.stringify(selected))return {accepted:true,decision:selected};throw new Error('本轮行动已经提交，请等待调度执行结果');}
    if(input.tool==='get_task')return observe(input.tool,{task:{...task,context:task.context.slice(-16000),message:task.message.slice(0,20000),followup:task.followup?{...task.followup,policy:{...task.followup.policy,sop:'见 SKILL.md'}}:undefined},input:{...store.version(task.versionId),description:store.version(task.versionId)?.description.slice(0,20000)},site:task.generatedSiteId?store.site(task.generatedSiteId):null,events:store.events(task.id).slice(-12).map(e=>({...e,message:e.message.slice(0,1500)}))});
    if(input.tool==='get_conversation'){inspection.conversation=await readConversation(task,store,vault,toolSignal);return observe(input.tool,inspection.conversation);}
    if(input.tool==='get_site')return observe(input.tool,await refreshSite(task,store,vault,toolSignal)||{missing:true});
    if(input.tool==='probe_site'){const site=await refreshSite(task,store,vault,toolSignal);const result=await probeSite(site?.url||'',toolSignal);inspection.siteReady=true;return observe(input.tool,result);}
    if(input.tool==='inspect_execution'){
      if(!task.followup!.executionStopped)throw new Error('原浏览器停止状态未确认，不能并行打开相同执行；可查原会话并说明中断原因');
      browser??=await generationSession(task,store,vault,directory,toolSignal);inspection.execution=await browser.snapshot();return observe(input.tool,inspection.execution);
    }
    if(!input.decision)throw new Error('act 需要 decision');
    const current=store.task(task.id);if(current?.status==='cancelling')throw new Error('任务正在取消');
    toolSignal.throwIfAborted();
    selected=validateFollowupAction(input.decision,task,inspection,observations);
    task.followup!.lastAction=selected;store.put(task);store.event(task.id,`AI 决策：${JSON.stringify(selected)}`);
    return {accepted:true,decision:selected,note:'调度器将在本轮工具会话结束后执行此行动；不会并发创建另一轮执行。'};
  };
  const token=randomUUID()+randomUUID();
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const reply=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(store.sanitize(value)));};
    const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply(401,{error:'Unauthorized'});
    if(req.method!=='POST'||req.url!=='/tools')return reply(404,{error:'Not found'});
    if(busy)return reply(409,{error:'请顺序调用工具，上一操作尚未结束'});
    busy=true;
    try{let body='';for await(const chunk of req){body+=chunk;if(body.length>80000)throw new Error('工具请求过大');}activeTool=tools(JSON.parse(body));reply(200,await activeTool);}
    catch(error){const message=error instanceof Error?error.message:'工具失败';store.event(task.id,'AI 工具失败：'+message);reply(400,{error:message});}
    finally{busy=false;activeTool=undefined;}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let usage:Awaited<ReturnType<typeof usageCapture>>|undefined;const usageStart=Date.now();
  try{
  usage=await usageCapture(task.id,'followup',store,vault,signal);
  const address=server.address();if(!address||typeof address==='string')throw new Error('跟进工具服务启动失败');
  writeFileSync(resolve(work,'tools.mjs'),`try{const r=await fetch(process.env.FOLLOWUP_TOOLS_URL,{method:'POST',headers:{Authorization:'Bearer '+process.env.FOLLOWUP_TOOLS_TOKEN,'Content-Type':'application/json'},body:process.argv[2]||'{}'});console.log(await r.text());if(!r.ok)process.exitCode=1;}catch(error){console.log(JSON.stringify({kind:'followup_tool_transport_error',code:error.cause?.code||'FETCH_FAILED',hostname:new URL(process.env.FOLLOWUP_TOOLS_URL).hostname}));process.exitCode=1;}`,{mode:0o600});
  writeFileSync(resolve(work,'SKILL.md'),task.followup.policy.sop,{mode:0o600});
  writeFileSync(resolve(work,'task.json'),JSON.stringify(store.sanitize({task,input:store.version(task.versionId)}),null,2),{mode:0o600});
  const codex=createClient(vault,directory,{FOLLOWUP_TOOLS_URL:`http://127.0.0.1:${address.port}/tools`,FOLLOWUP_TOOLS_TOKEN:token,...usage.env});
  // The SDK's networkAccessEnabled config applies to workspace-write only.
  // Host-owned observations and action validation remain the source of truth.
  const options={model:vault.automation().evaluationModel,workingDirectory:work,skipGitRepoCheck:true,sandboxMode:'workspace-write' as const,networkAccessEnabled:true,approvalPolicy:'never' as const,webSearchMode:'disabled' as const};
  const thread=task.followup.threadId?codex.resumeThread(task.followup.threadId,options):codex.startThread(options);
    const prompt=`按照 SKILL.md 自主跟进 task.json 中的本轮任务。当前尝试 ${task.followup.attempts}/${task.followup.policy.maxAttempts}，阶段 ${task.stage}，最近问题：${task.error}。
你必须通过本轮 tools.mjs 查询事实并调用 act 工具推动流程，不要只写建议，不要直接修改目标站或任务文件。使用 node tools.mjs '<JSON>'，工具服务地址和令牌已由运行环境注入，不要输出令牌。每次恢复都使用当前工具环境。
查询示例：{"tool":"get_task"}。其他查询工具：get_conversation、get_site、probe_site、inspect_execution。工具返回 evidenceId，行动必须引用本轮已取得的 evidenceId。
行动示例：{"tool":"act","decision":{"action":"retry","reason":"依据实际错误决定重试本阶段","evidence":["工具返回的 evidenceId"]}}。
action 可选 retry（重新执行当前阶段，保留已有站点和证据）、continue（原站原会话继续，需 message）、answer（处理待输入调用，需 callId 和符合调用要求的 answer 参数对象）、evaluate（确认交付后接入独立评测）、wait（waitSeconds 为5到300）、interrupt（必须 nextSteps 数组）。
continue/answer 前必须 inspect_execution；evaluate 前必须 get_site、probe_site，执行终态不明确时还必须 get_conversation 查交付及未完成调用。系统会检查真实执行前提，失败后请根据工具错误继续查证。不要把原会话的可选建议当成当前任务必做项。首页外工作不在首页任务范围内。评测不达标无需生成修复。
评测阶段的 retry 会把你本轮 decision.reason 直接传给原评测会话，请在 reason 中明确需要修正的指标、视口、证据角色等已查证要求。评测器会向同一会话反馈具体结果校验错误，最多追加两次结果修正；可以复用有效证据，不需要重新生成站点或重复采集。会话本身失效时会释放绑定供后续评测使用新会话。不要假定 retry 无法传递具体修正要求。
成功 act 后简要说明原因即结束本轮。`;
    const stream=await thread.runStreamed(prompt,{signal});
    for await(const event of stream.events){
      signal.throwIfAborted();
      if(event.type==='thread.started'){task.followup.threadId=event.thread_id;store.put(task);store.event(task.id,'Codex 流程跟进会话：'+event.thread_id);}
      else if(event.type==='turn.completed'){usage.fallback(event.usage as unknown as Record<string,unknown>,usageStart);store.put(task);}
      else if(event.type==='turn.failed')throw new Error(event.error.message);
      else if(event.type==='error')throw new Error(event.message);
      else if(event.type==='item.completed'){
        if(event.item.type==='agent_message')store.event(task.id,'AI 跟进：'+event.item.text);
        else if(event.item.type==='command_execution'){
          const command=event.item.command.replaceAll(token,'[已隐藏]'),output=event.item.aggregated_output.replaceAll(token,'[已隐藏]');
          store.event(task.id,`跟进工具执行 ${event.item.status}：${command.slice(0,1500)}${event.item.status==='failed'&&output?'\n'+output.slice(-4000):''}`);
          // Only the helper's own failed transport result is an infrastructure fault.
          // Successful observations can contain historical EPERM messages in task logs.
          const denied=event.item.status==='failed'&&/tools\.mjs/.test(command)&&output.split(/\r?\n/).some(line=>{
            try{const value=JSON.parse(line);return value?.kind==='followup_tool_transport_error'&&['EPERM','EACCES'].includes(value.code)&&['127.0.0.1','localhost','::1','[::1]'].includes(value.hostname);}catch{return false;}
          });
          if(!selected&&denied)throw new FollowupRuntimeError(
            '跟进运行环境拒绝访问本机工具服务（EPERM / EACCES），本轮未能查询事实或执行恢复动作。',
            ['检查跟进运行器是否使用 workspace-write 沙箱并启用网络访问；确认本机工具端口可连接后，点击“AI 接管 / 恢复”。','此类运行环境故障不会通过增加次数或 token 预算解决，系统已停止自动重试。']);
        }
      }
    }
    if(!selected)throw new Error('跟进 Agent 未提交可执行的行动');
    return selected;
  }catch(error){if(selected&&!signal.aborted)return selected;throw error;}
  finally{
    await usage?.close();
    task.followup.tokens=priorTokens+store.usage.entries(task.id).filter(e=>e.stage==='followup'&&!priorUsage.has(e.source+':'+e.id)).reduce((total,e)=>total+(e.tokens?.input||0)+(e.tokens?.output||0),0);store.put(task);
    toolAbort.abort(new Error('本轮跟进工具已关闭'));
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    await activeTool?.catch(()=>{});
    if(browser)await browser.close();
  }
}
