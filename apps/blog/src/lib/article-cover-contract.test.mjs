import assert from "node:assert/strict";
import test from "node:test";
import {
  compactArticleCoverPayload,
  pickArticleCoverExcerptLines,
} from "./article-cover-contract.ts";

test("keeps the same visible excerpt", () => {
  const input = {
    title: "Article title",
    summary: "",
    content: "# First line\n\nSecond line\nThird line\nFourth line",
    slug: "article-title",
  };

  const expected = ["First line", "Second line", "Third line"];
  const compact = compactArticleCoverPayload(input);

  assert.deepEqual(pickArticleCoverExcerptLines(input), expected);
  assert.deepEqual(pickArticleCoverExcerptLines(compact), expected);
  assert.equal(compact.content, "");
});

test("stops after three non-code lines", () => {
  const lines = pickArticleCoverExcerptLines({
    title: "Article title",
    content: "```ts\nconst hidden = true;\n```\nVisible one\nVisible two\nVisible three\nIgnored",
  });

  assert.deepEqual(lines, ["Visible one", "Visible two", "Visible three"]);
});

test("compacts client fields within route bounds", () => {
  const compact = compactArticleCoverPayload({
    title: "t".repeat(200),
    summary: "Summary line",
    content: "Content line",
    slug: "s".repeat(240),
  });

  assert.equal(compact.title.length, 160);
  assert.equal(compact.slug.length, 200);
  assert.equal(compact.summary, "Summary line\nContent line");
});
