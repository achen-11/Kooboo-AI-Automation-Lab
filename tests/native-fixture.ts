import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
export function fixture(file = ':memory:') {
  const db = new DatabaseSync(file);
  let status = 200, output: any;
  const native: any = {
    security: {
      newGuid: () => randomUUID().replace(/-/g,''),
      sha256: (s: string) => createHash('sha256').update(s).digest('hex'),
      aesEncrypt: (value: string,key: string) => { const iv=Buffer.alloc(16);const cipher=createCipheriv('aes-256-cbc',Buffer.from(key,'hex'),iv);return Buffer.concat([cipher.update(value),cipher.final()]).toString('base64'); },
      aesDecrypt: (value: string,key: string) => { const decipher=createDecipheriv('aes-256-cbc',Buffer.from(key,'hex'),Buffer.alloc(16));return Buffer.concat([decipher.update(Buffer.from(value,'base64')),decipher.final()]).toString(); },
      toBase64: (bytes: number[]) => Buffer.from(bytes).toString('base64'), decodeBase64: (value: string) => Array.from(Buffer.from(value,'base64'))
    },
    DB: { sqlite: {
      execute(sql: string, params: any = {}) {
        if (!Object.keys(params).length && sql.includes(';')) { db.exec(sql); return Number(db.prepare('SELECT changes() AS n').get()!.n); }
        return Number(db.prepare(sql).run(params).changes);
      },
      query: (sql: string,params = {}) => db.prepare(sql).all(params),
      transaction: (fn: () => void) => { db.exec('BEGIN IMMEDIATE');try {fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;} }
    } },
    utils: { uri: { parse: (value: string) => { const u=new URL(value);return {scheme:u.protocol.slice(0,-1),userName:u.username,password:u.password,host:u.hostname,port:Number(u.port || (u.protocol==='https:'?443:80)),path:u.pathname,query:u.search}; } }, puppeteer: {getTaskCapacity:()=>({maximum:4})} },
    request: { url:'https://evaluator.test/api/session',host:'evaluator.test',method:'GET',body:'',clientIp:'127.0.0.1',headers:{get:()=>''} },
    response: {setHeader:()=>{},statusCode:(s: number)=>{status=s;},json:(value:any)=>{output=value;},binary:(_type:string,bytes:number[])=>{output=bytes;}},
    site: {webSite:{organizationId:'owner'}},
    account: {isLogin:true,logout(){native.account.isLogin=false;},user:{current:{id:'owner',isAdmin:false},isOfOrganization:()=>true}},
  };
  (globalThis as any).k=native;
  return {db,native,request(path:string,method='GET',body?:unknown,headers:Record<string,string>={}){ status=200;output=undefined;native.request.url='https://evaluator.test'+path;native.request.method=method;native.request.body=body === undefined ? '' : JSON.stringify(body);native.request.headers.get=(name:string)=>headers[name.toLowerCase()] || ''; },result:()=>({status,body:output})};
}
export function submission(id = randomUUID(), occurredAt = Date.now()) {
  return { schemaVersion:1 as const,attemptId:id,requestId:id,jobId:'batch-job',trigger:'chat_stopped' as const,occurredAt,target:{koobooOrigin:'https://kooboo.test',siteId:'generated-site'},inputs:{referenceUrl:'https://reference.test'},scope:'homepage' as const };
}
