import assert from "node:assert/strict";
import test from "node:test";
import {
    ACTIVITYPUB_BODY_LIMIT,
    ACTIVITYPUB_JSON_TYPES,
    GLOBAL_BODY_LIMIT,
    captureActivityPubRawBody,
    isActivityPubInboxRequest,
    shouldParseGlobalJson,
} from "./requestBody.js";

function jsonRequest(method, path, contentType = "application/json") {
    return {
        method,
        path,
        is(expected) {
            return expected === "application/json" && contentType === expected
                ? expected
                : false;
        },
    };
}

test("global and ActivityPub body budgets stay bounded", () => {
    assert.equal(GLOBAL_BODY_LIMIT, "1mb");
    assert.equal(ACTIVITYPUB_BODY_LIMIT, "1mb");
});

test("only exact ActivityPub inbox POST paths bypass global JSON parsing", () => {
    for (const path of [
        "/ap/inbox",
        "/ap/inbox/",
        "/AP/INBOX",
        "/ap/users/alice/inbox",
        "/ap/users/alice/inbox/",
        "/.well-known/inbox",
        "/.well-known/users/alice/inbox",
    ]) {
        const req = jsonRequest("POST", path);
        assert.equal(isActivityPubInboxRequest(req), true, path);
        assert.equal(shouldParseGlobalJson(req), false, path);
    }

    for (const [method, path] of [
        ["GET", "/ap/inbox"],
        ["POST", "/ap/inbox/archive"],
        ["POST", "/ap/users/alice/outbox"],
        ["POST", "/api/inbox"],
    ]) {
        const req = jsonRequest(method, path);
        assert.equal(isActivityPubInboxRequest(req), false, `${method} ${path}`);
        assert.equal(shouldParseGlobalJson(req), true, `${method} ${path}`);
    }
});

test("ordinary JSON content keeps global parsing behavior", () => {
    assert.equal(shouldParseGlobalJson(jsonRequest("POST", "/account/login")), true);
    assert.equal(
        shouldParseGlobalJson(jsonRequest("POST", "/account/login", "text/plain")),
        false,
    );
});

test("ActivityPub parser accepts protocol JSON and preserves exact bytes", () => {
    assert.deepEqual(ACTIVITYPUB_JSON_TYPES, [
        "application/activity+json",
        "application/ld+json",
        "application/json",
    ]);

    const body = Buffer.from('{"type":"Follow"}');
    for (const baseUrl of ["/ap", "/.well-known"]) {
        for (const path of ["/inbox", "/users/alice/inbox"]) {
            const inbox = jsonRequest("POST", path, "application/activity+json");
            inbox.baseUrl = baseUrl;
            captureActivityPubRawBody(inbox, {}, body);
            assert.equal(inbox.rawBody, body, `${baseUrl}${path}`);
        }
    }

    const management = jsonRequest("POST", "/admin/setup", "application/activity+json");
    management.baseUrl = "/ap";
    captureActivityPubRawBody(management, {}, body);
    assert.equal(management.rawBody, undefined);
});
