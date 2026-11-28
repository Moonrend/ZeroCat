import assert from "node:assert/strict";
import {beforeEach, mock, test} from "node:test";

const state = {};
const routes = [];
const router = {
    post(path, ...handlers) { routes.push({method: "post", path, handlers}); },
    use() {},
};
const noop = () => {};
const needLogin = (_req, _res, next) => next();
const scopeGuard = (_req, _res, next) => next();

mock.module("express", {namedExports: {Router: () => router}});
mock.module("multer", {defaultExport: Object.assign(() => ({single: () => noop}), {memoryStorage: () => ({})})});
mock.module("../services/logger.js", {defaultExport: {debug: noop, error: noop, info: noop, warn: noop}});
mock.module("../services/global.js", {namedExports: {
    checkhash: noop,
    hash: noop,
    S3update: noop,
    validateUsername: () => ({valid: true}),
}});
mock.module("../services/assets.js", {namedExports: {validateFileTypeFromContent: noop, uploadFile: noop}});
mock.module("../middleware/auth.js", {namedExports: {needLogin}});
mock.module("../middleware/scope.js", {namedExports: {requireScope(required) {
    state.requiredScopes.push(required);
    return scopeGuard;
}}});
mock.module("../middleware/sudo.js", {namedExports: {requireSudo: noop}});
mock.module("../services/moderation/visibility.js", {namedExports: {async assertCanWrite(userId, category, action) {
    state.writeChecks.push({userId, category, action});
    if (state.restrictionError) throw state.restrictionError;
}}});
mock.module("../services/prisma.js", {namedExports: {prisma: {
    ow_projects: {async findFirst(args) { state.projectReads.push(args); return {id: args.where.id}; }},
    ow_users: {async update(args) { state.userUpdates.push(args); return args.data; }, async findFirst() { return null; }, async findUnique() { return null; }},
}}});
mock.module("../controllers/events.js", {namedExports: {async createEvent(...args) { state.events.push(args); }}});

state.requiredScopes = [];
await import("./router_my.js");
const profileRoute = routes.find(route => route.method === "post" && route.path === "/set/userinfo");

function response() {
    return {
        locals: {userid: 7},
        statusCode: 200,
        body: null,
        status(value) { this.statusCode = value; return this; },
        send(value) { this.body = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

beforeEach(() => {
    state.writeChecks = [];
    state.projectReads = [];
    state.userUpdates = [];
    state.events = [];
    state.restrictionError = null;
});

test("legacy profile updates require login and user:update before write policy enforcement", () => {
    assert.equal(state.requiredScopes.filter(scope => scope === "user:update").length, 1);
    assert.equal(profileRoute.handlers[0], needLogin);
    assert.equal(profileRoute.handlers[1], scopeGuard);
});

test("profile write restrictions stop legacy updates before side effects", async () => {
    state.restrictionError = Object.assign(new Error("read only"), {status: 403, code: "ACCOUNT_READ_ONLY"});
    let forwarded;
    await profileRoute.handlers[2]({body: {}}, response(), error => { forwarded = error; });

    assert.equal(forwarded, state.restrictionError);
    assert.deepEqual(state.writeChecks, [{userId: 7, category: "profile", action: "update"}]);
    assert.equal(state.projectReads.length, 0);
    assert.equal(state.userUpdates.length, 0);
    assert.equal(state.events.length, 0);
});

test("authorized legacy profile updates preserve accepted fields and event creation", async () => {
    const res = response();
    let authorized = false;
    await profileRoute.handlers[2]({body: {}}, res, error => {
        assert.ifError(error);
        authorized = true;
    });
    assert.equal(authorized, true);

    await profileRoute.handlers[3]({body: {display_name: "Updated", bio: "Profile"}}, res);

    assert.deepEqual(state.userUpdates, [{
        where: {id: 7},
        data: {display_name: "Updated", bio: "Profile"},
    }]);
    assert.equal(state.events.length, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {status: "success", message: "个人信息修改成功"});
});
