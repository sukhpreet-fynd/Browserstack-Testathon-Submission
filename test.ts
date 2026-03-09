/**
 * Recursively find first substantial string in an object (max depth 5).
 * Used as fallback when known payload shapes don't match.
 */
function extractAnyText(obj: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (obj == null) return '';
  if (typeof obj === 'string') {
    const s = obj.trim();
    return s.length > 0 ? s : '';
  }
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i--) {
      const v = extractAnyText(obj[i], depth + 1);
      if (v) return v;
    }
    return '';
  }
  if (typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    const keys = ['content', 'message', 'text', 'reply', 'output', 'response', 'data', 'body', 'result', 'output_text', 'message_content', 'delta', 'chunk'];
    for (const k of keys) {
      if (o[k] !== undefined) {
        const v = extractAnyText(o[k], depth + 1);
        if (v) return v;
      }
    }
    for (const k of Object.keys(o)) {
      const v = extractAnyText(o[k], depth + 1);
      if (v) return v;
    }
  }
  return '';
}

/**
 * Get reply text from Socket.IO response payload.
 * Handles various shapes: messages array, content string, or nested data.
 */
export function getReplyTextFromSocketData(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload.trim();
  if (Array.isArray(payload)) {
    const parts = payload.map((item) => getReplyTextFromSocketData(item)).filter(Boolean);
    return parts.join('').trim() || '';
  }

  const p = payload as Record<string, unknown>;
  // Top-level content / message / text (some backends send these)
  if (typeof p.content === 'string') return (p.content as string).trim();
  if (typeof p.message === 'string') return (p.message as string).trim();
  if (typeof p.text === 'string') return (p.text as string).trim();
  if (typeof p.reply === 'string') return (p.reply as string).trim();
  if (typeof p.output === 'string') return (p.output as string).trim();
  if (typeof p.response === 'string') return (p.response as string).trim();
  if (typeof p.delta === 'string') return (p.delta as string).trim();
  if (typeof p.chunk === 'string') return (p.chunk as string).trim();
  if (typeof p.answer === 'string') return (p.answer as string).trim();
  if (typeof p.result === 'string') return (p.result as string).trim();
  const choices = p.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices[0]?.message && typeof (choices[0].message as Record<string, unknown>).content === 'string') {
    return ((choices[0].message as Record<string, unknown>).content as string).trim();
  }
  // content as array of parts: [{ type: 'text', text: '...' }] or [{ content: '...' }]
  const contentArr = p.content as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contentArr)) {
    for (let i = contentArr.length - 1; i >= 0; i--) {
      const part = contentArr[i];
      if (part && typeof part.text === 'string') return (part.text as string).trim();
      if (part && typeof part.content === 'string') return (part.content as string).trim();
    }
  }

  const data = p.data;
  if (data == null) return extractAnyText(p);
  if (typeof data === 'string') return (data as string).trim();

  const d = data as Record<string, unknown>;
  if (typeof d.content === 'string') return (d.content as string).trim();
  if (typeof d.message === 'string') return (d.message as string).trim();
  if (typeof d.text === 'string') return (d.text as string).trim();
  if (typeof d.reply === 'string') return (d.reply as string).trim();
  if (typeof d.answer === 'string') return (d.answer as string).trim();
  if (Array.isArray(d.messages)) {
    const list = d.messages as Array<Record<string, unknown>>;
    const parts = list.map((m) => (m?.content != null ? String(m.content) : '')).filter(Boolean);
    if (parts.length) return parts.join('').trim();
    const last = list[list.length - 1];
    if (last && typeof (last as Record<string, unknown>).text === 'string') return ((last as Record<string, unknown>).text as string).trim();
    if (last) return extractAnyText(last);
  }
  // data.content as array
  const dContentArr = d.content as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(dContentArr)) {
    for (let i = dContentArr.length - 1; i >= 0; i--) {
      const part = dContentArr[i];
      if (part && typeof part.text === 'string') return (part.text as string).trim();
      if (part && typeof part.content === 'string') return (part.content as string).trim();
    }
  }
  const fromData = extractAnyText(data);
  if (fromData) return fromData;
  return extractAnyText(p);
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NAMESPACE = '/v1/conversations';

export interface ConnectAndQueryParams {
  baseUrl: string;
  appToken: string;
  surfaceClient: string;
  session: string;
  text: string;
  path: string;
  orgId?: string;
  organization?: string;
}

export interface ConnectAndQueryResult {
  reply: string;
  error?: string;
}

/**
 * Extract reply text from payload with data.messages or messages (reference shape).
 */
function getReplyFromMessagesPayload(data: unknown): string {
  if (data == null || typeof data !== 'object') return '';
  const p = data as Record<string, unknown>;
  const messages = (p?.data as Record<string, unknown>)?.messages ?? p?.messages;
  if (!Array.isArray(messages)) return '';
  return messages.map((m: Record<string, unknown>) => (m?.content != null ? String(m.content) : '')).join('').trim();
}

/**
 * Connect to Copilot via Socket.IO (WebSocket).
 * - When Platform token (session) is set: connect to root with client=platform and platform=base64(Bearer JWT), like Fynd console.
 * - Otherwise: connect to namespace /v1/conversations with server-provided event_name from copilot:query callback.
 */
export async function connectAndQueryDirect(params: ConnectAndQueryParams): Promise<ConnectAndQueryResult> {
  const { baseUrl, appToken, surfaceClient, session, text, path, orgId, organization } = params;
  const { io } = await import('socket.io-client');

  const url = (baseUrl || '').replace(/\/+$/, '');
  const parsed = url.startsWith('http') ? new URL(url) : new URL('https://' + url.replace(/^\/+/, ''));
  const origin = parsed.origin;
  const socketPath = parsed.pathname === '/' || parsed.pathname === '' ? '/socket.io' : `${parsed.pathname.replace(/\/?$/, '')}/socket.io`;

  const token = typeof appToken === 'string' ? appToken.trim() : '';
  const sessionStr = session && String(session).trim() ? String(session).trim() : '';
  const bearerValue = sessionStr ? (sessionStr.toLowerCase().startsWith('bearer ') ? sessionStr : `Bearer ${sessionStr}`) : '';

  const isPlatformMode = !!bearerValue;
  const client = typeof surfaceClient === 'string' ? surfaceClient.trim() : (isPlatformMode ? 'platform' : 'web');

  let connectUrl: string;
  const query: Record<string, string> = { token, client };

  if (isPlatformMode) {
    connectUrl = origin;
    const platformParam =
      typeof Buffer !== 'undefined'
        ? Buffer.from(bearerValue, 'utf8').toString('base64')
        : (() => {
            try {
              return btoa(bearerValue);
            } catch {
              return '';
            }
          })();
    if (platformParam) query.platform = platformParam;
  } else {
    const namespace = typeof process !== 'undefined' ? (process.env.NEXT_PUBLIC_COPILOT_NAMESPACE ?? DEFAULT_NAMESPACE) : DEFAULT_NAMESPACE;
    connectUrl = origin + namespace;
    if (orgId?.trim()) query.orgId = orgId.trim();
    if (organization?.trim()) query.organization = organization.trim();
  }

  const isDev = typeof process !== 'undefined' && process.env.NODE_ENV === 'development';
  if (isDev) {
    console.log('[Copilot] Connecting to', connectUrl, 'path:', socketPath, '| client:', client, isPlatformMode ? '| platform mode' : '');
  }

  return new Promise((resolve) => {
    const socket = io(connectUrl, {
      path: socketPath,
      query,
      transports: ['websocket'],
      timeout: DEFAULT_TIMEOUT_MS,
      withCredentials: true,
      ...(!isPlatformMode && bearerValue && { auth: { token: bearerValue } }),
    });

    const doResolve = (reply: string, err?: string) => {
      clearTimeout(timeoutId);
      socket.removeAllListeners();
      socket.disconnect();
      resolve({ reply: reply.trim(), error: err });
    };

    const timeoutId = setTimeout(() => {
      if (isDev) console.warn('[Copilot] Timeout after', DEFAULT_TIMEOUT_MS, 'ms');
      doResolve(accumulatedReply || '', accumulatedReply ? undefined : 'Copilot timeout (30s)');
    }, DEFAULT_TIMEOUT_MS);

    let accumulatedReply = '';

    socket.on('connect_error', (err: Error) => {
      if (isDev) {
        console.error('[Copilot] connect_error', err?.message, err);
        console.warn('[Copilot] If connection fails from browser (CORS), set NEXT_PUBLIC_USE_COPILOT_PROXY=true in .env.local and restart.');
      }
      doResolve('', err?.message || 'Connection failed');
    });

    socket.on('connect', () => {
      if (isDev) console.log('[Copilot] Connected, emitting copilot:query');
      socket.emit(
        'copilot:query',
        { text, path: path || '/', tools: [], context: {} },
        (response: { error?: unknown; event_name?: string; delta_event_name?: string }) => {
          if (response?.error) {
            const errMsg = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
            if (isDev) console.error('[Copilot] Ack error', errMsg);
            doResolve('', errMsg);
            return;
          }
          const replyEventName = response?.event_name ?? '';
          const deltaEventName = response?.delta_event_name ?? '';

          if (replyEventName) {
            if (deltaEventName) {
              socket.on(deltaEventName, (deltaPayload: unknown) => {
                const chunk = getReplyTextFromSocketData(deltaPayload) || getReplyFromMessagesPayload(deltaPayload);
                if (chunk) accumulatedReply += chunk;
              });
            }
            socket.once(replyEventName, (data: unknown) => {
              const reply = getReplyFromMessagesPayload(data) || getReplyTextFromSocketData(data) || accumulatedReply;
              doResolve(reply);
            });
            return;
          }

          if (isPlatformMode) {
            const replyEvents = ['reply', 'copilot:reply', 'copilot:message', 'message', 'copilot:response', 'response', 'copilot:done', 'done'];
            const deltaEvents = ['delta', 'copilot:delta'];
            deltaEvents.forEach((ev) => {
              socket.on(ev, (deltaPayload: unknown) => {
                const chunk = getReplyTextFromSocketData(deltaPayload) || getReplyFromMessagesPayload(deltaPayload);
                if (chunk) accumulatedReply += chunk;
              });
            });
            replyEvents.forEach((ev) => {
              socket.once(ev, (data: unknown) => {
                const reply = getReplyFromMessagesPayload(data) || getReplyTextFromSocketData(data) || accumulatedReply;
                if (reply.trim()) doResolve(reply);
              });
            });
            if (isDev) console.log('[Copilot] No event_name in ack, listening for', replyEvents.join(', '));
            return;
          }

          doResolve('', 'No reply event name in response');
        }
      );
    });
  });
}

/**
 * Connect to Copilot via WebSocket (Socket.IO) and send one query; return reply or error.
 * Uses proxy when NEXT_PUBLIC_USE_COPILOT_PROXY=true or when hostname looks like ngrok (avoids "Invalid Domain").
 */
export async function connectAndQuery(params: ConnectAndQueryParams): Promise<ConnectAndQueryResult> {
  const useProxy =
    typeof window !== 'undefined' &&
    (process.env.NEXT_PUBLIC_USE_COPILOT_PROXY === 'true' ||
      process.env.NEXT_PUBLIC_USE_COPILOT_PROXY === '1' ||
      /\.ngrok-free\.app$/i.test(window.location.hostname) ||
      /\.ngrok/i.test(window.location.hostname));

  if (useProxy) {
    try {
      const res = await fetch('/api/copilot-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { reply: '', error: json.error || res.statusText || 'Proxy request failed' };
      }
      return {
        reply: json.reply ?? '',
        error: json.error,
      };
    } catch (err) {
      return { reply: '', error: err instanceof Error ? err.message : 'Proxy request failed' };
    }
  }

  return connectAndQueryDirect(params);
}
