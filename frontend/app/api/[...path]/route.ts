import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const apiOriginValue = process.env.MAYA_API_ORIGIN || "http://127.0.0.1:3000";
const apiOrigin = new URL(apiOriginValue);
if (
  !["http:", "https:"].includes(apiOrigin.protocol)
  || apiOrigin.username
  || apiOrigin.password
  || apiOrigin.pathname !== "/"
  || apiOrigin.search
  || apiOrigin.hash
) {
  throw new Error("MAYA_API_ORIGIN must be an HTTP(S) origin without credentials or a path.");
}

if (!["http:", "https:"].includes(apiOrigin.protocol) || apiOrigin.username || apiOrigin.password) {
  throw new Error("MAYA_API_ORIGIN must be an HTTP(S) URL without embedded credentials.");
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const destination = new URL(`/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}`, apiOrigin);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const authorization = request.headers.get("authorization");
  const accept = request.headers.get("accept");
  if (contentType) headers.set("content-type", contentType);
  if (authorization) headers.set("authorization", authorization);
  if (accept) headers.set("accept", accept);

  try {
    const body = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      signal: request.signal,
    });
    const responseHeaders = new Headers();
    for (const header of ["content-type", "cache-control", "retry-after"]) {
      const value = upstream.headers.get(header);
      if (value) responseHeaders.set(header, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "The Maya API is unavailable. Check that the Express server is running." }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
