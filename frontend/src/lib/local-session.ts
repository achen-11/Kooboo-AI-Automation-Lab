/** Re-establish the local HttpOnly session without an operator login step. */
export function createSessionFetch(fetcher: typeof fetch) {
  let connecting: Promise<Response> | undefined;

  async function connect(): Promise<Response> {
    if (!connecting) {
      connecting = fetcher('/api/login', { method: 'POST', credentials: 'same-origin' });
    }
    const pending = connecting;
    try { return await pending; }
    finally { if (connecting === pending) connecting = undefined; }
  }

  return async (url: string, options: RequestInit): Promise<Response> => {
    const response = await fetcher(url, options);
    if (response.status !== 401 || url === '/api/login' || url === '/api/logout') return response;
    const session = await connect();
    return session.ok ? fetcher(url, options) : session;
  };
}
