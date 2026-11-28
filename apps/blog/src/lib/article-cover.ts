import {
  compactArticleCoverPayload,
  type ArticleCoverInput,
} from "./article-cover-contract";

export type { ArticleCoverInput } from "./article-cover-contract";

export async function generateArticleCoverDataUrl(
  input: ArticleCoverInput,
  token: string,
  signal?: AbortSignal
) {
  if (!token.trim()) throw new Error("未登录");

  const response = await fetch("/api/covers/render", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(compactArticleCoverPayload(input)),
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error("头图生成失败");
  }

  const data = (await response.json()) as { dataUrl?: string };
  if (!data.dataUrl) {
    throw new Error("头图生成失败");
  }

  return data.dataUrl;
}
