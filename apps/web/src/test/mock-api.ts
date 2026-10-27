import { vi } from 'vitest';

/**
 * Stub `fetch` with one response per route, keyed by `'<METHOD> <path without /api>'`.
 * Values are JSON bodies (status 200), or a `Response` for anything else (see `unauthorized()`).
 * Unmocked routes answer 404. Undo with `vi.unstubAllGlobals()`.
 */
export function mockApi(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (request: Request) => {
    const key = `${request.method} ${new URL(request.url).pathname.replace(/^\/api/, '')}`;
    if (!(key in routes)) return Response.json({ message: `No mock for ${key}` }, { status: 404 });

    const value = routes[key];
    return value instanceof Response ? value.clone() : Response.json(value);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** The 401 the API sends for a missing session or a wrong password. */
export function unauthorized(message = 'Unauthorized') {
  return Response.json(
    { defined: false, code: 'UNAUTHORIZED', status: 401, message },
    { status: 401 },
  );
}

/** The 409 the API sends when a unique code (store/supplier) is already taken. */
export function conflict(message = 'Conflict') {
  return Response.json({ defined: false, code: 'CONFLICT', status: 409, message }, { status: 409 });
}
