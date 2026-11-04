import { prisma } from '../../services/prisma.js';
import tokenUtils from '../../services/auth/tokenUtils.js';
import logger from '../../services/logger.js';
import redisClient from '../../services/redis.js';
import zcconfig from '../../services/config/zcconfig.js';
import { generateSudoToken } from '../../services/auth/sudoAuth.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const REG_TTL = 600; // seconds
const AUTH_TTL = 600;

async function getRpConfig() {
  const rpId = await zcconfig.get('webauthn.rpId');
  const rpName = (await zcconfig.get('webauthn.rpName')) || (await zcconfig.get('site.name', 'ZeroCat'));
  const origins = (await zcconfig.get('webauthn.origins')) || [(await zcconfig.get('urls.frontend'))];
  return { rpId, rpName, origins: Array.isArray(origins) ? origins : [origins] };
}

function mapStoredCredentials(metadata) {
  const creds = metadata?.credentials || [];
  // 仅映射含有效 credentialID 的凭据，避免历史损坏数据破坏选项生成
  return creds.filter(c => c && c.credentialID).map(c => ({ id: c.credentialID, transports: c.transports }));
}

export async function beginRegistration(req, res) {
  const userId = res.locals.userid;
  if (!userId) return res.status(401).json({ status: 'error', message: '需要登录' });
  // 用 userid 唯一标识用户（username 可能会变化）
  const user = await prisma.ow_users.findUnique({ where: { id: Number(userId) } });
  const { rpId, rpName } = await getRpConfig();

  const contact = await prisma.ow_users_contacts.findFirst({ where: { user_id: Number(userId), contact_type: 'passkey' } });
  const existingCreds = mapStoredCredentials(contact?.metadata);

  const options = await generateRegistrationOptions({
    rpID: rpId,
    rpName,
    userID: Buffer.from(String(user.id)), // 必须是稳定的唯一ID
    userName: user.username, // 可变，仅展示
    userDisplayName: user.display_name || user.username,
    attestationType: 'none',
    excludeCredentials: existingCreds,
  });

  await redisClient.set(`webauthn:reg:${userId}`, { challenge: options.challenge }, REG_TTL);

  return res.json({ status: 'success', data: options });
}

export async function finishRegistration(req, res) {
  const userId = res.locals.userid;
  const body = req.body;
  if (!userId || !body) return res.status(400).json({ status: 'error', message: '参数不足' });

  const { rpId, origins } = await getRpConfig();
  const challengeData = await redisClient.get(`webauthn:reg:${userId}`);
  if (!challengeData) return res.status(400).json({ status: 'error', message: '注册挑战不存在或已过期' });

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challengeData.challenge,
      expectedRPID: rpId,
      expectedOrigin: origins,
    });

    if (!verification.verified) {
      return res.status(400).json({ status: 'error', message: '注册验证失败' });
    }

    // @simplewebauthn/server v13: 凭据信息位于 registrationInfo.credential
    const { credential } = verification.registrationInfo;

    const contact = await prisma.ow_users_contacts.findFirst({ where: { user_id: Number(userId), contact_type: 'passkey' } });
    const baseMeta = contact?.metadata || {};
    // 过滤掉历史上因旧版 API 写入的损坏凭据（缺少 credentialID / publicKey），避免无法删除的脏数据
    const credentials = (baseMeta.credentials || []).filter(c => c && c.credentialID && c.publicKey);
    credentials.push({
      credentialID: credential.id, // base64url 字符串，与登录时 response.id 保持一致
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter ?? 0,
      transports: credential.transports || body.response?.transports || [],
      registered_at: Date.now(),
    });

    if (!contact) {
      await prisma.ow_users_contacts.create({
        data: {
          user_id: Number(userId),
          contact_type: 'passkey',
          contact_value: `passkey:${userId}`,
          verified: true,
          is_primary: false,
          metadata: { credentials },
        },
      });
    } else {
      await prisma.ow_users_contacts.update({ where: { contact_id: contact.contact_id }, data: { verified: true, metadata: { ...baseMeta, credentials } } });
    }

    await redisClient.delete(`webauthn:reg:${userId}`);
    return res.json({ status: 'success', message: 'Passkey 已注册' });
  } catch (e) {
    logger.error('[passkey] finishRegistration error', e);
    return res.status(400).json({ status: 'error', message: '注册验证异常' });
  }
}

export async function beginLogin(req, res) {
  const { identifier } = req.body; // optional username or email
  const { rpId } = await getRpConfig();

  if (!identifier) {
    // No-identifier (discoverable) flow
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
    });
    await redisClient.set(`webauthn:authc:${options.challenge}`, { any: true }, AUTH_TTL);
    return res.json({ status: 'success', data: options });
  }

  // Identifier-provided flow
  const user = await prisma.ow_users.findFirst({ where: { OR: [{ username: identifier }, { email: identifier }] } });
  if (!user) return res.status(404).json({ status: 'error', message: '用户不存在' });
  const contact = await prisma.ow_users_contacts.findFirst({ where: { user_id: user.id, contact_type: 'passkey', verified: true } });
  if (!contact || !(contact.metadata?.credentials || []).length) return res.status(400).json({ status: 'error', message: '未注册passkey' });

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: mapStoredCredentials(contact.metadata),
    userVerification: 'preferred',
  });
  await redisClient.set(`webauthn:authc:${options.challenge}`, { userId: user.id }, AUTH_TTL);
  return res.json({ status: 'success', data: options });
}

export async function finishLogin(req, res) {
  const response = req.body;
  if (!response) return res.status(400).json({ status: 'error', message: '参数不足' });

  const { rpId, origins } = await getRpConfig();

  // Extract challenge from clientDataJSON to locate stored challenge
  let expectedChallenge;
  try {
    const cjson = Buffer.from(response.response.clientDataJSON, 'base64').toString('utf8');
    const parsed = JSON.parse(cjson);
    expectedChallenge = parsed.challenge;
  } catch (e) {
    return res.status(400).json({ status: 'error', message: '无法解析客户端挑战' });
  }

  const challengeData = await redisClient.get(`webauthn:authc:${expectedChallenge}`);
  if (!challengeData) return res.status(400).json({ status: 'error', message: '登录挑战不存在或已过期' });

  // Find user & authenticator by credential ID
  const credId = response.id;
  let contact = null;
  let matched = null;
  try {
    if (typeof credId === 'string' && credId) {
      contact = await prisma.ow_users_contacts.findFirst({
        where: {
          contact_type: 'passkey',
          verified: true,
          metadata: { path: ['credentials'], array_contains: [{ credentialID: credId }] },
        },
        select: { contact_id: true, user_id: true, metadata: true },
      });
      matched = contact?.metadata?.credentials?.find(c => c.credentialID === credId) || null;
    }
  } catch (e) {
    logger.error('[passkey] 查找凭据失败', e);
  }
  if (!contact || !matched) return res.status(400).json({ status: 'error', message: '未找到凭据' });

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      // v13: 使用 credential 参数（取代旧版 authenticator）
      credential: {
        id: matched.credentialID,
        publicKey: Buffer.from(matched.publicKey, 'base64'),
        counter: matched.counter || 0,
        transports: matched.transports || [],
      },
    });
    if (!verification.verified) return res.status(400).json({ status: 'error', message: '登录验证失败' });

    // update counter
    const newCounter = verification.authenticationInfo.newCounter;
    const allCreds = (contact.metadata?.credentials || []).map(c => c.credentialID === matched.credentialID ? { ...c, counter: newCounter } : c);
    await prisma.ow_users_contacts.update({ where: { contact_id: contact.contact_id }, data: { metadata: { ...contact.metadata, credentials: allCreds } } });

    await redisClient.delete(`webauthn:authc:${expectedChallenge}`);

    const user = await prisma.ow_users.findUnique({ where: { id: Number(contact.user_id) } });
    const userInfo = await tokenUtils.getUserInfoForToken(user, user.email || null);
    const tokenResult = await tokenUtils.createUserLoginTokens(
      user.id,
      userInfo,
      req.ipInfo?.clientIP || req.ip,
      req.headers['user-agent'],
      { recordLoginEvent: true, loginMethod: 'passkey' }
    );
    if (!tokenResult.success) return res.status(500).json({ status: 'error', message: '创建登录令牌失败' });
    const responseData = tokenUtils.generateLoginResponse(user, tokenResult, userInfo.email || null);
    return tokenUtils.respondWithBrowserAuthTokens(res, responseData);
  } catch (e) {
    logger.error('[passkey] finishLogin error', e);
    return res.status(400).json({ status: 'error', message: '登录验证异常' });
  }
}

export async function sudoWithPasskey(req, res) {
  if (!res.locals.userid) return res.status(401).json({ status: 'error', message: '需要登录' });
  const userId = res.locals.userid;
  const contact = await prisma.ow_users_contacts.findFirst({ where: { user_id: userId, contact_type: 'passkey', verified: true } });
  if (!contact || !(contact.metadata?.credentials || []).length) return res.status(400).json({ status: 'error', message: '未注册passkey' });
  const { rpId } = await getRpConfig();
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: mapStoredCredentials(contact.metadata),
    userVerification: 'preferred',
  });
  await redisClient.set(`webauthn:sudo:${userId}`, { challenge: options.challenge }, AUTH_TTL);
  res.json({ status: 'success', data: options });
}

export async function finalizeSudoWithPasskey(req, res) {
  const userId = res.locals.userid;
  const response = req.body;
  if (!userId || !response) return res.status(400).json({ status: 'error', message: '参数不足' });
  const contact = await prisma.ow_users_contacts.findFirst({ where: { user_id: userId, contact_type: 'passkey', verified: true } });
  if (!contact || !(contact.metadata?.credentials || []).length) return res.status(400).json({ status: 'error', message: '未注册passkey' });
  const { rpId, origins } = await getRpConfig();
  const challengeData = await redisClient.get(`webauthn:sudo:${userId}`);
  if (!challengeData) return res.status(400).json({ status: 'error', message: 'sudo挑战不存在或已过期' });

  const creds = contact.metadata.credentials;
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      // v13: 使用 credential 参数（取代旧版 authenticator）
      credential: (() => {
        const credId = response.id;
        const matched = creds.find(c => c.credentialID === credId);
        if (!matched) return null;
        return {
          id: matched.credentialID,
          publicKey: Buffer.from(matched.publicKey, 'base64'),
          counter: matched.counter || 0,
          transports: matched.transports || [],
        };
      })(),
    });
    if (!verification.verified) return res.status(400).json({ status: 'error', message: 'sudo验证失败' });
    await redisClient.delete(`webauthn:sudo:${userId}`);
    const { token } = await generateSudoToken(userId);
    return res.json({ status: 'success', data: { sudo_token: token, expires_in: 900 } });
  } catch (e) {
    logger.error('[passkey] finalizeSudoWithPasskey error', e);
    return res.status(400).json({ status: 'error', message: 'sudo验证异常' });
  }
}

export async function listCredentials(req, res) {
  const userId = res.locals.userid;
  const contact = await prisma.ow_users_contacts.findFirst({ where: { user_id: Number(userId), contact_type: 'passkey' } });
  const creds = contact?.metadata?.credentials || [];
  // 不返回公钥，仅返回元信息
  const data = creds.map(c => ({
    credential_id: c.credentialID,
    transports: c.transports || [],
    counter: c.counter || 0,
    registered_at: c.registered_at || null,
  }));
  return res.json({ status: 'success', data });
}

export async function deleteCredential(req, res) {
  const userId = res.locals.userid;
  const { credential_id } = req.body;
  if (!credential_id) return res.status(400).json({ status: 'error', message: '缺少credential_id' });
  const contact = await prisma.ow_users_contacts.findFirst({ where: { user_id: Number(userId), contact_type: 'passkey' } });
  if (!contact) return res.status(404).json({ status: 'error', message: '未找到passkey记录' });
  const creds = contact.metadata?.credentials || [];
  const filtered = creds.filter(c => c.credentialID !== credential_id);
  if (filtered.length === creds.length) {
    return res.status(404).json({ status: 'error', message: '凭据不存在' });
  }
  const newMetadata = { ...contact.metadata, credentials: filtered };
  // 若已无凭据，标记 verified 为 false
  const updateData = { metadata: newMetadata, verified: filtered.length > 0 };
  await prisma.ow_users_contacts.update({ where: { contact_id: contact.contact_id }, data: updateData });
  return res.json({ status: 'success', message: '已删除凭据', data: { remaining: filtered.length } });
}


