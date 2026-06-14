import net from 'node:net';
import tls from 'node:tls';
import process from 'node:process';
import { URL } from 'node:url';

const INSTALL_FLAG = Symbol.for('agent-quorum.test.network-guard.installed');
const MARKER = 'agent-quorum network guard';
const ERROR_CODE = 'AGENT_QUORUM_NETWORK_BLOCKED';
const LOOPBACK_IPV4_FIRST_OCTET = 127;
const LOOPBACK_IPV6 = '::1';
const LOCALHOST_NAME = 'localhost';
const IPC_PORT_LABEL = 'ipc';
const HTTPS_DEFAULT_PORT = '443';
const HTTP_DEFAULT_PORT = '80';

function isAbsent(value) {
  return value === undefined || value === null || value === '';
}

function normalizeHost(host) {
  let normalized = String(host).trim();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.toLowerCase();
}

function isLocalTarget(host) {
  if (isAbsent(host)) {
    return true;
  }
  const normalized = normalizeHost(host);
  const ipKind = net.isIP(normalized);
  if (ipKind === 4) {
    return Number(normalized.split('.')[0]) === LOOPBACK_IPV4_FIRST_OCTET;
  }
  if (ipKind === 6) {
    return normalized === LOOPBACK_IPV6;
  }
  return normalized === LOCALHOST_NAME;
}

function hostLabel(host) {
  if (isAbsent(host)) {
    return LOCALHOST_NAME;
  }
  return String(host);
}

function portLabel(port) {
  if (port === undefined || port === null) {
    return '';
  }
  return String(port);
}

function emitBlock(host, port) {
  process.stderr.write(`[${MARKER}] blocked external connection to ${host}:${port}\n`);
}

function makeGuardError(host, port) {
  const error = new Error(
    `blocked external network egress to ${host}:${port} during tests (${MARKER})`,
  );
  error.code = ERROR_CODE;
  return error;
}

function destroyWithBlockedError(socket, host, port) {
  emitBlock(host, port);
  const error = makeGuardError(host, port);
  process.nextTick(() => {
    socket.destroy(error);
  });
}

function createBlockedTlsSocket() {
  try {
    return new tls.TLSSocket(new net.Socket());
  } catch {
    return new net.Socket();
  }
}

function requestUrl(input) {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') {
    return new URL(input.url);
  }
  return undefined;
}

function urlPort(url) {
  if (url.port !== '') {
    return url.port;
  }
  if (url.protocol === 'https:') {
    return HTTPS_DEFAULT_PORT;
  }
  return HTTP_DEFAULT_PORT;
}

function unwrapConnectArgs(rawArgs) {
  if (rawArgs.length === 1 && Array.isArray(rawArgs[0])) {
    return rawArgs[0];
  }
  return rawArgs;
}

function connectTargetFromOptions(options) {
  if (typeof options.path === 'string' && options.path !== '') {
    return {
      isLocal: true,
      host: options.path,
      port: IPC_PORT_LABEL,
    };
  }
  return {
    isLocal: isLocalTarget(options.host),
    host: hostLabel(options.host),
    port: portLabel(options.port),
  };
}

function connectTargetFromIpcPath(path) {
  return {
    isLocal: true,
    host: path,
    port: IPC_PORT_LABEL,
  };
}

function connectTargetFromPortHost(port, host) {
  return {
    isLocal: isLocalTarget(host),
    host: hostLabel(host),
    port: portLabel(port),
  };
}

function parseConnectTarget(rawArgs) {
  const args = unwrapConnectArgs(rawArgs);
  const first = args[0];
  if (first !== null && typeof first === 'object') {
    return connectTargetFromOptions(first);
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) {
    return connectTargetFromIpcPath(first);
  }
  const host = typeof args[1] === 'string' ? args[1] : undefined;
  return connectTargetFromPortHost(first, host);
}

function patchFetch() {
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function') {
    return;
  }
  globalThis.fetch = function guardedFetch(input, init) {
    const url = requestUrl(input);
    if (url !== undefined && !isLocalTarget(url.hostname)) {
      const port = urlPort(url);
      emitBlock(url.hostname, port);
      return Promise.reject(makeGuardError(url.hostname, port));
    }
    return realFetch.call(this, input, init);
  };
}

function patchSocketConnect() {
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = parseConnectTarget(args);
    if (target.isLocal) {
      return realConnect.apply(this, args);
    }
    destroyWithBlockedError(this, target.host, target.port);
    return this;
  };
}

// Defense in depth: most TLS egress routes through the patched
// net.Socket.prototype.connect, but patch tls.connect directly in case a Node
// version's TLSSocket does not. Return a TLSSocket that errors asynchronously so
// the failure reaches the caller after it attaches its 'error' listener.
function patchTlsConnect() {
  const realTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    const target = parseConnectTarget(args);
    if (target.isLocal) {
      return realTlsConnect.apply(this, args);
    }
    const socket = createBlockedTlsSocket();
    destroyWithBlockedError(socket, target.host, target.port);
    return socket;
  };
}

function registerChildPreload() {
  const selfUrl = import.meta.url;
  const current = process.env.NODE_OPTIONS ?? '';
  if (current.includes(selfUrl)) {
    return;
  }
  const directive = `--import ${selfUrl}`;
  process.env.NODE_OPTIONS = current === '' ? directive : `${current} ${directive}`;
}

if (!Reflect.get(globalThis, INSTALL_FLAG)) {
  Reflect.set(globalThis, INSTALL_FLAG, true);
  patchFetch();
  patchSocketConnect();
  patchTlsConnect();
  registerChildPreload();
}
