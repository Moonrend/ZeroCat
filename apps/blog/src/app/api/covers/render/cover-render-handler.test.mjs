import assert from "node:assert/strict";
import test from "node:test";
import {
  createCoverRenderHandler,
  extractBearerToken,
} from "./cover-render-handler.ts";

const VALID_PAYLOAD = {
  title: "A bounded article",
  summary: "A short summary",
  content: "A short body",
  slug: "bounded-article",
};

function requestFor(payload) {
  return new Request("http://localhost/api/covers/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("requires a validated author before rendering", async () => {
  let renderCalls = 0;
  const handler = createCoverRenderHandler({
    authenticate: async () => null,
    render: async () => {
      renderCalls += 1;
      return "data:image/svg+xml,unexpected";
    },
  });

  const response = await handler(requestFor(VALID_PAYLOAD));

  assert.equal(response.status, 401);
  assert.equal(renderCalls, 0);
});

test("accepts only a bounded bearer token", () => {
  assert.equal(extractBearerToken("Bearer author-token"), "author-token");
  assert.equal(extractBearerToken("Basic author-token"), null);
  assert.equal(extractBearerToken("Bearer token with spaces"), null);
  assert.equal(extractBearerToken(`Bearer ${"x".repeat(4_097)}`), null);
});

test("rejects oversized bodies and fields before rendering", async (t) => {
  let renderCalls = 0;
  const common = {
    authenticate: async () => ({ id: "author-7" }),
    render: async () => {
      renderCalls += 1;
      return "data:image/svg+xml,unexpected";
    },
  };

  await t.test("streamed body limit", async () => {
    const handler = createCoverRenderHandler({
      ...common,
      limits: { maxBodyBytes: 48 },
    });
    const response = await handler(requestFor(VALID_PAYLOAD));
    assert.equal(response.status, 413);
  });

  await t.test("content character limit", async () => {
    const handler = createCoverRenderHandler({
      ...common,
      limits: { maxContentCharacters: 4 },
    });
    const response = await handler(
      requestFor({ ...VALID_PAYLOAD, content: "12345" })
    );
    assert.equal(response.status, 400);
  });

  assert.equal(renderCalls, 0);
});

test("preserves an authenticated bounded render", async () => {
  let renderedPayload;
  const handler = createCoverRenderHandler({
    authenticate: async () => ({ id: "author-7" }),
    render: async (payload) => {
      renderedPayload = payload;
      return "data:image/svg+xml,expected";
    },
  });

  const response = await handler(requestFor(VALID_PAYLOAD));

  assert.equal(response.status, 200);
  assert.deepEqual(renderedPayload, VALID_PAYLOAD);
  assert.deepEqual(await response.json(), {
    dataUrl: "data:image/svg+xml,expected",
  });
});

test("rate limits each authenticated author", async () => {
  let renderCalls = 0;
  const handler = createCoverRenderHandler({
    authenticate: async () => ({ id: "author-7" }),
    render: async () => {
      renderCalls += 1;
      return `data:image/svg+xml,${renderCalls}`;
    },
    limits: { maxRequestsPerWindow: 1 },
  });

  const first = await handler(requestFor(VALID_PAYLOAD));
  const second = await handler(
    requestFor({ ...VALID_PAYLOAD, title: "A second article" })
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(renderCalls, 1);
});

test("bounds concurrent distinct renders", async () => {
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const handler = createCoverRenderHandler({
    authenticate: async () => ({ id: "author-7" }),
    render: async (payload) => {
      if (payload.title === VALID_PAYLOAD.title) {
        markStarted();
        await firstGate;
      }
      return `data:image/svg+xml,${payload.title}`;
    },
    limits: { maxConcurrentRenders: 1 },
  });

  const firstResponse = handler(requestFor(VALID_PAYLOAD));
  await started;
  const overloaded = await handler(
    requestFor({ ...VALID_PAYLOAD, title: "A concurrent article" })
  );
  releaseFirst();

  assert.equal(overloaded.status, 429);
  assert.equal((await firstResponse).status, 200);
});

test("deduplicates and caches identical renders", async () => {
  let renderCalls = 0;
  const handler = createCoverRenderHandler({
    authenticate: async () => ({ id: "author-7" }),
    render: async () => {
      renderCalls += 1;
      return "data:image/svg+xml,cached";
    },
  });

  const first = await handler(requestFor(VALID_PAYLOAD));
  const second = await handler(requestFor(VALID_PAYLOAD));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(renderCalls, 1);
});
