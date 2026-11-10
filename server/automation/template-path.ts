/** A template keeps the frozen source pathname/query on its separate generated origin. */
export function templateTargetPath(value:string,targetBaseUrl:string,sourceBaseUrl?:string) {
  const url=new URL(value,targetBaseUrl),target=new URL(targetBaseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return value;
  if(url.origin===target.origin||sourceBaseUrl&&url.origin===new URL(sourceBaseUrl).origin)return url.pathname+url.search;
  return value;
}
