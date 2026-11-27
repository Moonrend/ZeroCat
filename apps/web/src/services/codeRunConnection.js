export const CODERUN_SUBPROTOCOL_PREFIX = 'zerocat-terminal-v1.';

const CAPABILITY_PATTERN = /^zcr_[a-f0-9]{64}$/;

export function createCodeRunWebSocketOptions(requestUrl, capability, pageProtocol = globalThis.location?.protocol) {
  if (!CAPABILITY_PATTERN.test(capability || '')) {
    throw new TypeError('Invalid CodeRun capability');
  }

  const wsUrl = new URL('/terminal', requestUrl);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(wsUrl.protocol)) {
    throw new TypeError('Invalid CodeRun runner URL');
  }

  wsUrl.protocol = pageProtocol === 'http:' ? 'ws:' : 'wss:';
  wsUrl.username = '';
  wsUrl.password = '';
  wsUrl.search = '';
  wsUrl.hash = '';

  return {
    url: wsUrl.toString(),
    protocol: CODERUN_SUBPROTOCOL_PREFIX + capability,
  };
}
