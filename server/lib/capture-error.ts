/** Redact credentials for diagnostics persisted in events and stage errors. */
export function safeErrorMessage(error: unknown): string {
  let raw = error instanceof Error ? error.message : String(error);
  raw = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\nCall log:/i)[0]
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/https?:\/\/[^\s'"<>]+/gi, (url) =>
      url.split(/[?#]/)[0].replace(/(https?:\/\/)[^/@]+@/i, '$1[redacted]@')
    )
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ').trim()
    .slice(0, 400);
  return raw || '未提供错误信息';
}

/** Add actionable browser hints only to capture errors. */
export function captureErrorMessage(error: unknown): string {
  const raw = safeErrorMessage(error);
  const hint = /clipped area|clip.*outside/i.test(raw)
    ? '截图裁剪区域越界，属于采集器错误，请更新采集服务后重试。'
    : /timeout|timed out|超时/i.test(raw)
    ? '浏览器操作超时，可重试；持续失败时检查服务器网络和页面外部资源。'
    : /ERR_NAME_NOT_RESOLVED|ENOTFOUND|DNS/i.test(raw)
    ? '域名解析失败，请检查评分服务器的 DNS 和网络。'
    : /ERR_CERT|certificate|SSL|TLS/i.test(raw)
    ? 'HTTPS 证书连接失败，请检查站点证书和评分服务器的网络。'
    : /ERR_|connection|connect/i.test(raw)
    ? '浏览器连接页面失败，请检查评分服务器能否访问该站点。'
    : /slot|capacity|available.*page/i.test(raw)
    ? '服务器浏览器任务繁忙，请稍后重试。'
    : '采集调用失败，请根据原始错误检查采集环境。';
  return `${hint} 原始错误：${raw || '未提供错误信息'}`;
}
