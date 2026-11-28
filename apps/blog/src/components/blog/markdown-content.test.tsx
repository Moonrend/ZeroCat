import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./markdown-content";

test("raw HTML remains inert while surrounding Markdown renders", () => {
  const rendered = renderToStaticMarkup(
    <MarkdownContent source={"**before**\n\n<section>raw HTML</section>\n\n_after_"} />
  );

  assert.doesNotMatch(rendered, /<section(?:\s|>)/i);
  assert.match(rendered, /<strong>before<\/strong>/);
  assert.match(rendered, /<em>after<\/em>/);
});

test("supported Markdown formatting remains available", () => {
  const rendered = renderToStaticMarkup(
    <MarkdownContent
      source={"# Heading\n\n[link](https://example.com)\n\n| A | B |\n| - | - |\n| 1 | 2 |"}
    />
  );

  assert.match(rendered, /<h1[^>]+id="heading"/);
  assert.match(rendered, /<a[^>]+href="https:\/\/example\.com"/);
  assert.match(rendered, /<table/);
  assert.match(rendered, /<td[^>]*>1<\/td>/);
});
