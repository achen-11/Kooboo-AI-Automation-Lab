import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../../server/lib/store.js';
import { Vault } from '../../server/lib/vault.js';
import { AutomationStore } from '../../server/automation/store.js';
import { AutomationWorker, type Execute } from '../../server/automation/worker.js';

const directory=process.argv[2],store=new Store(resolve(directory,'database.sqlite')),vault=new Vault(directory),automation=new AutomationStore(store.db);
const execute:Execute=async(task,_store,_vault,_directory,signal)=>{
  writeFileSync(resolve(directory,'cpu-started'),'1');
  const until=performance.now()+3000;
  while(performance.now()<until) { /* Deliberately block only the executor event loop. */ }
  try{await new Promise<void>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
  finally{task.stopped=true;}
};
const worker=new AutomationWorker(automation,vault,directory,{generation:execute,evaluation:execute},()=>true);
const send=(message:unknown)=>{if(process.connected)process.send?.(message,undefined,undefined,()=>{});};
worker.onOwnershipChanged=()=>send({type:'ownership',ids:worker.ownedIds()});
let stopping:Promise<void>|undefined;
const stop=()=>stopping||=(async()=>{await worker.stop();store.close();process.exit(0);})();
process.on('message',(message:any)=>{if(message.type==='cancel')worker.cancel(message.id);if(message.type==='stop')void stop();if(message.type==='quiesce')send({type:'quiesced',id:message.id,active:worker.ownedIds().length});});
process.on('disconnect',()=>{void stop();});
process.on('SIGTERM',()=>{void stop();});
worker.start();send({type:'ready'});
