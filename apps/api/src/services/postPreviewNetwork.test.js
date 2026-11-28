import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createPinnedLookup,
  fetchPageHtml,
  isPublicIpAddress,
  normalizeInputUrl,
  resolvePublicUrl,
  UrlPreviewError,
} from "./postPreviewNetwork.js";

const htmlResponse = (html, status = 200, headers = { "content-type": "text/html; charset=utf-8" }) => ({
  status,
  headers,
  data: Readable.from([html]),
});

test("special-use and alternate address forms are not public preview destinations", () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "::1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress("93.184.216.34"), true);
  assert.equal(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
});

test("preview URLs reject credentials and non-default ports without reinterpretation", () => {
  assert.throws(
    () => normalizeInputUrl("https://reader:secret@public.example/article"),
    (error) => error instanceof UrlPreviewError && error.code === "URL_CREDENTIALS_NOT_ALLOWED",
  );
  assert.throws(
    () => normalizeInputUrl("https://public.example:8443/article"),
    (error) => error instanceof UrlPreviewError && error.code === "UNSAFE_PORT",
  );
  assert.equal(
    normalizeInputUrl("https://public.example/article?utm_source=feed&chapter=2#summary"),
    "https://public.example/article?chapter=2",
  );
  assert.equal(normalizeInputUrl("https://public.example:443/article"), "https://public.example/article");
});

test("every resolved address must be globally reachable", async () => {
  const lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.8", family: 4 },
  ];
  await assert.rejects(
    resolvePublicUrl("https://public.example/article", lookup),
    (error) => error instanceof UrlPreviewError && error.code === "BLOCKED_IP",
  );
});

test("pinned lookup returns only prevalidated DNS answers", async () => {
  const lookup = createPinnedLookup("public.example", [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);

  const all = await new Promise((resolve, reject) => {
    lookup("public.example", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
  });
  assert.deepEqual(all, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);

  await assert.rejects(new Promise((resolve, reject) => {
    lookup("changed.example", {}, (error, address) => error ? reject(error) : resolve(address));
  }), { code: "ENOTFOUND" });
});

test("redirect destinations are validated before another request", async () => {
  const requests = [];
  const lookup = async (hostname) => hostname === "public.example"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "127.0.0.1", family: 4 }];
  const request = async (url, options) => {
    requests.push({ url, options });
    return htmlResponse("", 302, { location: "http://private.example/metadata" });
  };

  await assert.rejects(
    fetchPageHtml("https://public.example/start", { lookup, request }),
    (error) => error instanceof UrlPreviewError && error.code === "BLOCKED_IP",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.maxRedirects, 0);
  assert.equal(requests[0].options.proxy, false);
});

test("public redirects preserve preview fetching with pinned connections", async () => {
  const requestedUrls = [];
  const dnsLookups = [];
  const lookup = async (hostname) => {
    dnsLookups.push(hostname);
    return [{ address: hostname === "first.example" ? "93.184.216.34" : "142.250.72.14", family: 4 }];
  };
  const request = async (url, options) => {
    requestedUrls.push(url);
    const pinned = await new Promise((resolve, reject) => {
      options.lookup(new URL(url).hostname, {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    assert.equal(isPublicIpAddress(pinned.address), true);
    if (requestedUrls.length === 1) {
      return htmlResponse("", 301, { location: "https://second.example/article" });
    }
    return htmlResponse("<html><head><title>Public article</title></head><body></body></html>");
  };

  const result = await fetchPageHtml("https://first.example/start", { lookup, request });
  assert.deepEqual(requestedUrls, [
    "https://first.example/start",
    "https://second.example/article",
  ]);
  assert.deepEqual(dnsLookups, ["first.example", "second.example"]);
  assert.equal(result.finalUrl, "https://second.example/article");
  assert.match(result.html, /Public article/);
});
