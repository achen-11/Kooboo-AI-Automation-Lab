import { reactive } from 'vue';
import { api, message } from '../../api';
import type { AutomationSettings, GeneratedSite, Resource } from '../../../../shared/automation';
import type { TaskSummary } from '../../../../shared/task-presentation';
import { defaultAutomationSettings } from '../../../../shared/automation';
export const workspace=reactive({resources:[] as Resource[],sites:[] as GeneratedSite[],tasks:[] as TaskSummary[],queue:null as {generation:number;evaluation:number;queued:number}|null,settings:structuredClone(defaultAutomationSettings) as AutomationSettings,loaded:false,error:''});
let loading:Promise<void>|null=null;
export async function refresh(){
  if(loading)return loading;
  loading=(async()=>{try{const result=await api<{resources:Resource[];sites:GeneratedSite[];tasks:TaskSummary[];settings:AutomationSettings}>('/automation/overview?view=compact');Object.assign(workspace,result,{loaded:true,error:''});}catch(error){workspace.error=message(error);}finally{loading=null;}})();return loading;
}
let statusLoading:Promise<void>|null=null;
export async function refreshStatus(){
  if(statusLoading)return statusLoading;
  // Older servers ignore statusOnly and still return a compatible compact overview during upgrades.
  statusLoading=(async()=>{try{const result=await api<Pick<typeof workspace,'queue'|'settings'>>('/automation/overview?view=compact&statusOnly=1');Object.assign(workspace,result,{error:''});}catch(error){workspace.error=message(error);}finally{statusLoading=null;}})();return statusLoading;
}
export function scopeName(scope:string){return scope==='homepage'?'仅首页':'全站';}
export function bytes(size:number){return size<1024?`${size} B`:size<1048576?`${(size/1024).toFixed(1)} KB`:`${(size/1048576).toFixed(1)} MB`;}
