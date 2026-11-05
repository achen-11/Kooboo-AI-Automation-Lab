// Verified native bindings used by this project. The full generated environment declarations
// may contain private configuration and are deliberately excluded from this project.
interface NativeHttpResponse { success: boolean; statusCode: number; bodyString(): string; }
declare const k: {
  security: { newGuid(): string; sha256(value: string): string; aesEncrypt(value: string,key: string): string; aesDecrypt(value: string,key: string): string; toBase64(value: number[]): string; decodeBase64(value: string): number[] };
  DB: { sqlite: { execute(sql: string, params?: any): number; query(sql: string, params?: any): any[]; transaction(action: () => void): void } };
  request: { method: string; url: string; host: string; clientIp: string; body: string; headers: { get(key: string): string } };
  response: { setHeader(key: string,value: string): void; statusCode(code: number): void; json(value: unknown): void; binary(type: string,bytes: number[]): void };
  site: { webSite: { organizationId: unknown } };
  account: { isLogin: boolean; login(username: string,password: string): unknown; logout(): void; user: { current: { id: unknown; isAdmin: boolean }; isOfOrganization(org: string): boolean } };
  net: { httpClient: { createJsonContent(value: unknown): any; send(url: string,method: string,content?: any,headers?: Record<string,string>,timeout?: number): NativeHttpResponse } };
  file: { exists(file: string): boolean; delete(file: string): void; readBinary(file: string): number[] };
  utils: {
    uri: { parse(url: string): { scheme: string; userName: string; password: string; host: string; port: number; path: string; query: string } };
    puppeteer: { getTaskCapacity(): unknown; evaluate(url: string,script: string,options?: any): string; evaluateHtml(html: string,script: string,options?: any): string; screenshot(url: string,path: string,options?: any): void };
  };
};
