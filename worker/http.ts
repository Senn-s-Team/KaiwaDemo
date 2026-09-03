const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init.headers,
    },
  })
}

export function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status })
}

export function methodNotAllowed(allowed: string): Response {
  return new Response(null, {
    status: 405,
    headers: { allow: allowed, 'cache-control': 'no-store' },
  })
}

export function assertSameOriginRequest(request: Request): Response | null {
  const site = request.headers.get('sec-fetch-site')
  if (site === 'cross-site') {
    return errorJson(403, 'cross_site_request', 'Cross-site API requests are not allowed.')
  }
  return null
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new RequestBodyError(415, 'content_type', 'Expected application/json.')
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (declaredLength > maxBytes) {
    throw new RequestBodyError(413, 'request_too_large', 'Request body exceeds the prototype limit.')
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestBodyError(413, 'request_too_large', 'Request body exceeds the prototype limit.')
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RequestBodyError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
}

export class RequestBodyError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
