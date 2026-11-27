export const GLOBAL_BODY_LIMIT = "1mb";
export const ACTIVITYPUB_BODY_LIMIT = "1mb";

export const ACTIVITYPUB_JSON_TYPES = Object.freeze([
    "application/activity+json",
    "application/ld+json",
    "application/json",
]);

const ACTIVITYPUB_INBOX_PATH = /^\/(?:ap|\.well-known)\/(?:inbox|users\/[^/]+\/inbox)\/?$/i;

export function isActivityPubInboxRequest(req) {
    const requestPath = `${req.baseUrl || ""}${req.path || ""}`;
    return req.method?.toUpperCase() === "POST"
        && ACTIVITYPUB_INBOX_PATH.test(requestPath);
}

export function shouldParseGlobalJson(req) {
    return !isActivityPubInboxRequest(req) && Boolean(req.is("application/json"));
}

export function captureActivityPubRawBody(req, _res, buffer) {
    if (isActivityPubInboxRequest(req)) {
        req.rawBody = buffer;
    }
}
