import dns from "dns/promises";
import http from "http";
import https from "https";
import net from "net";
import axios from "axios";

const MAX_HTML_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const blockedIpv4Addresses = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

const globalIpv6Addresses = new net.BlockList();
globalIpv6Addresses.addSubnet("2000::", 3, "ipv6");

const blockedIpv6Addresses = new net.BlockList();
for (const [network, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export class UrlPreviewError extends Error {
  constructor(message, statusCode = 400, code = "INVALID_REQUEST") {
    super(message);
    this.name = "UrlPreviewError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseHttpUrl(rawUrl, baseUrl) {
  let parsed;
  try {
    parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    throw new UrlPreviewError("无效的 URL", 400, "INVALID_URL");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new UrlPreviewError("仅支持 http/https URL", 400, "UNSUPPORTED_PROTOCOL");
  }

  if (parsed.username || parsed.password) {
    throw new UrlPreviewError("URL 不允许包含凭据", 400, "URL_CREDENTIALS_NOT_ALLOWED");
  }

  // WHATWG URL parsing removes an explicit default port, so any remaining port is non-default.
  if (parsed.port) {
    throw new UrlPreviewError("URL 端口不受支持", 400, "UNSAFE_PORT");
  }

  parsed.hash = "";
  return parsed;
}

export function normalizeInputUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new UrlPreviewError("url 不能为空", 400, "EMPTY_URL");
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new UrlPreviewError("url 不能为空", 400, "EMPTY_URL");
  }

  const parsed = parseHttpUrl(trimmed);
  const removableTrackingParams = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "mc_cid",
    "mc_eid",
  ]);

  for (const key of [...parsed.searchParams.keys()]) {
    if (removableTrackingParams.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }

  return parsed.toString();
}

function normalizeHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

export function isPublicIpAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    return !blockedIpv4Addresses.check(address, "ipv4");
  }

  if (version === 6) {
    return globalIpv6Addresses.check(address, "ipv6")
      && !blockedIpv6Addresses.check(address, "ipv6");
  }

  return false;
}

export async function resolvePublicUrl(urlString, lookup = dns.lookup) {
  const parsed = parseHttpUrl(urlString);
  const hostname = normalizeHostname(parsed.hostname);

  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new UrlPreviewError("不允许访问内网地址", 400, "BLOCKED_HOST");
  }

  const literalFamily = net.isIP(hostname);
  let lookupResults;
  if (literalFamily) {
    lookupResults = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      lookupResults = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new UrlPreviewError("域名解析失败", 400, "DNS_LOOKUP_FAILED");
    }
  }

  if (!Array.isArray(lookupResults) || lookupResults.length === 0) {
    throw new UrlPreviewError("域名解析失败", 400, "DNS_LOOKUP_FAILED");
  }

  const addresses = [];
  for (const item of lookupResults) {
    const address = String(item?.address || "");
    const family = net.isIP(address);
    if (!family || !isPublicIpAddress(address)) {
      throw new UrlPreviewError("不允许访问内网地址", 400, "BLOCKED_IP");
    }
    if (!addresses.some((candidate) => candidate.address === address && candidate.family === family)) {
      addresses.push({ address, family });
    }
  }

  return {
    url: parsed.toString(),
    hostname,
    addresses,
  };
}

function createLookupError(hostname) {
  const error = new Error(`Pinned DNS address unavailable for ${hostname}`);
  error.code = "ENOTFOUND";
  return error;
}

export function createPinnedLookup(expectedHostname, approvedAddresses) {
  const normalizedExpectedHostname = normalizeHostname(expectedHostname);
  const addresses = approvedAddresses.map(({ address, family }) => ({ address, family }));

  return (hostname, options, callback) => {
    let lookupOptions = options;
    let done = callback;
    if (typeof options === "function") {
      done = options;
      lookupOptions = {};
    } else if (typeof options === "number") {
      lookupOptions = { family: options };
    }

    if (normalizeHostname(hostname) !== normalizedExpectedHostname) {
      return done(createLookupError(hostname));
    }

    const requestedFamily = Number(lookupOptions?.family || 0);
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses;

    if (eligible.length === 0) {
      return done(createLookupError(hostname));
    }

    if (lookupOptions?.all) {
      return done(null, eligible.map((item) => ({ ...item })));
    }

    return done(null, eligible[0].address, eligible[0].family);
  };
}

function createPinnedAgents(hostname, addresses) {
  const lookup = createPinnedLookup(hostname, addresses);
  const httpAgent = new http.Agent({ keepAlive: false, lookup });
  const httpsAgent = new https.Agent({ keepAlive: false, lookup });
  return {
    lookup,
    httpAgent,
    httpsAgent,
    destroy() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}

async function readResponseHtml(response, finalUrl) {
  const stream = response?.data;
  const chunks = [];
  let bytesRead = 0;
  let endedByLimit = false;
  let headProbe = "";

  await new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    stream.on("data", (chunk) => {
      if (settled) return;

      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_HTML_BYTES - bytesRead;

      if (remaining <= 0) {
        endedByLimit = true;
        stream.destroy();
        return finish();
      }

      if (chunkBuffer.length <= remaining) {
        chunks.push(chunkBuffer);
        bytesRead += chunkBuffer.length;
      } else {
        chunks.push(chunkBuffer.subarray(0, remaining));
        bytesRead += remaining;
        endedByLimit = true;
        stream.destroy();
        return finish();
      }

      headProbe = (headProbe + chunkBuffer.toString("utf8")).slice(-16384);
      if (/<\/head\s*>/i.test(headProbe)) {
        stream.destroy();
        return finish();
      }
    });

    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", (error) => {
      if (settled) return;
      const isExpectedClose = endedByLimit || /premature close/i.test(String(error?.message || ""));
      if (isExpectedClose) {
        return finish();
      }
      fail(error);
    });
  });

  const html = Buffer.concat(chunks).toString("utf8");
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();

  if (!html) {
    throw new UrlPreviewError("目标页面无可解析内容", 422, "EMPTY_HTML");
  }

  if (contentType && !contentType.includes("text/html") && !html.includes("<html")) {
    throw new UrlPreviewError("目标 URL 不是可预览网页", 422, "UNSUPPORTED_CONTENT_TYPE");
  }

  return { html, finalUrl, contentType };
}

export async function fetchPageHtml(urlString, dependencies = {}) {
  const lookup = dependencies.lookup || ((hostname, options) => dns.lookup(hostname, options));
  const request = dependencies.request || ((url, options) => axios.get(url, options));
  const seen = new Set();
  let currentUrl = parseHttpUrl(urlString).toString();

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      if (seen.has(currentUrl)) {
        throw new UrlPreviewError("目标页面重定向循环", 502, "REDIRECT_LOOP");
      }
      seen.add(currentUrl);

      const target = await resolvePublicUrl(currentUrl, lookup);
      currentUrl = target.url;
      const agents = createPinnedAgents(target.hostname, target.addresses);
      let response;

      try {
        response = await request(currentUrl, {
          timeout: REQUEST_TIMEOUT_MS,
          responseType: "stream",
          maxRedirects: 0,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          proxy: false,
          lookup: agents.lookup,
          httpAgent: agents.httpAgent,
          httpsAgent: agents.httpsAgent,
          validateStatus: (status) => (status >= 200 && status < 300) || REDIRECT_STATUS_CODES.has(status),
          headers: {
            "User-Agent": "ZeroCatBot/1.0 (+https://zerocat.top)",
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          },
        });

        if (REDIRECT_STATUS_CODES.has(response.status)) {
          response.data?.destroy?.();
          const location = response.headers?.location;
          if (!location) {
            throw new UrlPreviewError("重定向缺少有效地址", 502, "INVALID_REDIRECT");
          }
          if (redirectCount >= MAX_REDIRECTS) {
            throw new UrlPreviewError("目标页面重定向次数过多", 502, "TOO_MANY_REDIRECTS");
          }
          currentUrl = parseHttpUrl(String(location), currentUrl).toString();
          continue;
        }

        return await readResponseHtml(response, currentUrl);
      } finally {
        agents.destroy();
      }
    }

    throw new UrlPreviewError("目标页面重定向次数过多", 502, "TOO_MANY_REDIRECTS");
  } catch (error) {
    if (error instanceof UrlPreviewError) {
      throw error;
    }

    if (String(error?.message || "").includes("maxContentLength")) {
      throw new UrlPreviewError("目标页面体积过大", 422, "CONTENT_TOO_LARGE");
    }

    if (error?.code === "ECONNABORTED") {
      throw new UrlPreviewError("抓取超时，请稍后重试", 504, "FETCH_TIMEOUT");
    }

    const upstreamStatus = Number(error?.response?.status || 0);
    if (upstreamStatus === 403 || upstreamStatus === 429) {
      throw new UrlPreviewError("目标站点拒绝抓取，请稍后重试", 502, "UPSTREAM_BLOCKED");
    }
    throw new UrlPreviewError("抓取预览失败", 502, "FETCH_FAILED");
  }
}
