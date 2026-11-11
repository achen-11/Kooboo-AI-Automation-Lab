import { installBackgroundFailureMonitor } from '../../server/background-diagnostics.js';

installBackgroundFailureMonitor(process.argv[2],value=>value.replaceAll('private-test-secret','[redacted]'));
process.send?.({type:'ready'});
setTimeout(()=>{void Promise.reject(new Error('Synthetic worker rejection private-test-secret'));},200);
