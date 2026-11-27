import { z } from "zod";

export type CoverRenderPayload = {
  title: string;
  summary: string;
  content: string;
  slug: string;
};

export type AuthenticatedCoverAuthor = {
  id: string;
};

type CoverRenderLimits = {
  maxBodyBytes: number;
  maxTitleCharacters: number;
  maxSummaryCharacters: number;
  maxContentCharacters: number;
  maxSlugCharacters: number;
  maxConcurrentRenders: number;
  maxRequestsPerWindow: number;
  rateWindowMs: number;
  maxCacheEntries: number;
  maxTrackedAuthors: number;
};

export const COVER_RENDER_LIMITS: CoverRenderLimits = Object.freeze({
  maxBodyBytes: 64 * 1024,
  maxTitleCharacters: 160,
  maxSummaryCharacters: 800,
  maxContentCharacters: 12_000,
  maxSlugCharacters: 200,
  maxConcurrentRenders: 2,
  maxRequestsPerWindow: 20,
  rateWindowMs: 60_000,
  maxCacheEntries: 32,
  maxTrackedAuthors: 1_000,
});

type HandlerDependencies = {
  authenticate: (request: Request) => Promise<AuthenticatedCoverAuthor | null>;
  render: (payload: CoverRenderPayload) => Promise<string>;
  now?: () => number;
  limits?: Partial<CoverRenderLimits>;
};

type RateWindow = {
  count: number;
  startedAt: number;
};

class BodyReadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {}
) {
  return Response.json(body, {
    status,
    headers: { ...RESPONSE_HEADERS, ...headers },
  });
}

export function extractBearerToken(value: string | null) {
  if (!value) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  const token = match?.[1] || "";
  return token && token.length <= 4_096 ? token : null;
}

async function readBoundedJson(request: Request, maxBodyBytes: number) {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new BodyReadError(415, "Content-Type must be application/json");
  }

  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new BodyReadError(415, "Encoded request bodies are not supported");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength.trim())) {
      throw new BodyReadError(400, "Invalid Content-Length");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maxBodyBytes) {
      throw new BodyReadError(413, "Request body is too large");
    }
  }

  if (!request.body) throw new BodyReadError(400, "Request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyReadError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new BodyReadError(400, "Request body must be valid UTF-8 JSON");
  }
}

function createPayloadSchema(limits: CoverRenderLimits) {
  return z
    .object({
      title: z.string().trim().min(1).max(limits.maxTitleCharacters),
      summary: z.string().max(limits.maxSummaryCharacters).optional().default(""),
      content: z.string().max(limits.maxContentCharacters).optional().default(""),
      slug: z
        .string()
        .trim()
        .max(limits.maxSlugCharacters)
        .optional()
        .default("zerocat-blog"),
    })
    .strict();
}

export function createCoverRenderHandler(dependencies: HandlerDependencies) {
  const limits = { ...COVER_RENDER_LIMITS, ...dependencies.limits };
  const payloadSchema = createPayloadSchema(limits);
  const rateWindows = new Map<string, RateWindow>();
  const completedRenders = new Map<string, string>();
  const pendingRenders = new Map<string, Promise<string>>();
  const now = dependencies.now || Date.now;
  let activeRenders = 0;

  function consumeRateLimit(authorId: string) {
    const currentTime = now();
    const existing = rateWindows.get(authorId);
    if (!existing || currentTime - existing.startedAt >= limits.rateWindowMs) {
      if (!existing && rateWindows.size >= limits.maxTrackedAuthors) {
        for (const [key, window] of rateWindows) {
          if (currentTime - window.startedAt >= limits.rateWindowMs) {
            rateWindows.delete(key);
          }
        }
        while (rateWindows.size >= limits.maxTrackedAuthors) {
          const oldestKey = rateWindows.keys().next().value as string | undefined;
          if (!oldestKey) break;
          rateWindows.delete(oldestKey);
        }
      }
      rateWindows.set(authorId, { count: 1, startedAt: currentTime });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (existing.count >= limits.maxRequestsPerWindow) {
      const remainingMs = limits.rateWindowMs - (currentTime - existing.startedAt);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
      };
    }

    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function cacheResult(key: string, dataUrl: string) {
    if (limits.maxCacheEntries <= 0) return;
    completedRenders.delete(key);
    completedRenders.set(key, dataUrl);
    while (completedRenders.size > limits.maxCacheEntries) {
      const oldestKey = completedRenders.keys().next().value as string | undefined;
      if (!oldestKey) break;
      completedRenders.delete(oldestKey);
    }
  }

  async function renderWithAdmission(
    authorId: string,
    payload: CoverRenderPayload
  ) {
    const cacheKey = JSON.stringify([authorId, payload]);
    const cached = completedRenders.get(cacheKey);
    if (cached !== undefined) {
      completedRenders.delete(cacheKey);
      completedRenders.set(cacheKey, cached);
      return cached;
    }

    const pending = pendingRenders.get(cacheKey);
    if (pending) return pending;

    if (activeRenders >= limits.maxConcurrentRenders) {
      throw new BodyReadError(429, "Cover renderer is busy");
    }

    activeRenders += 1;
    const renderPromise = Promise.resolve()
      .then(() => dependencies.render(payload))
      .then((dataUrl) => {
        if (!dataUrl.startsWith("data:image/svg+xml")) {
          throw new Error("Unexpected cover render output");
        }
        cacheResult(cacheKey, dataUrl);
        return dataUrl;
      })
      .finally(() => {
        activeRenders -= 1;
        pendingRenders.delete(cacheKey);
      });
    pendingRenders.set(cacheKey, renderPromise);
    return renderPromise;
  }

  return async function handleCoverRender(request: Request) {
    let author: AuthenticatedCoverAuthor | null = null;
    try {
      author = await dependencies.authenticate(request);
    } catch {
      author = null;
    }

    const authorId = author?.id.trim() || "";
    if (!authorId || authorId.length > 128) {
      return jsonResponse({ message: "Unauthorized" }, 401);
    }

    const rateLimit = consumeRateLimit(authorId);
    if (!rateLimit.allowed) {
      return jsonResponse(
        { message: "Too many cover render requests" },
        429,
        { "Retry-After": String(rateLimit.retryAfterSeconds) }
      );
    }

    let json: unknown;
    try {
      json = await readBoundedJson(request, limits.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyReadError) {
        return jsonResponse({ message: error.message }, error.status);
      }
      return jsonResponse({ message: "头图生成失败" }, 400);
    }

    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) {
      return jsonResponse({ message: "头图生成失败" }, 400);
    }

    try {
      const dataUrl = await renderWithAdmission(authorId, parsed.data);
      return jsonResponse({ dataUrl });
    } catch (error) {
      if (error instanceof BodyReadError) {
        return jsonResponse(
          { message: error.message },
          error.status,
          { "Retry-After": "1" }
        );
      }
      return jsonResponse({ message: "头图生成失败" }, 400);
    }
  };
}
