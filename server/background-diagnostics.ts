import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Failure diagnostics contain only bounded, redacted errors, never process environments. */
export function recordBackgroundFailure(directory:string,redact:(value:string)=>string,details:{kind:string;pid?:number;origin?:string;code?:number|null;signal?:string|null;message?:string;stack?:string}) {
  try {
    const {message,stack,...identity}=details;
    const value={at:new Date().toISOString(),pid:process.pid,...identity,...(message?{message:redact(message).slice(0,2000)}:{}),...(stack?{stack:redact(stack).slice(0,6000)}:{})};
    appendFileSync(resolve(directory,'background-worker-failures.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});
  } catch { /* Diagnostics must not replace the original failure or cause recursion. */ }
}

/** Observes Node's default fatal behavior without suppressing or resuming the failure. */
export function installBackgroundFailureMonitor(directory:string,redact:(value:string)=>string) {
  process.on('uncaughtExceptionMonitor',(error,origin)=>recordBackgroundFailure(directory,redact,{kind:'uncaught-exception',origin,message:error.message,stack:error.stack}));
}
