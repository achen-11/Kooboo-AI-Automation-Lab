const hidden = '[已隐藏]';
const secretKey = /^(?:api[-_]?key|authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|jwt(?:[-_]?token)?|token|master[-_]?key|ingest[-_]?token|read[-_]?token|encrypted_content)$/i;
export function exportRedactor(secrets: string[]) {
  const known = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  function text(value: string): string {
    for (const secret of known) value = value.replaceAll(secret, hidden);
    return value
      .replace(/\bBearer\s+[^\s"',;\\]+/gi, 'Bearer ' + hidden)
      .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[已隐藏]@')
      .replace(/([?&](?:token|api_key|apikey|key|access_token|auth|signature|sig|password|jwt_token)=)[^&#\s"']*/gi, '$1' + hidden)
      .replace(/(["'])(api[-_]?key|access[-_]?token|refresh[-_]?token|jwt[-_]?token|token|password|authorization|cookie|secret)\1\s*:\s*"(?:\\.|[^"\\])*"/gi, (match, quote, key) => `${quote}${key}${quote}:"${hidden}"`)
      .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|jwt[_-]?token|token|password|authorization|cookie|secret)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1' + hidden);
  }
  function value(input: unknown): unknown {
    if (typeof input === 'string') {
      // Tool results frequently contain serialized JSON, sometimes nested again.
      if (/^\s*[\[{]/.test(input)) {
        try { return JSON.stringify(value(JSON.parse(input))); } catch { /* Ordinary text or truncated JSON. */ }
      }
      return text(input);
    }
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, secretKey.test(key) && item !== null && item !== '' ? hidden : value(item)]));
    return input;
  }
  return { text, value, json: (input: unknown) => JSON.stringify(value(input), null, 2) };
}
