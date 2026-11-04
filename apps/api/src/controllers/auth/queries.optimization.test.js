import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { TOTP } from "otpauth";

const state = { calls: [], handlers: {}, challenge: null, notifications: [] };
const noop = () => {};
const asyncNoop = async () => {};
const prisma = Object.fromEntries(["ow_users", "ow_users_contacts", "ow_tokens"].map(model => [model,
  Object.fromEntries(["findFirst", "findUnique", "findMany", "update", "updateMany", "create", "count"].map(method => [method, async (args) => {
    const operation = `${model}.${method}`;
    state.calls.push({ operation, args });
    return state.handlers[operation]?.(args) ?? (method === "findMany" ? [] : null);
  }])),
]));
mock.module("../../services/prisma.js", { namedExports: { prisma } });
mock.module("../../services/logger.js", { defaultExport: { info: noop, warn: noop, error: noop, debug: noop } });
mock.module("../../services/auth/auth.js", { defaultExport: {} });
mock.module("../../services/global.js", { namedExports: {
  checkhash: () => true, emailTest: value => value.includes("@"), userpwTest: () => true,
  hash: value => value, validateUsername: () => ({ valid: true }), isDisposableEmail: () => false,
} });
mock.module("../../services/redis.js", { defaultExport: { get: async key => key.startsWith("webauthn:") ? state.challenge : 0, set: asyncNoop, delete: asyncNoop } });
mock.module("../../services/config/zcconfig.js", { defaultExport: { get: async () => "https://example.test" } });
mock.module("../../services/auth/verification.js", { namedExports: {
  checkRateLimit: async () => ({ success: true }), generateVerificationCode: async () => ({ success: true, code: "123456" }),
  VerificationType: { LOGIN: "login", REGISTER: "register", PASSWORD_RESET: "reset" }, verifyCode: async () => ({ success: true }),
  createTemporaryToken: async () => ({ success: true, token: "temporary" }), invalidateTemporaryToken: asyncNoop,
  validateTemporaryToken: async () => ({ success: true, userId: 7 }), createRegistrationToken: async () => ({ success: true, token: "register" }),
  validateRegistrationToken: async () => ({ success: true, email: "known@example.test" }), invalidateRegistrationToken: asyncNoop,
} });
mock.module("../../services/auth/magiclink.js", { namedExports: {
  generateMagicLinkForLogin: async () => ({ success: true, magicLink: "link" }), markMagicLinkAsUsed: asyncNoop,
  sendMagicLinkEmail: asyncNoop, validateMagicLinkAndLogin: async () => ({ success: true, userId: 7 }),
} });
mock.module("../../services/auth/tokenUtils.js", { defaultExport: {
  getUserInfoForToken: async (user, email) => ({ ...user, email }), createUserLoginTokens: async () => ({ success: true }),
  generateLoginResponse: (user, _tokens, email) => ({ status: "success", userId: user.id, email }),
  respondWithBrowserAuthTokens: (res, body) => res.json(body),
} });
mock.module("../../services/auth/twoFactor.js", { defaultExport: { getTwoFactorStatus: async () => ({ enabled: false }) } });
mock.module("../../services/auth/tokenService.js", { namedExports: { revokeTokenByRefreshToken: asyncNoop } });
mock.module("../../services/auth/sudoAuth.js", { namedExports: { generateSudoToken: asyncNoop } });
mock.module("../../services/auth/unifiedAuth.js", { namedExports: { sendVerificationCode: asyncNoop, authenticate: asyncNoop } });
mock.module("../../services/auth/policyEngine.js", { namedExports: { assignDefaultRolesToUser: asyncNoop } });
mock.module("../../services/email/emailService.js", { namedExports: { sendEmail: asyncNoop } });
mock.module("../../services/gorse.js", { defaultExport: {} });
mock.module("../../services/memoryCache.js", { defaultExport: { get: () => 0, set: noop } });
mock.module("../notifications.js", { namedExports: { createNotification: async data => state.notifications.push(data) } });
mock.module("../events.js", { namedExports: { createEvent: asyncNoop } });
mock.module("@simplewebauthn/server", { namedExports: {
  generateRegistrationOptions: asyncNoop, verifyRegistrationResponse: asyncNoop,
  generateAuthenticationOptions: asyncNoop, verifyAuthenticationResponse: async () => ({ verified: false }),
} });

const login = await import("./loginController.js");
const unified = await import("./unifiedAuthController.js");
const email = await import("./emailController.js");
const register = await import("./registerController.js");
const passkey = await import("./passkeyController.js");
const response = (userid = 7) => ({ locals: { userid }, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const calls = operation => state.calls.filter(call => call.operation === operation);
beforeEach(() => { state.calls = []; state.handlers = {}; state.challenge = null; state.notifications = []; });

test("password email login resolves the contact owner in one query and prefers primary email", async () => {
  state.handlers["ow_users.findFirst"] = () => ({ id: 7, status: "active", password: "hash" });
  state.handlers["ow_users_contacts.findFirst"] = () => ({ contact_value: "primary@example.test" });
  const res = response();
  await login.loginWithPassword({ body: { un: "login@example.test", pw: "password" }, headers: {}, ip: "127.0.0.1" }, res);
  assert.equal(res.body.status, "success");
  assert.equal(res.body.email, "primary@example.test");
  assert.equal(state.calls.length, 2);
  assert.deepEqual(calls("ow_users.findFirst")[0].args.where.contacts.some, {
    contact_value: "login@example.test", contact_type: "email", OR: [{ is_primary: true }, { verified: true }],
  });
  assert.deepEqual(calls("ow_users_contacts.findFirst")[0].args.orderBy, { is_primary: "desc" });
});

test("code delivery requires verified email and uses one sorted contact query", async () => {
  state.handlers["ow_users.findFirst"] = () => ({ id: 7, status: "active" });
  state.handlers["ow_users_contacts.findFirst"] = () => ({ contact_value: "verified@example.test" });
  const res = response();
  await login.sendLoginCode({ body: { identifier: "username" } }, res);
  const query = calls("ow_users_contacts.findFirst")[0].args;
  assert.deepEqual(query.where, { user_id: 7, contact_type: "email", verified: true });
  assert.deepEqual(query.orderBy, { is_primary: "desc" });
  assert.equal(calls("ow_users_contacts.findFirst").length, 1);
  assert.equal(state.notifications[0].data.email_to, "verified@example.test");
});

test("available authentication methods retain metadata checks with a single contact batch", async () => {
  state.handlers["ow_users.findFirst"] = () => ({ id: 7, password: "hash" });
  state.handlers["ow_users_contacts.findMany"] = () => [
    { contact_type: "totp", verified: true, metadata: { enabled: false } },
    { contact_type: "passkey", verified: true, metadata: { credentials: [{}] } },
    { contact_type: "email", verified: true },
  ];
  const res = response();
  await unified.getAuthMethods({ query: { purpose: "sudo" } }, res);
  assert.deepEqual(res.body.data.available_methods, ["password", "email", "passkey"]);
  assert.equal(state.calls.length, 2);
  assert.equal(calls("ow_users_contacts.findFirst").length, 0);
});

test("email verification reuses the ownership-checked contact and writes only once", async () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const contact = { contact_id: 3, user_id: 7, contact_value: "email@example.test", contact_info: secret, is_primary: false };
  state.handlers["ow_users_contacts.findFirst"] = () => contact;
  const token = new TOTP({ secret, algorithm: "SHA256", digits: 6, period: 300, issuer: "ZeroCat", label: "邮箱验证" }).generate();
  const res = response();
  await email.verifyEmail({ body: { email: contact.contact_value, token } }, res);
  assert.equal(res.body.status, "success");
  assert.equal(calls("ow_users_contacts.findFirst").length, 1);
  assert.equal(calls("ow_users_contacts.update").length, 1);
  assert.equal(calls("ow_users_contacts.findFirst")[0].args.where.user_id, 7);
});

test("password recovery keeps the active-user and verified-contact guards in one query", async () => {
  const res = response();
  await register.retrievePassword({ body: { email: "missing@example.test" } }, res);
  assert.equal(res.body.status, "success");
  assert.equal(state.notifications.length, 0);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(calls("ow_users.findFirst")[0].args.where, {
    status: "active", contacts: { some: { contact_value: "missing@example.test", contact_type: "email", verified: true } },
  });
});

test("passkey discovery pushes credential identity into the database JSON filter", async () => {
  state.challenge = { any: true };
  const res = response(null);
  await passkey.finishLogin({ body: { id: "credential-id", response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: "challenge" })).toString("base64") } } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "未找到凭据");
  assert.equal(calls("ow_users_contacts.findMany").length, 0);
  assert.deepEqual(calls("ow_users_contacts.findFirst")[0].args.where, {
    contact_type: "passkey", verified: true,
    metadata: { path: ["credentials"], array_contains: [{ credentialID: "credential-id" }] },
  });
});
