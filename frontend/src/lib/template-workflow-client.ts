import type {
  TemplateChecklist,
  TemplateChecklistInput,
  TemplateWorkflowResponse,
} from '../../../shared/template-workflow.js';
import { platform, sessionFetch } from '../api';

export type EndpointResult<T> =
  | { status: 'ready'; data: T }
  | { status: 'unavailable'; reason: string };

async function parseJsonSafe(response: Response): Promise<Record<string, unknown> | null> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function handleUnauthorized(body: Record<string, unknown> | null): never {
  const errorText = typeof body?.error === 'string' ? body.error : '无法连接本机工作区，请重试连接';
  platform.ready = false;
  platform.online = false;
  platform.error = errorText;
  throw new Error(errorText);
}

export function isRouteMissing(response: Pick<Response, 'status'>, body: Record<string, unknown> | null): boolean {
  if (response.status === 501) return true;
  if (response.status !== 404) return false;
  if (!body) return true;
  // Fastify's default unmounted route payload has { statusCode: 404, error: 'Not Found', message: 'Route ... not found' }.
  if (body.error === 'Not Found' || (typeof body.message === 'string' && body.message.startsWith('Route '))) {
    return true;
  }
  return false;
}

export async function fetchTemplateChecklists(
  signal?: AbortSignal,
): Promise<EndpointResult<TemplateChecklist[]>> {
  const response = await sessionFetch('/api/automation/template-checklists', {
    credentials: 'same-origin',
    signal,
  });
  const body = await parseJsonSafe(response);
  if (response.status === 401) handleUnauthorized(body);
  if (isRouteMissing(response, body)) {
    return {
      status: 'unavailable',
      reason: '当前运行服务尚未接入模板检查集接口（GET /api/automation/template-checklists），升级或重启服务后可查阅和发布版本。',
    };
  }
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `请求失败：${response.status}`);
  }
  const items = Array.isArray(body?.items) ? (body.items as TemplateChecklist[]) : [];
  return { status: 'ready', data: items };
}

export async function publishTemplateChecklist(
  input: TemplateChecklistInput,
): Promise<TemplateChecklist> {
  const response = await sessionFetch('/api/automation/template-checklists', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJsonSafe(response);
  if (response.status === 401) handleUnauthorized(body);
  if (isRouteMissing(response, body)) {
    throw new Error('当前运行服务尚未接入模板检查集发布接口（POST /api/automation/template-checklists），未保存服务端版本。');
  }
  if (!response.ok || !body) {
    throw new Error(typeof body?.error === 'string' ? body.error : `发布检查集失败：${response.status}`);
  }
  return body as unknown as TemplateChecklist;
}

export async function fetchTaskTemplateWorkflow(
  taskId: string,
  signal?: AbortSignal,
): Promise<EndpointResult<TemplateWorkflowResponse>> {
  const response = await sessionFetch(
    `/api/automation/tasks/${encodeURIComponent(taskId)}/template-workflow`,
    { credentials: 'same-origin', signal },
  );
  const body = await parseJsonSafe(response);
  if (response.status === 401) handleUnauthorized(body);
  if (isRouteMissing(response, body)) {
    return {
      status: 'unavailable',
      reason: '当前运行服务尚未接入模板新流程接口（GET /api/automation/tasks/:id/template-workflow）。',
    };
  }
  if (!response.ok || !body) {
    throw new Error(typeof body?.error === 'string' ? body.error : `加载模板流程失败：${response.status}`);
  }
  return { status: 'ready', data: body as unknown as TemplateWorkflowResponse };
}
