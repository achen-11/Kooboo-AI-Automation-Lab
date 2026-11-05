import { spawnSync } from 'node:child_process';
// Dependency order: secret + backend, API, frontend, then enable the durable queue consumer.
for(const target of ['src/code','src/api','src/js','src/css','src/page','src/job']) {
  const result=spawnSync('kb',['push',target],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status ?? 1);
}
