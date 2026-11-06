import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { RuntimeSettings } from '../../shared/types.js';

export type ModelConfig = RuntimeSettings['model'];
export type Completion = Pick<ChatCompletion, 'choices'> & {
  usage?: Record<string, unknown> | null;
};
export type CompletionRequest = (
  model: ModelConfig,
  messages: ChatCompletionMessageParam[],
  timeoutSeconds?: number,
  signal?: AbortSignal,
) => Promise<Completion>;

function endpointUrl(model: ModelConfig) {
  if (!model.name.trim() || !model.apiKey.trim()) throw new Error('请先配置模型名称和 API Key');
  let url: URL;
  try { url = new URL(model.endpoint); } catch { throw new Error('模型接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('模型接口必须是无凭据、无查询参数的 HTTP 或 HTTPS 完整地址');
  return url;
}

function safeFailure(error: unknown, model: ModelConfig, signal?: AbortSignal): Error {
  if (signal?.aborted) return new Error('模型请求已取消');
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new Error('模型请求超时，请检查服务响应或增加模型超时');
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) return new Error(`模型认证失败（HTTP ${status}），请检查 API Key 和访问权限`);
    if (status === 429) return new Error('模型服务限流或余额不足（HTTP 429），请检查服务配额');
    // Provider errors can contain request bodies and credentials. Only expose a redacted,
    // bounded diagnostic string; never serialize SDK headers or the full error object.
    let detail = String(error.message || '').replaceAll(model.apiKey, '[已隐藏]');
    detail = detail.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]').replace(/https?:\/\/[^\s"']+/gi, '[接口地址]');
    detail = detail.replace(/[\r\n\t]+/g, ' ').slice(0, 350);
    if (/image|vision|multimodal|图片|图像/i.test(detail))
      return new Error(`模型图片请求被拒绝（HTTP ${status || '未知'}），请检查图片格式并确认接口支持图片输入。${detail}`);
    return new Error(`模型请求失败（HTTP ${status || '未知'}）${detail ? `：${detail}` : ''}`);
  }
  return new Error('无法连接模型接口，请检查接口地址、网络及服务是否支持 Chat Completions');
}

/** The configured endpoint is used verbatim, including custom gateway paths. */
export async function requestCompletion(
  model: ModelConfig,
  messages: ChatCompletionMessageParam[],
  timeoutSeconds = 90,
  signal?: AbortSignal,
  transport: typeof globalThis.fetch = globalThis.fetch,
  tools?: ChatCompletionTool[],
): Promise<Completion> {
  const endpoint = endpointUrl(model);
  signal?.throwIfAborted();
  const client = new OpenAI({
    apiKey: model.apiKey,
    baseURL: endpoint.origin,
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: Math.max(1000, Math.min(1_800_000, timeoutSeconds * 1000)),
    fetch: (input, init) => transport(input, { ...init, redirect: 'error' }),
  });
  try {
    const response = await client.post<ChatCompletion>(endpoint.toString(), {
      body: { model: model.name, messages, ...(tools?.length ? { tools, tool_choice: 'auto' } : { response_format: { type: 'json_object' } }) },
      signal,
    });
    if (!response || !Array.isArray(response.choices) || !response.choices.length)
      throw new Error('响应中没有模型输出');
    const choice = response.choices[0];
    if (choice.finish_reason === 'length') throw new Error('模型输出超过长度限制，请调整模型或缩小证据范围');
    if (choice.message?.refusal) throw new Error('模型拒绝处理本轮证据');
    if (!choice.message?.tool_calls?.length && (typeof choice.message?.content !== 'string' || !choice.message.content.trim()))
      throw new Error('模型未返回文本结果，请检查模型是否支持图片输入和 JSON 输出');
    return { choices: response.choices, usage: response.usage ? { ...response.usage } : null };
  } catch (error) {
    // Keep our explicit response-validation errors; SDK errors are sanitized separately.
    if (error instanceof Error && !(error instanceof OpenAI.OpenAIError) && /^(响应中|模型)/.test(error.message)) throw error;
    throw safeFailure(error, model, signal);
  }
}

export function parseModelJson(response: Completion): unknown {
  try { return JSON.parse(response.choices[0]?.message?.content || ''); }
  catch { throw new Error('模型没有返回可解析的 JSON，本轮不保存分数'); }
}

// A valid PNG with a solid red left half and blue right half. The answer is not
// included in the prompt, so a text-only success response does not pass this probe.
const visionProbe = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAAAxklEQVR42u3RMQ0AAAzDsPIn3ZHYV0shEDlNphrbbQADBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBvzVASYy0OCwGZT6AAAAAElFTkSuQmCC';
export async function testModel(model: ModelConfig, signal?: AbortSignal, complete: CompletionRequest = requestCompletion) {
  const startedAt = Date.now();
  const response = await complete(model, [
    { role: 'system', content: 'Inspect the provided image. Reply with a JSON object only. Use English color names.' },
    { role: 'user', content: [
      { type: 'text', text: 'Which solid color is on the left half and which is on the right half? Return {"left":"color","right":"color"}.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${visionProbe}`, detail: 'high' } },
    ] },
  ], 45, signal);
  const result = parseModelJson(response) as { left?: string; right?: string } | null;
  if (result?.left?.toLowerCase() !== 'red' || result?.right?.toLowerCase() !== 'blue')
    throw new Error('模型接口已响应，但未通过真实图片识别测试；请确认模型支持图片输入并能正确返回 JSON');
  return { ok: true as const, model: model.name, vision: true as const, latencyMs: Date.now() - startedAt, message: '模型配置有效，图片识别和 JSON 输出测试通过', usage: response.usage ?? null };
}

export type AgentCompletionRequest = (model: ModelConfig, messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[], timeoutSeconds?: number, signal?: AbortSignal) => Promise<Completion>;
export const requestAgentCompletion: AgentCompletionRequest = (model, messages, tools, timeoutSeconds, signal) => requestCompletion(model, messages, timeoutSeconds, signal, globalThis.fetch, tools);

/** Tests real image reading, a tool call and consumption of the tool result. */
export async function testAgentModel(model: ModelConfig, signal?: AbortSignal, complete: AgentCompletionRequest = requestAgentCompletion) {
  const startedAt = Date.now();
  const tools: ChatCompletionTool[] = [{ type: 'function', function: { name: 'submit_image_colors', description: 'Submit colors observed in the provided image.', parameters: { type: 'object', properties: { left: {type:'string'}, right: {type:'string'} }, required:['left','right'], additionalProperties:false } } }];
  const messages: ChatCompletionMessageParam[] = [
    { role:'system', content:'Inspect the real image. You must call submit_image_colors with the English colors on the left and right halves. After the tool returns, reply with JSON {"receipt":"the exact tool receipt"}.' },
    { role:'user', content:[{type:'text',text:'Read the image and submit the observed colors using the tool.'},{type:'image_url',image_url:{url:`data:image/png;base64,${visionProbe}`,detail:'high'}}] },
  ];
  const first = await complete(model, messages, tools, 45, signal);
  const choice = first.choices[0].message;
  const call = choice.tool_calls?.[0];
  if (!call || call.type !== 'function' || call.function.name !== 'submit_image_colors') throw new Error('模型未通过工具调用测试，请使用同时支持图片与工具调用的模型接口');
  let args: {left?:string;right?:string};
  try { args=JSON.parse(call.function.arguments); } catch { throw new Error('模型工具参数不是有效 JSON'); }
  if (args.left?.toLowerCase() !== 'red' || args.right?.toLowerCase() !== 'blue') throw new Error('模型工具调用成功，但未通过实际图片识别测试');
  if (choice.tool_calls!.length !== 1) throw new Error('模型工具测试返回了意外的额外调用');
  const receipt = 'probe-' + Math.random().toString(36).slice(2, 14);
  messages.push({role:'assistant',content:choice.content,tool_calls:choice.tool_calls});
  messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({receipt})});
  const last=await complete(model,messages,tools,45,signal);
  let result: {receipt?: string};
  try { result=JSON.parse(last.choices[0].message.content || ''); } catch { throw new Error('模型未正确读取工具结果或返回 JSON'); }
  if (result.receipt!==receipt) throw new Error('模型未通过工具结果读取测试');
  return {ok:true as const,model:model.name,vision:true as const,tools:true as const,latencyMs:Date.now()-startedAt,message:'实际图片识别、工具调用及结果读取测试通过'};
}
