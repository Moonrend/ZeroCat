export type ArticleCoverInput = {
  title: string;
  summary?: string | null;
  content?: string | null;
  slug?: string | null;
};

export type ArticleCoverRenderPayload = {
  title: string;
  summary: string;
  content: string;
  slug: string;
};

const MAX_TITLE_CHARACTERS = 160;
const MAX_SLUG_CHARACTERS = 200;
const MAX_EXCERPT_LINES = 3;
const MAX_EXCERPT_LINE_CHARACTERS = 34;

type MarkdownState = {
  inFence: boolean;
};

function truncateLine(value: string) {
  if (value.length <= MAX_EXCERPT_LINE_CHARACTERS) return value;
  return `${value.slice(0, MAX_EXCERPT_LINE_CHARACTERS).trimEnd()}...`;
}

function stripFencedSegments(value: string, state: MarkdownState) {
  let cursor = 0;
  let visible = "";

  while (cursor <= value.length) {
    if (state.inFence) {
      const closingFence = value.indexOf("```", cursor);
      if (closingFence === -1) return visible;
      state.inFence = false;
      cursor = closingFence + 3;
      continue;
    }

    const openingFence = value.indexOf("```", cursor);
    if (openingFence === -1) return visible + value.slice(cursor);
    visible += value.slice(cursor, openingFence);
    state.inFence = true;
    cursor = openingFence + 3;
  }

  return visible;
}

function cleanMarkdownLine(value: string, state: MarkdownState) {
  return stripFencedSegments(value.replace(/\r/g, ""), state)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^>\s?/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/[\*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function visitLines(value: string, visitor: (line: string) => boolean) {
  let start = 0;

  while (start <= value.length) {
    const newline = value.indexOf("\n", start);
    const end = newline === -1 ? value.length : newline;
    if (!visitor(value.slice(start, end))) return;
    if (newline === -1) return;
    start = newline + 1;
  }
}

export function pickArticleCoverExcerptLines(input: ArticleCoverInput) {
  const lines: string[] = [];
  const state: MarkdownState = { inFence: false };
  const collectSummary = (rawLine: string) => {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line) lines.push(truncateLine(line));
    return lines.length < MAX_EXCERPT_LINES;
  };
  const collectContent = (rawLine: string) => {
    const line = cleanMarkdownLine(rawLine, state);
    if (line) lines.push(truncateLine(line));
    return lines.length < MAX_EXCERPT_LINES;
  };

  visitLines(input.summary || "", collectSummary);
  if (lines.length < MAX_EXCERPT_LINES) {
    visitLines(input.content || "", collectContent);
  }

  return lines;
}

export function compactArticleCoverPayload(
  input: ArticleCoverInput
): ArticleCoverRenderPayload {
  const title = (input.title || "未命名文章").trim() || "未命名文章";
  const slug = (input.slug || "zerocat-blog").trim() || "zerocat-blog";

  return {
    title: title.slice(0, MAX_TITLE_CHARACTERS),
    summary: pickArticleCoverExcerptLines(input).join("\n"),
    content: "",
    slug: slug.slice(0, MAX_SLUG_CHARACTERS),
  };
}
