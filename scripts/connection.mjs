import {readFileSync} from 'node:fs';
export function localConfig() {
  const env={};
  for(const line of readFileSync('.env','utf8').split(/\r?\n/)) {
    const match=/^([A-Z_]+)=(.*)$/.exec(line.trim());if(!match)continue;
    env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
  return env;
}
export async function connect() {
  const env=localConfig(), origin=env.KOOBOO_SITE_URL.replace(/\/$/,'');
  const response=await fetch(origin+'/_api/v2/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:env.KOOBOO_USERNAME,password:env.KOOBOO_PASSWORD,withToken:true})});
  const token=response.headers.get('access_token');
  if(!response.ok || !token)throw new Error('Kooboo CLI 账号登录失败');
  return {origin,token,async api(path,options={}) {
    const result=await fetch(origin+path,{...options,headers:{Authorization:`Bearer ${token}`,...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
    let body;try{body=await result.json();}catch{throw new Error(`HTTP ${result.status}: ${path} 未返回 JSON`);}
    if(!result.ok)throw new Error(`HTTP ${result.status}: ${body?.error || '请求失败'}`);
    return body;
  }};
}
