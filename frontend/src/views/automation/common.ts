import { reactive } from 'vue';
import { api, message } from '../../api';
import type { AutomationSettings, AutomationTask, GeneratedSite, Resource } from '../../../../shared/automation';
import { defaultAutomationSettings } from '../../../../shared/automation';
export const workspace=reactive({resources:[] as Resource[],sites:[] as GeneratedSite[],tasks:[] as AutomationTask[],settings:structuredClone(defaultAutomationSettings) as AutomationSettings,loaded:false,error:''});
let loading:Promise<void>|null=null;
export async function refresh(){
  if(loading)return loading;
  loading=(async()=>{try{const result=await api<{resources:Resource[];sites:GeneratedSite[];tasks:AutomationTask[];settings:AutomationSettings}>('/automation/overview');Object.assign(workspace,result,{loaded:true,error:''});}catch(error){workspace.error=message(error);}finally{loading=null;}})();return loading;
}
export function scopeName(scope:string){return scope==='homepage'?'仅首页':'全站';}
export function bytes(size:number){return size<1024?`${size} B`:size<1048576?`${(size/1024).toFixed(1)} KB`:`${(size/1048576).toFixed(1)} MB`;}
