import { chromium } from 'playwright';

export type ReferencePreflightReasonCode =
  | 'invalid_url'
  | 'network_error'
  | 'timeout'
  | 'http_error'
  | 'challenge_or_waf'
  | 'login_required'
  | 'blank_page';

export type ReferencePreflightResult =
  | { ok: true; url: string; finalUrl: string; status: number; method: 'http' | 'browser'; title?: string }
  | {
      ok: false;
      url: string;
      finalUrl?: string;
      status?: number;
      reasonCode: ReferencePreflightReasonCode;
      detail: string;
      method: 'http' | 'browser';
    };

export type ReferencePreflightFn = (url: string, signal: AbortSignal) => Promise<ReferencePreflightResult>;

export interface ReferenceHtmlSignalsInput {
  url: string;
  finalUrl?: string;
  status: number;
  headers?: Record<string, string>;
  title?: string;
  visibleText: string;
  visibleElementCount?: number;
  hasPasswordInput?: boolean;
}

const CHALLENGE_OR_WAF_PATTERN =
  /just a moment|attention required|checking your browser|verify you are human|access denied|request blocked|enable javascript and cookies to continue|pardon our interruption|bot protection|security check|ddos-guard|perimeterx|datadome|imperva|incapsula|akamai|captcha|turnstile|hcaptcha|recaptcha|请完成安全验证|人机验证|访问被拒绝|安全检查/i;

const LOGIN_PATH_PATTERN = /(?:^|\/)(?:login|signin|sign-in|auth|sso|account\/login)(?:\/|$|\?)/i;

function normalizeHeaders(headers?: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = String(value);
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = String(value);
  }
  return out;
}

function extractTitleAndTextFromHtml(html: string): { title: string; visibleText: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || '').replace(/\s+/g, ' ').trim();
  const visibleText = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, visibleText };
}

export function classifyHtmlReferenceSignals(
  input: ReferenceHtmlSignalsInput,
): { ok: true } | { ok: false; reasonCode: ReferencePreflightReasonCode; detail: string } {
  const headers = normalizeHeaders(input.headers);
  const title = (input.title || '').trim();
  const text = (input.visibleText || '').trim();
  const combined = `${title}\n${text.slice(0, 4000)}`;
  const finalUrl = input.finalUrl || input.url;

  if (headers['cf-mitigated']?.toLowerCase() === 'challenge' || CHALLENGE_OR_WAF_PATTERN.test(combined)) {
    return {
      ok: false,
      reasonCode: 'challenge_or_waf',
      detail: `页面返回反爬或安全验证拦截（HTTP ${input.status}${title ? `，标题：${title.slice(0, 80)}` : ''}）`,
    };
  }

  let finalPath = '';
  try {
    finalPath = new URL(finalUrl).pathname;
  } catch {
    finalPath = '';
  }

  if (
    input.status === 401 ||
    (LOGIN_PATH_PATTERN.test(finalPath) && (input.hasPasswordInput === true || text.length < 200))
  ) {
    return {
      ok: false,
      reasonCode: 'login_required',
      detail: `参考站需要登录认证（HTTP ${input.status}，落点 ${finalUrl}）`,
    };
  }

  if (input.status >= 400 || input.status === 0) {
    return {
      ok: false,
      reasonCode: 'http_error',
      detail: `参考站返回异常状态码 HTTP ${input.status}`,
    };
  }

  if (text.length < 20 && (input.visibleElementCount ?? 0) < 3) {
    return {
      ok: false,
      reasonCode: 'blank_page',
      detail: `参考站渲染后仅为空白页或空壳（可见文本 ${text.length} 字符，可见元素 ${input.visibleElementCount ?? 0} 个）`,
    };
  }

  return { ok: true };
}

export interface ReferenceRenderProbeResult {
  finalUrl: string;
  status: number;
  headers?: Record<string, string>;
  title: string;
  visibleText: string;
  visibleElementCount: number;
  hasPasswordInput: boolean;
}

async function defaultBrowserRenderCheck(url: string, signal: AbortSignal): Promise<ReferenceRenderProbeResult> {
  signal.throwIfAborted();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const abortHandler = () => {
    void context.close().catch(() => {});
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', abortHandler, { once: true });
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    const title = await page.title().catch(() => '');
    const metrics = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const candidates = Array.from(
        document.querySelectorAll(
          'h1,h2,h3,p,img,svg,canvas,video,section,main,article,header,nav,a,button',
        ),
      );
      let visibleElementCount = 0;
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) {
          const style = getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0) {
            visibleElementCount++;
          }
        }
      }
      const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
      return { visibleText: text, visibleElementCount, hasPasswordInput };
    });
    return {
      finalUrl: page.url() || url,
      status: response?.status() ?? 200,
      headers: response?.headers(),
      title,
      visibleText: metrics.visibleText,
      visibleElementCount: metrics.visibleElementCount,
      hasPasswordInput: metrics.hasPasswordInput,
    };
  } finally {
    signal.removeEventListener('abort', abortHandler);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const name = error instanceof Error ? error.name : '';
  const msg = error instanceof Error ? error.message : String(error);
  return name === 'TimeoutError' || /timeout|timed out|abort/i.test(msg);
}

export async function checkReferenceUrlPreflight(
  url: string,
  signal: AbortSignal,
  deps?: {
    fetcher?: typeof fetch;
    renderCheck?: (url: string, signal: AbortSignal) => Promise<ReferenceRenderProbeResult>;
  },
): Promise<ReferencePreflightResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol) || !parsed.hostname) {
      return {
        ok: false,
        url,
        reasonCode: 'invalid_url',
        detail: `参考站地址无效：${url}`,
        method: 'http',
      };
    }
  } catch {
    return {
      ok: false,
      url,
      reasonCode: 'invalid_url',
      detail: `参考站地址格式非法：${url}`,
      method: 'http',
    };
  }

  const fetcher = deps?.fetcher || fetch;
  const renderCheck = deps?.renderCheck || defaultBrowserRenderCheck;
  const httpSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);

  let needsBrowser = false;
  let httpFailure: Extract<ReferencePreflightResult, { ok: false }> | undefined;

  try {
    const response = await fetcher(parsed.href, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: httpSignal,
    });
    const finalUrl = response.url || parsed.href;
    const status = response.status;
    const headers = normalizeHeaders(response.headers);
    const contentType = (headers['content-type'] || '').toLowerCase();
    const body = contentType.includes('text/html') || !contentType ? await response.text() : '';
    const { title, visibleText } = extractTitleAndTextFromHtml(body);

    if (status === 404 || status === 410 || status >= 500) {
      return {
        ok: false,
        url: parsed.href,
        finalUrl,
        status,
        reasonCode: 'http_error',
        detail: `参考站返回 HTTP ${status}`,
        method: 'http',
      };
    }

    const classified = classifyHtmlReferenceSignals({
      url: parsed.href,
      finalUrl,
      status,
      headers,
      title,
      visibleText,
      visibleElementCount: visibleText.length >= 120 ? 10 : 0,
      hasPasswordInput: /<input[^>]+type=["']?password["']?/i.test(body),
    });

    if (status >= 200 && status < 300 && classified.ok && visibleText.length >= 120) {
      return {
        ok: true,
        url: parsed.href,
        finalUrl,
        status,
        method: 'http',
        ...(title ? { title } : {}),
      };
    }

    // 401/403/429, suspected challenge, or thin SPA HTML shell: confirm via headless Chromium.
    needsBrowser = true;
    if (!classified.ok) {
      httpFailure = {
        ok: false,
        url: parsed.href,
        finalUrl,
        status,
        reasonCode: classified.reasonCode,
        detail: classified.detail,
        method: 'http',
      };
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      ok: false,
      url: parsed.href,
      reasonCode: isTimeoutError(error) ? 'timeout' : 'network_error',
      detail: `参考站请求失败：${error instanceof Error ? error.message : String(error)}`,
      method: 'http',
    };
  }

  if (!needsBrowser) {
    return (
      httpFailure || {
        ok: false,
        url: parsed.href,
        reasonCode: 'blank_page',
        detail: '参考站未返回有效页面内容',
        method: 'http',
      }
    );
  }

  const browserSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  try {
    const rendered = await renderCheck(parsed.href, browserSignal);
    const classified = classifyHtmlReferenceSignals({
      url: parsed.href,
      finalUrl: rendered.finalUrl,
      status: rendered.status,
      headers: rendered.headers,
      title: rendered.title,
      visibleText: rendered.visibleText,
      visibleElementCount: rendered.visibleElementCount,
      hasPasswordInput: rendered.hasPasswordInput,
    });
    if (classified.ok) {
      return {
        ok: true,
        url: parsed.href,
        finalUrl: rendered.finalUrl,
        status: rendered.status,
        method: 'browser',
        ...(rendered.title ? { title: rendered.title } : {}),
      };
    }
    return {
      ok: false,
      url: parsed.href,
      finalUrl: rendered.finalUrl,
      status: rendered.status,
      reasonCode: classified.reasonCode,
      detail: classified.detail,
      method: 'browser',
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (httpFailure) return httpFailure;
    return {
      ok: false,
      url: parsed.href,
      reasonCode: isTimeoutError(error) ? 'timeout' : 'network_error',
      detail: `参考站浏览器预检失败：${error instanceof Error ? error.message : String(error)}`,
      method: 'browser',
    };
  }
}
