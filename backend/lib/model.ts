import type { RuntimeSettings } from '../shared/types.js';
import { httpJson } from '../runtime.js';
export interface ModelResponse { choices?: { message?: { content?: string } }[]; usage?: Record<string, unknown>; }
export function requestCompletion(model: RuntimeSettings['model'], messages: unknown[], timeout = 90): ModelResponse {
  const raw = httpJson(model.endpoint, 'POST', {model:model.name,messages,response_format:{type:'json_object'},temperature:0,max_tokens:6000}, model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}, timeout);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型未返回有效 JSON 对象');
  return raw;
}
// 内置 96×48 PNG，左右分别为红色与蓝色，无站点资料或平台凭据。
const probeImage = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAAAa0lEQVR4nO3QMQ0AIBAEMOSw4AX/Ft4ELrgbmlRB15xTZd+psuIjggQJElQkPiJIkCBBRQQJEiRIkCBBggSViI8IEiRIUBFBggQJEiRIkCBBJeIjggQJElREkCBBggQJEiRIUIn4iCBBgn56ypHpWqwFVssAAAAASUVORK5CYII=';
export function testModel(model: RuntimeSettings['model']) {
  const start = Date.now();
  const raw = requestCompletion(model, [
    { role: 'system', content: '你是图片读取测试助手。读取图片，严格返回 JSON 对象，不要输出 Markdown 或解释。' },
    { role: 'user', content: [
      { type: 'text', text: '图像左右两半各有一个纯色色块。请识别其颜色，返回包含 left 与 right 两个字段的 JSON 对象。每个字段值只能是 red、green、blue、yellow、white、black 中的一项。' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${probeImage}`, detail: 'high' } },
    ] },
  ], 50);
  let result: unknown;
  try { result = JSON.parse(raw.choices?.[0]?.message?.content ?? ''); }
  catch { throw new Error('接口已响应，但模型没有返回可解析的 JSON；请检查 JSON 输出支持情况'); }
  if (!result || typeof result !== 'object' || !('left' in result) || !('right' in result) || result.left !== 'red' || result.right !== 'blue') throw new Error('接口已响应，但测试图像识别未通过；请确认所选模型支持图片输入');
  const usage = Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].flatMap((key) => typeof raw.usage?.[key] === 'number' ? [[key, raw.usage[key]]] : []));
  return { ok: true, model: model.name, latencyMs: Date.now() - start, checks: { imageInput: true, jsonOutput: true }, usage };
}
