// Node.js 24+, run on the Admin backend. Never bundle this token into frontend JavaScript.
const base = new URL(process.env.EVALUATOR_BASE_URL || 'http://127.0.0.1:4180');
const token = process.env.EVALUATOR_READ_TOKEN;
if (!token) throw new Error('请设置 EVALUATOR_READ_TOKEN');
if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('基地址仅填写 origin');
if (!['https:', 'http:'].includes(base.protocol)) throw new Error('基地址需要 HTTP(S)');
if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('远程地址请使用 HTTPS');

for (let page = 1; ; page++) {
  const url = new URL('/api/v1/evaluations', base);
  url.search = new URLSearchParams({ detail: 'report', page: String(page), pageSize: '50', order: 'asc' }).toString();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`评分 API HTTP ${response.status}；请检查服务端配置`);
  const data = await response.json();
  if (data.apiVersion !== 1 || !Array.isArray(data.items) || typeof data.hasMore !== 'boolean') throw new Error('查询协议无效');
  for (const item of data.items) {
    // Replace with an idempotent database upsert; do not log full reports or credentials.
    console.log(JSON.stringify({ evaluationId: item.evaluationId, runId: item.runId, jobId: item.jobId, scoringStatus: item.scoringStatus, fidelityScore: item.fidelityScore, completionScore: item.completionScore }));
  }
  if (!data.hasMore) break;
}
