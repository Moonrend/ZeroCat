import { renderArticleCoverDataUrl } from "@/lib/article-cover-render";
import { API_URL } from "@/lib/api";
import {
  createCoverRenderHandler,
  extractBearerToken,
  type AuthenticatedCoverAuthor,
} from "./cover-render-handler";

type AuthoringSessionResponse = {
  data?: { id?: number | string };
};

const AUTH_TIMEOUT_MS = 5_000;

async function authenticateCoverAuthor(
  request: Request
): Promise<AuthenticatedCoverAuthor | null> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) return null;

  try {
    const response = await fetch(`${API_URL}/blog/authoring-session`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const payload = (await response.json().catch(() => null)) as
      | AuthoringSessionResponse
      | null;
    const rawId = payload?.data?.id;
    const id = typeof rawId === "number" ? String(rawId) : rawId?.trim() || "";
    if (!/^[1-9]\d*$/.test(id) || id.length > 32) return null;
    return { id };
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = createCoverRenderHandler({
  authenticate: authenticateCoverAuthor,
  render: renderArticleCoverDataUrl,
});
