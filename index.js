/**
 * Cloudflared Tunnel Manager — Host half (static DSH bundle).
 *
 * All CLI operations and the write-confirmation gate live here, once.
 * Client panel reaches them over a same-origin authenticated JSON route,
 * and the Agent reaches them through a tool registered from the same dispatch.
 */
import { spawn, spawnSync } from 'node:child_process';
import https from 'node:https';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFile, chmodSync, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const CLOUDFLARED_CONFIG_DIR = path.join(os.homedir(), '.cloudflared');
const CERT_PATH = path.join(CLOUDFLARED_CONFIG_DIR, 'cert.pem');
const CONFIG_PATH = path.join(CLOUDFLARED_CONFIG_DIR, 'config.yml');
const LOG_DIR = path.join(CLOUDFLARED_CONFIG_DIR, 'plugin-logs');
const ROUTE_PATH = '/__cloudflared_tunnel__/api';
// Release asset per platform AND CPU architecture. Picking only by platform
// installs an amd64 binary on an arm64 Linux box, which then fails to exec at
// all ("exec format error"), so the arch is part of the lookup key.
// Windows has no native arm64 build; the x64 binary runs under emulation there.
const DOWNLOADS = {
  win32: {
    x64: 'cloudflared-windows-amd64.exe',
    arm64: 'cloudflared-windows-amd64.exe',
    ia32: 'cloudflared-windows-386.exe',
  },
  darwin: {
    x64: 'cloudflared-darwin-amd64.tgz',
    arm64: 'cloudflared-darwin-arm64.tgz',
  },
  linux: {
    x64: 'cloudflared-linux-amd64',
    arm64: 'cloudflared-linux-arm64',
    arm: 'cloudflared-linux-arm',
    ia32: 'cloudflared-linux-386',
  },
};
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

/** The release asset a given platform/arch should install, or null. */
function releaseAsset(platform = process.platform, arch = process.arch) {
  const table = DOWNLOADS[platform];
  if (!table) return null;
  // Fall back to x64 rather than failing: the x64 build still runs under
  // emulation on arm64 Windows, and x64 is the safest bet on exotic arches.
  const name = table[arch] || table.x64;
  if (!name) return null;
  return {
    name,
    url: RELEASE_BASE + name,
    // macOS ships the binary inside a .tgz; Linux and Windows ship it bare.
    archive: name.endsWith('.tgz') ? 'tgz' : '',
    // Windows/macOS never chmod; only POSIX needs the +x bit.
    executable: platform !== 'win32',
  };
}

/** Filename cloudflared must have on this host to be executable. */
function binName() { return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'; }
// GitHub serves release binaries from release-assets.githubusercontent.com, which
// some networks cannot reach at all: the TCP connect simply times out and fetch()
// rejects with a bare "fetch failed". These mirrors proxy the very same release
// URL, so the installer walks this list and uses the first one that delivers.
const DOWNLOAD_SOURCES = [
  (url) => url,
  (url) => 'https://ghproxy.net/' + url,
  (url) => 'https://gh-proxy.com/' + url,
];
// Remembering the last working mirror saves the user a connect-timeout on every
// later install/upgrade: the winning source is tried first next time.
const SOURCE_MEMO_PATH = path.join(CLOUDFLARED_CONFIG_DIR, '.download-source');
const CONNECT_TIMEOUT_MS = 12_000;
// A body that stops yielding bytes must fail instead of hanging the panel forever.
const IDLE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 1024 * 1024;
const MAX_BODY = 64 * 1024;
const DEFAULT_TIMEOUT = 30_000;
const CONFIRM_TTL_MS = 5 * 60 * 1000; // confirmation tokens expire after 5 minutes

export const inject = ['webServer', 'tools'];

const managed = new Map();
const confirmations = new Map();
// Latest download progress snapshot, polled by the UI while an install runs.
let installProgress = null;
// stamp each snapshot so the client can ignore a stale "done" from a prior run.
function setProgress(obj) { installProgress = { ...obj, at: Date.now() }; }

/** Turn a fetch/stream failure into something a user can act on. Node reports
 *  blocked networks as a bare "fetch failed" whose real reason hides in `cause`. */
function describeDownloadError(err) {
  const cause = err && err.cause;
  const code = (cause && (cause.code || cause.errno)) || '';
  const detail = (cause && cause.message) || (err && err.message) || String(err);
  if (/fetch failed/i.test(detail) && !code) return 'fetch failed（网络无法连接该源）';
  return code ? code + ': ' + detail : detail;
}

/** Source order for one install: the mirror that worked last time goes first,
 *  everything else keeps its declared order. */
function downloadOrder() {
  let remembered = -1;
  try { remembered = parseInt(readFileSync(SOURCE_MEMO_PATH, 'utf8').trim(), 10); } catch {}
  const indexes = DOWNLOAD_SOURCES.map((_, i) => i);
  if (!Number.isInteger(remembered) || remembered < 0 || remembered >= indexes.length) return indexes;
  return [remembered, ...indexes.filter((i) => i !== remembered)];
}

function rememberSource(index) {
  try { writeFileSync(SOURCE_MEMO_PATH, String(index) + '\n', 'utf8'); } catch {}
}

/** Mirrors that already failed in this process: a dead host stays dead for the
 *  session, so the next install does not pay its connect timeout all over again. */
const deadSources = new Set();

function downloadOrderLive() {
  const order = downloadOrder();
  const alive = order.filter((i) => !deadSources.has(i));
  return alive.length > 0 ? alive : order;
}

/**
 * Move a finished download into its final location, unpacking a macOS .tgz on
 * the way. Windows refuses to rename over an existing file and a running
 * connector keeps the old image locked, so that case gets a readable message
 * instead of a bare errno.
 */
function placeDownloaded(staging, target, asset, platform = process.platform) {
  // The macOS tarball always contains a single entry named `cloudflared`.
  const entryName = 'cloudflared';
  const writeTmp = target + '.tmp';
  try {
    if (asset.archive === 'tgz') {
      const bin = extractFileFromTgz(readFileSync(staging), entryName);
      if (!bin || bin.length < 100_000) throw new Error('no cloudflared binary inside ' + asset.name);
      // Write beside the target first so a failed extract never leaves a
      // half-written binary where the plugin expects a runnable one.
      writeFileSync(writeTmp, bin);
      if (platform === 'win32') { try { unlinkSync(target); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
      renameSync(writeTmp, target);
      // The tarball itself is dead weight once its single entry is extracted.
      try { unlinkSync(staging); } catch {}
    } else if (platform === 'win32') {
      // Windows cannot rename over an existing file.
      try { unlinkSync(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      renameSync(staging, target);
    } else {
      renameSync(staging, target);
    }
  } catch (err) {
    try { unlinkSync(writeTmp); } catch {}
    throw lockedError(err);
  }
  if (asset.executable) { try { chmodSync(target, 0o755); } catch {} }
}

/** Turn "the file is in use / not writable" errnos into something actionable.
 *  `local` marks the failure as a filesystem problem, not a bad download, so
 *  the installer stops instead of blaming the next mirror. */
function lockedError(err) {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
    const e = new Error('无法写入 ' + err.path + '：文件正被占用或没有权限，请先停止正在运行的 cloudflared 再安装');
    e.local = true;
    e.cause = err;
    return e;
  }
  return err;
}

/**
 * Pull a single file out of a .tar.gz buffer (macOS ships cloudflared that way).
 * Only regular-file entries are considered; the release tarball holds exactly
 * one file named `cloudflared`. Returns the file bytes, or null if not found.
 */
function extractFileFromTgz(buf, wanted) {
  let raw;
  try { raw = gunzipSync(buf); } catch (err) { throw new Error('corrupt .tgz archive: ' + err.message); }
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    // An all-zero block marks the end of the archive.
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? prefix + '/' + name : name;
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 48); // '0' or '\0' = regular file
    const dataStart = offset + 512;
    if ((type === '0' || type === '\0') && path.basename(fullName) === wanted) {
      if (dataStart + size > raw.length) throw new Error('truncated .tgz entry');
      return raw.subarray(dataStart, dataStart + size);
    }
    // Headers and data are both padded to a 512-byte boundary.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Stream one download attempt to `part`, reporting byte progress. Rejects on a
 *  connect timeout, a non-2xx status, an idle body, or a short body — so the
 *  caller can move on to the next mirror instead of hanging the panel. */
async function downloadTo(url, part, target) {
  const controller = new AbortController();
  // The connect budget covers the wait for response headers only. Once the body
  // starts arriving, the idle timer is what guards it — keeping the connect timer
  // armed would abort a slow-but-healthy 40 MB download halfway through.
  let connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  let out = null;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    clearTimeout(connectTimer);
    connectTimer = null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = parseInt(res.headers?.get?.('content-length') || '0', 10) || 0;
    setProgress({ state: 'downloading', received: 0, total, percent: 0, path: target, source: url });

    out = createWriteStream(part);
    let received = 0;
    const reader = res.body?.getReader?.();
    if (reader) {
      while (true) {
        armIdle();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        out.write(Buffer.from(value));
        setProgress({
          state: 'downloading', received, total,
          percent: total ? Math.min(100, Math.round(received / total * 100)) : 0,
          path: target, source: url,
        });
      }
    } else if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of res.body) {
        armIdle();
        received += chunk.length;
        out.write(Buffer.from(chunk));
        setProgress({
          state: 'downloading', received, total,
          percent: total ? Math.min(100, Math.round(received / total * 100)) : 0,
          path: target, source: url,
        });
      }
    } else {
      received = Buffer.from(await res.arrayBuffer()).length;
      out.end(Buffer.alloc(0));
    }
    out.end();
    await once(out, 'finish');
    // A truncated body would otherwise install a broken binary.
    if (total && received !== total) throw new Error('incomplete download (' + received + '/' + total + ' bytes)');
    return { received, total };
  } catch (err) {
    if (out) { try { out.destroy(); } catch {} }
    if (err && err.name === 'AbortError') {
      throw new Error('timeout: no response within ' + (CONNECT_TIMEOUT_MS / 1000) + 's or no data for ' + (IDLE_TIMEOUT_MS / 1000) + 's');
    }
    throw err;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
  }
}

function t(v) { return v === undefined || v === null ? '' : String(v); }
function ok(data = {}) { return { ok: true, ...data }; }
function fail(message) { return { ok: false, error: t(message) }; }
function isYes(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
/** cloudflared's `--http-host-header` wants a bare HOSTNAME (e.g. `localhost`),
 *  not a URL. Accept both: if a URL (or `host:port`) is pasted, reduce it to the
 *  hostname so the flag is actually effective. */
function normalizeHostHeader(v) {
  let s = t(v).trim();
  if (!s) return '';
  if (/:\/\//.test(s)) {
    try { s = new URL(s).hostname; }
    catch {
      const m = s.match(/:\/\/(?:[^/@]*@)?([^/:?#]+)/);
      s = m ? m[1] : s;
    }
  } else {
    s = s.split(/[/?#]/)[0].trim();
    if (s.startsWith('[')) { // IPv6 literal, keep [::1] intact
      const m = s.match(/^(\[[^\]]+\])/);
      if (m) s = m[1];
    } else {
      s = s.split(':')[0];
    }
  }
  return s.trim();
}

/** Absolute path of `name` on PATH, honouring PATHEXT on Windows; '' if absent. */
function findOnPath(name) {
  const pathVar = process.env.PATH || '';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return '';
}

function resolveBin() {
  // The plugin-managed copy always wins, so an install through the panel is
  // what actually runs. Then the usual per-platform install locations, and
  // finally whatever `cloudflared` the user already has on PATH.
  const candidates = process.platform === 'win32'
    ? [
      path.join(CLOUDFLARED_CONFIG_DIR, 'cloudflared.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'cloudflared', 'cloudflared.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(os.homedir(), 'cloudflared.exe'),
    ]
    : [
      path.join(CLOUDFLARED_CONFIG_DIR, 'cloudflared'),
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      '/opt/homebrew/bin/cloudflared',
      '/snap/bin/cloudflared',
      path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
    ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return findOnPath('cloudflared') || 'cloudflared';
}

function commandOnPath(name) { return !!findOnPath(name); }
function binaryAvailable() {
  const bin = resolveBin();
  return bin !== 'cloudflared' || commandOnPath('cloudflared');
}
function openInBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch { return false; }
}
/** Wait until wireProcess has captured a login URL (or the process exits/times out). */
function waitForLoginUrl(entry, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    let settled = false;
    let poll = null;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({ url: url || '' });
    };
    const check = () => {
      const m = entry.logs.match(/https:\/\/dash\.cloudflare\.com\/[^\s"'<>]+/i);
      if (m) finish(m[0]);
    };
    const timer = setTimeout(() => { check(); finish(''); }, timeoutMs);
    poll = setInterval(check, 200);
    entry.proc.on('error', () => finish(''));
    entry.proc.on('close', () => { check(); finish(entry.url || ''); });
  });
}

/**
 * Wait briefly for a freshly spawned tunnel process to prove it connected,
 * or to fail. Resolves {connected:boolean, reason?:string, logs?:string}.
 * Recognises cloudflared's "Registered tunnel connection" line as success and
 * common fatal lines as failure. Never kills the process — caller owns it.
 */
function waitForTunnelConnection(entry, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let done = false;
    const FATAL_RE = /credentials file not found|origin cert|failed to (?:parse|connect)|unauthorized|invalid token|could not (?:connect|create)|permission denied|no such file/i;
    const OK_RE = /Registered tunnel connection|Connection registered|tunnel connection.*established/i;
    const finish = (connected, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      entry.proc.off('error', onErr);
      entry.proc.off('close', onClose);
      resolve({ connected, reason: reason || '', logs: entry.logs.slice(-4000) });
    };
    const check = () => {
      if (OK_RE.test(entry.logs)) return finish(true);
      const fm = entry.logs.match(FATAL_RE);
      if (fm) return finish(false, fm[0]);
    };
    const onErr = (err) => finish(false, err.message);
    const onClose = (code) => {
      check();
      if (!done) finish(false, 'process exited with code ' + code);
    };
    const timer = setTimeout(() => { check(); if (!done) finish(false, 'no connection established within ' + Math.round(timeoutMs / 1000) + 's'); }, timeoutMs);
    const poll = setInterval(check, 250);
    entry.proc.on('error', onErr);
    entry.proc.on('close', onClose);
    check();
  });
}

/**
 * Find PIDs of cloudflared tunnel connectors for a specific tunnel id that are
 * NOT tracked in `managed` (e.g. started before a plugin reload, or externally).
 * We decode the JWT token in each process command line and compare its `t` claim.
 */
function findExternalConnectorPids(id) {
  const pids = [];
  try {
    let out = '';
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"name='cloudflared.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"],
        { encoding: 'utf8', timeout: 8000, windowsHide: true });
      out = r.stdout || '';
    } else {
      const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 8000 });
      out = r.stdout || '';
    }
    for (const line of out.split(/\r?\n/)) {
      const bar = line.indexOf('|');
      if (bar < 0) continue;
      const pid = parseInt(line.slice(0, bar).trim(), 10);
      const cmd = line.slice(bar + 1);
      if (!Number.isInteger(pid) || !/cloudflared/i.test(cmd) || !/\btunnel\b/i.test(cmd)) continue;
      const tok = cmd.match(/ey[A-Za-z0-9_-]{10,}={0,2}(?:\.ey[A-Za-z0-9_-]{10,}={0,2})*/);
      if (!tok) continue;
      try {
        // Tokens are either a single base64 JSON blob ({"a","s","t"}) or a
        // dotted JWT whose middle segment carries the claims. Try both.
        const parts = tok[0].split('.');
        const candidates = parts.length >= 3 ? [parts[1], parts[0]] : [parts[0]];
        for (const c of candidates) {
          const b64 = c.replace(/-/g, '+').replace(/_/g, '/');
          const claim = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
          if (claim.t === id) { pids.push(pid); break; }
        }
      } catch {}
    }
  } catch {}
  return pids;
}

/**
 * Restart a named-tunnel connector so it reloads its remote config.
 * cloudflared does not hot-reload ingress changes made through the API: a
 * connector that started before the change keeps serving the old rules.
 * Resolves {restarted:boolean, error?:string, pid?:number}.
 */
async function restartTunnelConnector(id, existing) {
  const key = 'tunnel:' + id;
  try {
    if (existing && !existing.killed) {
      try { existing.proc.kill(); } catch {}
      existing.killed = true;
      managed.delete(key);
    }
    // Also stop any connector for this tunnel that we don't manage, otherwise
    // the stale connector would keep serving the old (503) config.
    const externalPids = findExternalConnectorPids(id);
    let killedAny = false;
    for (const pid of externalPids) {
      if (pid === process.pid) continue;
      try { process.kill(pid, 'SIGTERM'); killedAny = true; }
      catch { try { process.kill(pid); killedAny = true; } catch {} }
    }
    if (existing || killedAny) {
      // Give the old connectors a moment to release their connections.
      await new Promise((r) => setTimeout(r, 800));
    }
    const tokRes = await run(['tunnel', 'token', id], { timeout: 20_000 });
    const tokBad = cmdFailure(tokRes, 'Failed to obtain tunnel token');
    if (tokBad) return { restarted: false, error: tokBad.error || 'token failed' };
    const token = extractTunnelToken((tokRes.stdout || '') + '\n' + (tokRes.stderr || ''));
    if (!token) return { restarted: false, error: 'Could not read tunnel token from cloudflared output.' };
    const logFile = path.join(LOG_DIR, 'tunnel-' + id.replace(/[^a-z0-9_-]/gi, '_') + '.log');
    mkdirSync(LOG_DIR, { recursive: true });
    const proc = spawn(resolveBin(), ['tunnel', 'run', '--token', token], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { key, proc, pid: proc.pid, logs: '', logFile, url: '', kind: 'tunnel', id, killed: false };
    managed.set(key, entry);
    wireProcess(entry);
    const conn = await waitForTunnelConnection(entry, 15_000);
    if (!conn.connected) {
      try { proc.kill(); } catch {}
      managed.delete(key);
      return { restarted: false, error: 'Tunnel failed to reconnect: ' + (conn.reason || 'unknown') };
    }
    return { restarted: true, pid: proc.pid };
  } catch (err) {
    return { restarted: false, error: err.message };
  }
}

function run(argv, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(resolveBin(), argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve(fail('Failed to start cloudflared: ' + err.message));
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let spawnError = '';
    const timer = setTimeout(() => {
      if (!done) { try { proc.kill(); } catch {} stderr += '\n[plugin] command timed out'; settle(true); }
    }, timeout);
    function settle(timedOut = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A failed spawn (e.g. ENOENT when the binary is missing) must not be
      // reported as a successful run with empty output.
      if (spawnError) return resolve(fail('Failed to run cloudflared: ' + spawnError));
      resolve(ok({ code: proc.exitCode, timedOut, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT) }));
    }
    const cap = (which, buf) => {
      const key = which === 'stdout' ? 'stdout' : 'stderr';
      if (key === 'stdout') stdout += buf.toString(); else stderr += buf.toString();
      if ((key === 'stdout' ? stdout : stderr).length > MAX_OUTPUT) {
        if (key === 'stdout') stdout = stdout.slice(0, MAX_OUTPUT); else stderr = stderr.slice(0, MAX_OUTPUT);
        try { proc.kill(); } catch {}
      }
    };
    proc.stdout.on('data', (b) => cap('stdout', b));
    proc.stderr.on('data', (b) => cap('stderr', b));
    proc.on('error', (err) => { spawnError = err.message; settle(); });
    proc.on('close', () => settle());
  });
}

/** Minimal shell-like splitter: supports single/double quotes, no expansion. */
function parseArgv(input) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    let token = m[1] ?? m[2] ?? m[3] ?? '';
    out.push(token.replace(/\\(["'\\])/g, '$1'));
  }
  return out;
}

function formatOutput(r) {
  if (!r.ok) return r.error;
  const chunks = [];
  if (r.stdout) chunks.push(r.stdout);
  if (r.stderr) chunks.push('[stderr]\n' + r.stderr);
  if (r.timedOut) chunks.push('[timed out]');
  return chunks.join('\n') || '(no output)';
}

/** `run()` reports ok:true for any spawned command (it only records the exit
 *  code in `r.code`). Callers that treat that as "command succeeded" will
 *  wrongly report failures as success. Use this to judge the actual process
 *  result and build a fail() carrying cloudflared's real stderr/stdout. */
function cmdFailure(r, fallback) {
  if (!r) return fail(fallback || 'command failed');
  if (!r.ok) return r; // run-level failure (spawn error) is already a fail()
  if (r.timedOut) return fail((fallback || 'command') + ': timed out');
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    return fail((fallback || 'command failed') + (detail ? ': ' + detail : ' (exit code ' + r.code + ')'));
  }
  return null;
}

/** Pull the first http(s) URL out of cloudflared's login output. */
function extractLoginUrl(text) {
  const m = String(text || '').match(/https:\/\/[^\s"']+/);
  return m ? m[0] : '';
}

/** Extract a cloudflared tunnel token from arbitrary command output.
 *  `tunnel token` normally prints one compact base64url blob (starts with
 *  "eyJ", no dots) but newer builds may emit a dotted JWT, and warnings can
 *  share the line. Scan BOTH stdout and stderr and match anywhere in the text
 *  rather than requiring a bare line. */
function extractTunnelToken(text) {
  const src = String(text || '');
  // Full dotted JWT: header.payload.signature (allow base64 padding on segments).
  const jwt = src.match(/ey[A-Za-z0-9_-]{8,}={0,2}\.ey[A-Za-z0-9_-]{8,}={0,2}\.[A-Za-z0-9_-]{8,}={0,2}/);
  if (jwt) return jwt[0];
  // Single compact base64url blob. IMPORTANT: `tunnel token` sometimes emits a
  // standard-base64 token padded with one/two '=' (e.g. "...In0="). Including
  // the padding is required — a truncated token is rejected as invalid.
  const blob = src.match(/ey[A-Za-z0-9_-]{20,}={0,2}/);
  return blob ? blob[0] : '';
}

/** Two-step confirmation gate shared by UI and Agent tool paths.
 *  The token is bound to BOTH the method and the arguments, so a token issued
 *  for one action cannot be replayed against a different (possibly destructive)
 *  action that happens to share the same arguments. */
function confirmGate(method, args) {
  const now = Date.now();
  // Tokens are short-lived; purge expired ones so the Map cannot grow forever.
  for (const [key, entry] of confirmations) {
    if (now - entry.at > CONFIRM_TTL_MS) confirmations.delete(key);
  }
  const token = t(args.token);
  // Bind method to payload to prevent cross-method replay.
  const payload = method + '\u0000' + safePayload(args);
  if (!token) {
    const fresh = 'cf-' + randomUUID();
    confirmations.set(fresh, { payload, at: now });
    return { need: true, token: fresh };
  }
  if (!isYes(args.confirmed) || confirmations.get(token)?.payload !== payload) {
    return { need: true, token };
  }
  confirmations.delete(token);
  return { need: false, token };
}
function safePayload(args) {
  const { token, confirmed, forceConfirmed, ...rest } = args || {};
  return JSON.stringify(rest);
}

// The cert.pem written by `tunnel login` is an ARGO TUNNEL TOKEN: a base64
// payload decoding to { apiToken, accountID, zoneID }. That apiToken is a
// normal Cloudflare API token, so we can read/write a tunnel's remote ingress
// config directly — no separate user-supplied API token is required.
function cloudflareApiToken() {
  try {
    const raw = readFileSync(CERT_PATH, 'utf8');
    const b64 = raw.split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s && !/BEGIN|END/.test(s)).join('');
    if (!b64) return null;
    let padded = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    const info = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (!info.apiToken || !info.accountID) return null;
    return { apiToken: info.apiToken, accountID: info.accountID, zoneID: info.zoneID || '' };
  } catch { return null; }
}

// Minimal HTTPS JSON caller using the bundled Node runtime (no curl dependency).
function cfApi(pathname, { method = 'GET', apiToken, body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.cloudflare.com',
      port: 443,
      path: pathname,
      method,
      headers: {
        Authorization: 'Bearer ' + apiToken,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, json: JSON.parse(data) }); }
        catch { resolve({ ok: false, error: 'Invalid JSON from Cloudflare API (HTTP ' + res.statusCode + ')' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Cloudflare API timeout')));
    req.on('error', (e) => resolve({ ok: false, error: 'Cloudflare API error: ' + e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Per user policy: only deleting a tunnel requires a second confirmation.
// Every other operation (install/update/create/rename/start/stop/route/save/
// exec) runs directly; the Agent tool follows the same rule.
const WRITE_ACTIONS = new Set(['deleteTunnel']);

// Named-tunnel commands need a login certificate (cert.pem); quick tunnels do not.
// Without this guard cloudflared dumps a raw, confusing "Cannot determine default
// origin certificate path" error. Fail early with an actionable Chinese message.
const CERT_REQUIRED = new Set(['listTunnels', 'createTunnel', 'deleteTunnel', 'renameTunnel', 'routeDns', 'startTunnel', 'getIngress', 'setIngress']);
const NEED_LOGIN_MSG = '尚未登录 Cloudflare：未找到 cert.pem。请先在「环境」页点击「打开登录页面」完成授权，再执行该操作。';
const CERT_ERR_RE = /Cannot determine default origin certificate path|Error locating origin cert|didn't specify origincert|origincert path/i;

const METHODS = [
  'status', 'loginStatus', 'openLogin', 'latestVersion', 'install', 'installProgress', 'update',
  'listTunnels', 'createTunnel', 'deleteTunnel', 'renameTunnel', 'routeDns',
  'startTunnel', 'startQuick', 'stopProcess', 'listProcesses', 'processLogs',
  'readConfig', 'saveConfig', 'openFolder', 'exec', 'getIngress', 'setIngress',
];

async function dispatch(method, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  if (!METHODS.includes(method)) return fail('Unknown method: ' + t(method));
  if (CERT_REQUIRED.has(method) && !existsSync(CERT_PATH)) {
    return fail(NEED_LOGIN_MSG);
  }
  if (WRITE_ACTIONS.has(method)) {
    const g = confirmGate(method, args);
    if (g.need) return ok({ confirmationRequired: true, token: g.token, message: 'This action requires a second confirmation.' });
  }
  switch (method) {
    case 'status': {
      const bin = resolveBin();
      let version = '';
      try {
        const r = await run(['--version'], { timeout: 10_000 });
        if (r.ok) version = (r.stdout || r.stderr).trim().split('\n')[0];
      } catch {}
      const asset = releaseAsset();
      return ok({
        installed: !!version, version, path: bin,
        platform: process.platform, arch: process.arch,
        // What an install would fetch here, so the UI can show it up front.
        asset: asset ? asset.name : '',
        supported: !!asset,
        configDir: CLOUDFLARED_CONFIG_DIR,
      });
    }
    case 'loginStatus':
      return ok({ loggedIn: existsSync(CERT_PATH), certPath: CERT_PATH });
    case 'openLogin': {
      if (!binaryAvailable()) {
        return fail('未找到 cloudflared 可执行文件，请先安装 CLI。');
      }
      // `tunnel login` opens a browser and waits for authentication. Running it
      // through run() would block for the full 30s timeout with no feedback.
      // Instead, manage it like a long-running process, capture the login URL
      // cloudflared prints, and open that URL for the user.
      if (existsSync(CERT_PATH)) {
        return ok({ url: '', output: 'already logged in (cert.pem exists)', opened: false, loggedIn: true });
      }
      const key = 'login';
      const existing = managed.get(key);
      if (existing && !existing.killed) {
        const url = existing.url || '';
        return ok({ url, output: existing.logs.slice(-4000), opened: !!url && openInBrowser(url), loggedIn: false });
      }
      const logFile = path.join(LOG_DIR, 'login.log');
      try {
        mkdirSync(LOG_DIR, { recursive: true });
        const proc = spawn(resolveBin(), ['tunnel', 'login'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const entry = { key, proc, pid: proc.pid, logs: '', logFile, url: '', kind: 'login', killed: false };
        managed.set(key, entry);
        wireProcess(entry);
        const { url } = await waitForLoginUrl(entry, 12_000);
        const opened = !!url && openInBrowser(url);
        return ok({
          url,
          output: entry.logs.slice(-4000) || '(waiting for browser authentication...)',
          opened,
          loggedIn: false,
          message: url
            ? (opened ? '已打开登录页面，请在浏览器中完成授权。' : '请在浏览器中打开下面的链接完成授权。')
            : '已启动登录流程，但未捕获到登录链接，请稍后查看进程日志。',
        });
      } catch (err) { return fail('启动登录失败: ' + err.message); }
    }
    case 'installProgress':
      return ok({ progress: installProgress });
    case 'latestVersion': {
      try {
        const res = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { headers: { 'user-agent': 'dsh-cloudflared-plugin' } });
        if (!res.ok) return fail('GitHub API returned ' + res.status);
        const data = await res.json();
        return ok({ tag: data.tag_name, url: data.html_url });
      } catch (err) { return fail(err.message); }
    }
    case 'install': {
      const asset = releaseAsset();
      if (!asset) {
        return fail('未知平台 ' + process.platform + '/' + process.arch
          + '，无法自动安装。请手动下载：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/');
      }
      mkdirSync(CLOUDFLARED_CONFIG_DIR, { recursive: true });
      const target = path.join(CLOUDFLARED_CONFIG_DIR, binName());
      // A tarball is fetched to a staging path and unpacked afterwards; a bare
      // binary is fetched straight to `.part` and renamed into place.
      const staging = target + (asset.archive ? '.download' : '.part');
      const attempts = [];
      for (const index of downloadOrderLive()) {
        const sourceUrl = DOWNLOAD_SOURCES[index](asset.url);
        setProgress({ state: 'starting', received: 0, total: 0, percent: 0, path: target, source: sourceUrl });
        try {
          const { received, total } = await downloadTo(sourceUrl, staging, target);
          if (received < 100_000) throw new Error('downloaded file is too small (' + received + ' bytes)');
          placeDownloaded(staging, target, asset);
          rememberSource(index);
          deadSources.delete(index);
          setProgress({ state: 'done', received, total: total || received, percent: 100, path: target, source: sourceUrl });
          return ok({ path: target, bytes: received, source: sourceUrl, asset: asset.name });
        } catch (err) {
          // A locked/permission-denied target is not the mirror's fault: trying
          // the next source would just download 40 MB again to fail the same way.
          if (err && err.local) {
            setProgress({ state: 'error', error: err.message, received: 0, total: 0, percent: 0, path: target });
            return fail(err.message);
          }
          deadSources.add(index);
          attempts.push(sourceUrl + ' → ' + describeDownloadError(err));
        } finally {
          // Always drop the staging file: it is either already renamed into
          // place (so it no longer exists) or a partial/corrupt leftover.
          try { unlinkSync(staging); } catch {}
        }
      }
      setProgress({ state: 'error', error: attempts.join('; '), received: 0, total: 0, percent: 0, path: target });
      return fail('下载失败，已依次尝试 ' + attempts.length + ' 个源：' + attempts.join('；')
        + '。若本机网络无法访问 GitHub，可手动下载 ' + asset.name
        + ' 并放到 ' + target + '（Linux/macOS 记得 chmod +x）。');
    }
    case 'update':
      return dispatch('install', { ...args, token: t(args.token) || undefined });
    case 'listTunnels': {
      const r = await run(['tunnel', 'list'], { timeout: 15_000 });
      const bad = cmdFailure(r, 'Failed to list tunnels');
      if (bad) return bad;
      if (!r.stdout.trim() && r.stderr.trim()) return fail(r.stderr.trim());
      return ok({ output: r.stdout || '(no tunnels)' });
    }
    case 'createTunnel': {
      const name = t(args.name).trim();
      if (!name) return fail('name is required');
      const r = await run(['tunnel', 'create', name], { timeout: 15_000 });
      const bad = cmdFailure(r, 'Failed to create tunnel');
      if (bad) return bad;
      const match = r.stdout.match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
      return ok({ id: match ? match[1] : '', output: formatOutput(r) });
    }
    case 'deleteTunnel': {
      const id = t(args.id).trim();
      if (!id) return fail('id is required');
      const r = await run(['tunnel', 'delete', id], { timeout: 15_000 });
      const bad = cmdFailure(r, 'Failed to delete tunnel');
      if (bad) return bad;
      return ok({ output: formatOutput(r) });
    }
    case 'renameTunnel': {
      const id = t(args.id).trim(); const name = t(args.name).trim();
      if (!id || !name) return fail('id and name are required');
      const r = await run(['tunnel', 'rename', id, name], { timeout: 15_000 });
      const bad = cmdFailure(r, 'Failed to rename tunnel');
      if (bad) return bad;
      return ok({ output: formatOutput(r) });
    }
    case 'routeDns': {
      const id = t(args.id).trim(); const domain = t(args.domain).trim();
      if (!id || !domain) return fail('id and domain are required');
      const r = await run(['tunnel', 'route', 'dns', id, domain], { timeout: 15_000 });
      const bad = cmdFailure(r, 'Failed to add DNS route');
      if (bad) return bad;
      return ok({ output: formatOutput(r) });
    }
    case 'getIngress': {
      const id = t(args.id).trim();
      if (!id) return fail('id is required');
      const cred = cloudflareApiToken();
      if (!cred) return fail('无法从 cert.pem 读取 Cloudflare API 凭据，请重新登录。');
      const url = '/client/v4/accounts/' + encodeURIComponent(cred.accountID) + '/cfd_tunnel/' + encodeURIComponent(id) + '/configurations';
      const r = await cfApi(url, { apiToken: cred.apiToken });
      if (!r.ok) return fail(r.error);
      if (!r.json || r.json.success === false) {
        const msg = r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message;
        return fail('读取 Ingress 配置失败' + (msg ? '：' + msg : ''));
      }
      const res = r.json.result || {};
      return ok({ id, version: res.version, config: res.config || null, source: res.source || '' });
    }
    case 'setIngress': {
      const id = t(args.id).trim();
      const rules = Array.isArray(args.rules) ? args.rules : null;
      if (!id || !rules) return fail('id and rules are required');
      // Normalise and validate rules on the host: hostname optional (catch-all
      // must be last), service required. Preserve warp-routing if present.
      const ingress = [];
      for (const row of rules) {
        if (!row || typeof row !== 'object') continue;
        const hostname = t(row.hostname).trim();
        const service = t(row.service).trim();
        if (!service) return fail('每条规则都必须填写 Service');
        const item = hostname ? { hostname, service } : { service };
        // Preserve originRequest options (e.g. httpHostHeader) so a UI save
        // does not silently drop the Host-header rewrite some backends need.
        if (row.originRequest && typeof row.originRequest === 'object') {
          const origin = {};
          for (const [k, v] of Object.entries(row.originRequest)) {
            if (typeof v !== 'undefined' && v !== '') origin[k] = v;
          }
          if (Object.keys(origin).length) item.originRequest = origin;
        }
        ingress.push(item);
      }
      if (!ingress.length) return fail('至少需要一条规则');
      const last = ingress[ingress.length - 1];
      if (last.hostname) return fail('最后一条必须是兜底规则（Hostname 留空，如 http_status:404）');
      for (let i = 0; i < ingress.length - 1; i++) {
        if (!ingress[i].hostname) return fail('只有最后一条规则可以留空 Hostname');
      }
      const cred = cloudflareApiToken();
      if (!cred) return fail('无法从 cert.pem 读取 Cloudflare API 凭据，请重新登录。');
      // Fetch current config to preserve warp-routing and other keys.
      const base = '/client/v4/accounts/' + encodeURIComponent(cred.accountID) + '/cfd_tunnel/' + encodeURIComponent(id) + '/configurations';
      const cur = await cfApi(base, { apiToken: cred.apiToken });
      let config = { ingress };
      if (cur.ok && cur.json && cur.json.success && cur.json.result && cur.json.result.config) {
        config = { ...cur.json.result.config, ingress };
      }
      const r = await cfApi(base, { method: 'PUT', apiToken: cred.apiToken, body: { config } });
      if (!r.ok) return fail(r.error);
      if (!r.json || r.json.success === false) {
        const msg = r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message;
        return fail('保存 Ingress 配置失败' + (msg ? '：' + msg : ''));
      }
      // cloudflared does NOT hot-reload a remote config change: a connector that
      // started before this PUT keeps serving the old rules (typically 503
      // "No ingress rules were defined"). Restart any connector we manage for
      // this tunnel so the new ingress takes effect immediately.
      let restarted = false;
      let restartError = '';
      const key = 'tunnel:' + id;
      const existing = managed.get(key);
      const hasExternal = findExternalConnectorPids(id).length > 0;
      if ((existing && !existing.killed) || hasExternal) {
        const rr = await restartTunnelConnector(id, existing && !existing.killed ? existing : null);
        restarted = rr.restarted;
        restartError = rr.error || '';
      }
      return ok({ id, version: r.json.result && r.json.result.version, config: r.json.result && r.json.result.config, restarted, restartError });
    }
    case 'startTunnel': {
      const id = t(args.id).trim();
      if (!id) return fail('id is required');
      const key = 'tunnel:' + id;
      const existing = managed.get(key);
      if (existing && !existing.killed) return ok({ pid: existing.pid, message: 'already running', logs: existing.logs.slice(-4000) });
      // Named tunnels started without a legacy credentials JSON must use a token.
      // `tunnel run <id>` fails with "credentials file not found" in that case.
      const tokRes = await run(['tunnel', 'token', id], { timeout: 20_000 });
      const tokBad = cmdFailure(tokRes, 'Failed to obtain tunnel token');
      if (tokBad) return tokBad;
      // Scan both streams; a warning or error message may share the token line.
      const token = extractTunnelToken((tokRes.stdout || '') + '\n' + (tokRes.stderr || ''));
      if (!token) {
        const detail = (tokRes.stderr || tokRes.stdout || '').trim().slice(0, 600);
        return fail('Could not read tunnel token from cloudflared output.' + (detail ? ' cloudflared said: ' + detail : ''));
      }
      const logFile = path.join(LOG_DIR, 'tunnel-' + id.replace(/[^a-z0-9_-]/gi, '_') + '.log');
      try {
        mkdirSync(LOG_DIR, { recursive: true });
        const proc = spawn(resolveBin(), ['tunnel', 'run', '--token', token], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const entry = { key, proc, pid: proc.pid, logs: '', logFile, url: '', kind: 'tunnel', id, killed: false };
        managed.set(key, entry);
        wireProcess(entry);
        const conn = await waitForTunnelConnection(entry, 15_000);
        if (!conn.connected) {
          // Reap the failed process so it doesn't linger as "running".
          try { proc.kill(); } catch {}
          managed.delete(key);
          return fail('Tunnel failed to connect: ' + (conn.reason || 'unknown') + (conn.logs ? '\n' + conn.logs : ''));
        }
        return ok({ pid: proc.pid, id, message: 'tunnel connected', logs: conn.logs });
      } catch (err) { return fail('Failed to start tunnel: ' + err.message); }
    }
    case 'startQuick': {
      const port = parseInt(t(args.port) || '8080', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('port must be 1..65535');
      const host = normalizeHostHeader(args.host);
      const existing = managed.get('quick');
      if (existing && !existing.killed) return ok({ pid: existing.pid, url: existing.url, message: 'already running' });
      const argv = ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'];
      if (host) argv.push('--http-host-header', host);
      const logFile = path.join(LOG_DIR, 'quick.log');
      try {
        mkdirSync(LOG_DIR, { recursive: true });
        const proc = spawn(resolveBin(), argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const entry = { key: 'quick', proc, pid: proc.pid, logs: '', logFile, url: '', kind: 'quick', killed: false };
        managed.set('quick', entry);
        wireProcess(entry);
        return ok({ pid: proc.pid });
      } catch (err) { return fail('Failed to start quick tunnel: ' + err.message); }
    }
    case 'stopProcess': {
      const key = t(args.key).trim();
      const entry = managed.get(key);
      if (!entry) return fail('no managed process with key ' + key);
      try { entry.proc.kill(); } catch {}
      entry.killed = true;
      managed.delete(key);
      return ok({ stopped: true });
    }
    case 'listProcesses':
      return ok({ processes: [...managed.entries()].map(([key, e]) => ({ key, pid: e.pid, kind: e.kind, id: e.id || '', url: e.url, alive: !e.killed })) });
    case 'processLogs': {
      const key = t(args.key).trim();
      const entry = managed.get(key);
      return ok({ logs: entry ? entry.logs.slice(-8000) : '', url: entry ? entry.url : '' });
    }
    case 'readConfig': {
      try {
        return ok({ content: existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '', path: CONFIG_PATH });
      } catch (err) { return fail(err.message); }
    }
    case 'saveConfig': {
      const content = typeof args.content === 'string' ? args.content : '';
      try {
        mkdirSync(CLOUDFLARED_CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, content, 'utf8');
        return ok({ path: CONFIG_PATH, bytes: Buffer.byteLength(content) });
      } catch (err) { return fail(err.message); }
    }
    case 'openFolder': {
      try {
        mkdirSync(CLOUDFLARED_CONFIG_DIR, { recursive: true });
        const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        spawn(cmd, [CLOUDFLARED_CONFIG_DIR], { detached: true, stdio: 'ignore' });
        return ok({ path: CLOUDFLARED_CONFIG_DIR });
      } catch (err) { return fail(err.message); }
    }
    case 'exec': {
      const raw = t(args.args).trim();
      if (!raw) return fail('args is required');
      const argv = parseArgv(raw);
      if (!argv.length || argv[0].toLowerCase() === 'cloudflared') return fail('provide cloudflared subcommand arguments, e.g. "tunnel list"');
      // A named-tunnel command that needs a cert should give a friendly hint
      // unless the user explicitly supplied an origincert / TUNNEL_ORIGIN_CERT.
      const namedTunnel = /\btunnel\b/i.test(raw) && !/\btunnel\s+(--url|login)/i.test(raw)
        && !/--origincert|TUNNEL_ORIGIN_CERT/i.test(raw) && !process.env.TUNNEL_ORIGIN_CERT;
      if (namedTunnel && !existsSync(CERT_PATH)) return fail(NEED_LOGIN_MSG);
      const r = await run(argv, { timeout: Math.max(1, Math.min(300, parseInt(t(args.timeout) || '30', 10))) * 1000 });
      const output = formatOutput(r);
      if (CERT_ERR_RE.test(output)) return fail(NEED_LOGIN_MSG);
      return ok({ argv, output, code: r.code, timedOut: r.timedOut });
    }
    default:
      return fail('Unknown method: ' + t(method));
  }
}

function wireProcess(entry) {
  const handle = (buf) => {
    const text = buf.toString();
    entry.logs = (entry.logs + text).slice(-20_000);
    // Async append so a chatty process never blocks the event loop.
    try { appendFile(entry.logFile, text, () => {}); } catch {}
    const quick = entry.logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (quick) entry.url = quick[0];
    // `tunnel login` prints a dash.cloudflare.com URL that the user must open.
    const login = entry.logs.match(/https:\/\/dash\.cloudflare\.com\/[^\s"'<>]+/i);
    if (login) entry.url = login[0];
  };
  entry.proc.stdout.on('data', handle);
  entry.proc.stderr.on('data', handle);
  entry.proc.on('error', (err) => { entry.logs += '\n[error] ' + err.message; });
  entry.proc.on('close', (code) => {
    entry.logs += '\n[exited ' + code + ']';
    entry.killed = true;
    managed.delete(entry.key); // don't leave stale entries for exited processes
  });
}

/* ---------- HTTP + JSON helpers (webServer handler owns the response) ---------- */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.destroy(); // stop reading instead of leaving the socket hanging
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const CLOUDFLARED_TOOL = {
  name: 'cloudflared',
  description: 'Manage this machine\'s cloudflared CLI and Cloudflare Tunnels: status, login, check/upgrade CLI, list/create/delete/rename tunnels, DNS routes, start/stop tunnel or quick tunnel, config.yml, and a safe argv command executor. Only deleting a tunnel (deleteTunnel) needs a second confirmation: the first call returns a confirmation token; repeat with args.confirmed=true and args.token to carry it out. Never bypass that confirmation.',
  parameters: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        description: 'One of: ' + METHODS.join(', ') + '.',
      },
      args: {
        type: 'object', additionalProperties: true,
        description: 'Method arguments. Only deleteTunnel needs {token, confirmed:true} after the first call returns confirmationRequired. Common fields: name, id, domain, port, host, key, content, args, timeout.',
      },
    },
    required: ['method'],
  },
  output: {
    schema: {
      type: 'object', additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        error: { type: 'string' },
        confirmationRequired: { type: 'boolean' },
        token: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? _args, null, 2) }],
  },
  async execute({ method, args }) {
    return dispatch(method, args);
  },
};

export function apply(ctx) {
  // Admission is owned by the webServer: the route declares no `auth`, so it
  // keeps the default `required` policy and every request is admitted (or
  // refused) before the handler runs. DSH 0.2.2 removed the old
  // `connection.requestRejection` check this plugin used to perform here.
  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }
      try {
        const body = await readBody(req);
        const result = await dispatch(t(body.method), body.args || {});
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, fail(err.message));
      }
    },
  });
  ctx.effect(() => disposeRoute, 'cloudflared: JSON route');

  ctx.effect(() => ctx.tools.register(CLOUDFLARED_TOOL), 'cloudflared: agent tool');

  // effect() invokes its callback immediately and treats the RETURNED value as
  // the disposer — so the teardown must be returned, not executed up front.
  ctx.effect(() => () => {
    for (const entry of managed.values()) { try { entry.proc.kill(); } catch {} }
    managed.clear();
    confirmations.clear();
  }, 'cloudflared: cleanup');
}

export { dispatch, ROUTE_PATH };
