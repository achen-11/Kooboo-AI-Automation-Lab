import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Vault } from '../lib/vault.js';
import { codexClient } from './evaluator.js';
// Same validated PNG used by the existing model probe; actual pixels are sent to Codex.
const image='iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAAAxklEQVR42u3RMQ0AAAzDsPIn3ZHYV0shEDlNphrbbQADBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBvzVASYy0OCwGZT6AAAAAElFTkSuQmCC';
export async function probeCodex(vault:Vault,directory:string){
  const started=Date.now();const work=resolve(directory,'model-probes',randomUUID());mkdirSync(work,{recursive:true,mode:0o700});
  const receipt=randomUUID();writeFileSync(resolve(work,'receipt.txt'),receipt,{mode:0o600});writeFileSync(resolve(work,'sample.png'),Buffer.from(image,'base64'),{mode:0o600});
  const model=vault.automation().evaluationModel;
  const thread=codexClient(vault,directory).startThread({model,workingDirectory:work,skipGitRepoCheck:true,sandboxMode:'read-only',approvalPolicy:'never',webSearchMode:'disabled'});
  const schema=z.object({leftColor:z.string(),rightColor:z.string(),receipt:z.string()}).strict();
  const turn=await thread.run([{type:'text',text:'Inspect the actual attached image and report the color of each half using English color names. Use a tool to read receipt.txt and return its exact content. Do not infer the receipt.'},{type:'local_image',path:resolve(work,'sample.png')}],{signal:AbortSignal.timeout(120000),outputSchema:z.toJSONSchema(schema)});
  const result=schema.parse(JSON.parse(turn.finalResponse));
  if(result.leftColor.toLowerCase()!=='red'||result.rightColor.toLowerCase()!=='blue'||result.receipt!==receipt||!turn.items.some(item=>item.type==='command_execution'&&item.status==='completed'))throw new Error('Codex 图片识别或实际工具读取未通过');
  return {ok:true,model,vision:true,tools:true,latencyMs:Date.now()-started};
}
