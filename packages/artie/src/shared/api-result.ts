import type { Response } from 'express';

/**
 * What a route handler used to put on the wire, as a value: the HTTP status and the JSON body
 * (wave 9). Each external route's handler body is a function returning one of these; the
 * express route sends it with `sendResult`, and in-process callers (which used to fetch the
 * same route over loopback) read `.status` / `.body` where they read `response.status` /
 * `await response.json()`. One implementation, so the HTTP contract and the internal call
 * cannot drift apart.
 */
export interface ApiResult<T = any> {
  status: number;
  body: T;
}

/** `response.ok`, for an ApiResult. */
export function isOk(result: ApiResult): boolean {
  return result.status >= 200 && result.status < 300;
}

/** `res.status(status).json(body)` — exactly what the handler did before it was extracted. */
export function sendResult(res: Response, result: ApiResult): void {
  res.status(result.status).json(result.body);
}
