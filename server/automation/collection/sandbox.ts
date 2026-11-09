import { spawn } from 'node:child_process';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SandboxCapability {
  platform: NodeJS.Platform;
  backend: 'macos-seatbelt' | 'unsupported';
  available: boolean;
  /** Only a successful kernel-enforced boundary probe sets verified=true. */
  verified: boolean;
  reason?: string;
  pythonPath?: string;
  runtimeRoot?: string;
  dependencyRoots?: string[];
  checkedAt: string;
}
export interface SandboxFile { path: string; content: string | Buffer }
export interface PythonSandboxInput {
  code: SandboxFile[];
  samples: SandboxFile[];
  entryPoint: string;
  manifest: unknown;
  pythonPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface PythonSandboxResult {
  status: 'completed' | 'failed' | 'unsupported' | 'aborted' | 'timeout';
  capability: SandboxCapability;
  output?: unknown;
  reason?: string;
}

// This trusted launcher executes no candidate code before sandbox_init succeeds.
// The profile is applied by the kernel; Python hooks/static analysis are NOT the boundary.
const BOOTSTRAP = String.raw`
import ctypes, errno, importlib.util, json, os, resource, sys
root = sys.argv[1]
with open(os.path.join(root, "control.json"), encoding="utf-8") as file:
    control = json.load(file)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_CPU, (control["cpuSeconds"], control["cpuSeconds"]))
resource.setrlimit(resource.RLIMIT_FSIZE, (control["maxBytes"], control["maxBytes"]))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
library = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
apply_sandbox = library.sandbox_init
apply_sandbox.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)]
apply_sandbox.restype = ctypes.c_int
error = ctypes.c_char_p()
if apply_sandbox(control["profile"].encode("utf-8"), 0, ctypes.byref(error)) != 0:
    # Do not expose arbitrary process/environment diagnostics to the application.
    sys.exit(78)
# A separate descriptor gives the parent a trusted startup receipt before importing code.
os.write(3, b"seatbelt-installed\n")
os.close(3)
if control["probe"]:
    import socket, subprocess
    denied = {}
    def check(name, action):
        try:
            action()
            denied[name] = False
        except OSError as failure:
            denied[name] = failure.errno in (errno.EPERM, errno.EACCES)
    check("read", lambda: open(control["forbiddenRead"], "rb").read())
    check("write", lambda: open(control["forbiddenWrite"], "wb").write(b"forbidden"))
    check("inputWrite", lambda: open(os.path.join(root, "samples", "probe"), "wb").write(b"forbidden"))
    check("network", lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect(("127.0.0.1", 9)))
    check("subprocess", lambda: subprocess.run(["/usr/bin/true"], check=True))
    check("fork", lambda: os.fork())
    check("exec", lambda: os.execv(control["pythonPath"], [control["pythonPath"], "-c", "pass"]))
    denied["environment"] = "COLLECTION_SANDBOX_HOST_CANARY" not in os.environ
    with open(os.path.join(root, "output", "result.json"), "w", encoding="utf-8") as file:
        json.dump(denied, file)
    sys.exit(0)
for dependency in control["dependencyRoots"]:
    sys.path.append(dependency)
sys.path.insert(0, os.path.join(root, "code"))
module_name = control["entryPoint"][:-3].replace("/", ".")
module = __import__(module_name, fromlist=["*"])
records = []
for sample in control["manifest"]:
    with open(os.path.join(root, "samples", sample["file"]), "rb") as file:
        raw = file.read()
    if hasattr(module, "extract_page"):
        parsed = module.extract_page(raw.decode(sample.get("encoding", "utf-8"), errors="replace"), sample["url"])
        value = {"body": parsed.get("fullText", ""), "entities": parsed.get("entities", []),
                 "links": [link.get("url", "") if isinstance(link, dict) else link for link in parsed.get("links", [])], "parsed": parsed}
    else:
        value = module.extract(raw, {"id": sample["id"], "url": sample["url"], "outputDirectory": os.path.join(root, "output")})
    records.append({"id": sample["id"], "value": value})
with open(os.path.join(root, "output", "result.json"), "w", encoding="utf-8") as file:
    json.dump({"records": records}, file, ensure_ascii=False, allow_nan=False)
`;

function cleanEnv(root: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: path.join(root, 'output'), LANG: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' };
}
function quoted(value: string) { return JSON.stringify(value); }
function profile(root: string, runtimeRoot: string, dependencyRoots: string[]) {
  return `(version 1)(deny default)
(allow file-read* (subpath ${quoted(runtimeRoot)}) (subpath "/System/Library") (subpath "/usr/lib")
  ${dependencyRoots.map(directory => `(subpath ${quoted(directory)})`).join(' ')}
  (subpath ${quoted(path.join(root, 'code'))}) (subpath ${quoted(path.join(root, 'samples'))})
  (subpath ${quoted(path.join(root, 'output'))}) (literal "/dev/null") (literal "/dev/urandom"))
(allow file-write* (literal ${quoted(path.join(root, 'output', 'result.json'))}))
; network, mach services, sysctl/process inspection, fork, exec and arbitrary files remain denied
`;
}
function unsupported(reason: string, platform: NodeJS.Platform = process.platform): SandboxCapability {
  return { platform, backend: 'unsupported', available: false, verified: false, reason, checkedAt: new Date().toISOString() };
}

function runProcess(executable: string, args: string[], root: string, options: {
  signal?: AbortSignal; timeoutMs: number; maxOutputBytes: number; receipt?: boolean;
}): Promise<{ status: 'completed' | 'failed' | 'aborted' | 'timeout'; stdout: string; installed: boolean; code: number | null }> {
  return new Promise(resolve => {
    if (options.signal?.aborted) { resolve({ status: 'aborted', stdout: '', installed: false, code: null }); return; }
    const child = spawn(executable, args, { cwd: root, env: cleanEnv(root), detached: true,
      stdio: options.receipt ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', size = 0, installed = false, stopped: 'aborted' | 'timeout' | 'failed' | undefined;
    const killTree = (status: typeof stopped) => {
      if (stopped) return;
      stopped = status;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const abort = () => killTree('aborted');
    const timer = setTimeout(() => killTree('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (bytes: Buffer) => {
      size += bytes.length;
      if (size > options.maxOutputBytes) killTree('failed');
      else stdout += bytes.toString('utf8');
    });
    // Candidate stderr is intentionally discarded: it can contain any readable sample data.
    child.stderr?.on('data', (bytes: Buffer) => { size += bytes.length; if (size > options.maxOutputBytes) killTree('failed'); });
    child.stdio[3]?.on('data', (bytes: Buffer) => { if (bytes.toString() === 'seatbelt-installed\n') installed = true; });
    const finish = (code: number | null) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      // A failed probe must not leave descendants even if the probed process rule broke.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } }
      resolve({ status: stopped ?? (code === 0 ? 'completed' : 'failed'), stdout, installed, code });
    };
    child.once('error', () => finish(null));
    child.once('close', finish);
  });
}

async function runtime(pythonPath?: string): Promise<{ pythonPath: string; runtimeRoot: string; dependencyRoots: string[] } | undefined> {
  const candidates = pythonPath ? [pythonPath] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw new Error('Python runtime path must be absolute');
    try {
      await access(candidate);
      const result = await runProcess(candidate, ['-I', '-S', '-c', 'import json,sys; print(json.dumps({"prefix":sys.base_prefix,"executable":sys.executable,"version":"%s.%s" % sys.version_info[:2]}))'], tmpdir(), { timeoutMs: 5000, maxOutputBytes: 4096 });
      if (result.status !== 'completed') continue;
      const info = JSON.parse(result.stdout);
      const runtimeRoot = await realpath(info.prefix);
      // Never grant the entire filesystem, user profile, or project as a runtime root.
      if (runtimeRoot === '/' || runtimeRoot === '/usr' || !/(?:python|Python)/.test(runtimeRoot) || runtimeRoot.includes('/.data/')) continue;
      const dependencyRoots: string[] = [];
      // A platform venv is an explicit managed runtime, not a grant to its .data parent.
      // Discover only its own site-packages; never execute .pth files or inherit sys.path.
      const venvRoot = path.dirname(path.dirname(candidate));
      try {
        await access(path.join(venvRoot, 'pyvenv.cfg'));
        dependencyRoots.push(await realpath(path.join(venvRoot, 'lib', `python${info.version}`, 'site-packages')));
      } catch { /* System runtimes remain stdlib-only. */ }
      return { pythonPath: await realpath(info.executable), runtimeRoot, dependencyRoots };
    } catch { /* Try the next managed runtime; never fall back to unconfined execution. */ }
  }
  return undefined;
}

export function assertSandboxRelativePath(value: string): void {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?:\.[A-Za-z0-9_-]+)?$/.test(value) || value.split('/').includes('..')) {
    throw new Error('Sandbox path must be a plain relative path without traversal');
  }
}

async function execute(root: string, capability: SandboxCapability, options: PythonSandboxInput, probe?: { forbiddenRead: string; forbiddenWrite: string }) {
  await writeFile(path.join(root, 'bootstrap.py'), BOOTSTRAP, { mode: 0o400 });
  await writeFile(path.join(root, 'control.json'), JSON.stringify({
    profile: profile(root, capability.runtimeRoot!, capability.dependencyRoots ?? []), dependencyRoots: capability.dependencyRoots ?? [], entryPoint: options.entryPoint, manifest: options.manifest,
    maxBytes: options.maxOutputBytes ?? 4 * 1024 * 1024, cpuSeconds: Math.max(1, Math.ceil((options.timeoutMs ?? 10_000) / 1000)),
    probe: Boolean(probe), ...probe, pythonPath: capability.pythonPath,
  }), { mode: 0o400 });
  return runProcess(capability.pythonPath!, ['-I', '-S', path.join(root, 'bootstrap.py'), root], root, {
    signal: options.signal, timeoutMs: options.timeoutMs ?? 10_000, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024, receipt: true,
  });
}
async function workspace() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'collection-sandbox-')));
  for (const directory of ['code', 'samples', 'output']) await mkdir(path.join(root, directory), { mode: 0o700 });
  return root;
}

/** Each probe verifies real kernel denials; no capability is inferred from OS name alone. */
export async function probeSandbox(options: { pythonPath?: string; platform?: NodeJS.Platform } = {}): Promise<SandboxCapability> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' || process.platform !== 'darwin') {
    return unsupported(platform === 'win32'
      ? 'Windows native AppContainer/restricted-token backend has not been implemented and independently boundary-tested; candidate execution is disabled.'
      : 'No verified operating-system isolation backend for this platform; candidate execution is disabled.', platform);
  }
  const python = await runtime(options.pythonPath);
  if (!python) return unsupported('No fixed managed Python runtime could be probed.');
  const capability: SandboxCapability = { platform, backend: 'macos-seatbelt', available: true, verified: false, ...python, checkedAt: new Date().toISOString() };
  const root = await workspace();
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'collection-boundary-')));
  try {
    const forbiddenRead = path.join(outside, 'private-canary'), forbiddenWrite = path.join(outside, 'forbidden-write');
    await writeFile(forbiddenRead, 'not-a-real-secret');
    await writeFile(path.join(root, 'samples', 'probe'), 'read-only');
    const result = await execute(root, capability, { code: [], samples: [], entryPoint: 'probe.py', manifest: [], timeoutMs: 5000 }, { forbiddenRead, forbiddenWrite });
    if (result.status !== 'completed' || !result.installed) {
      return { ...capability, available: false, reason: 'Kernel Seatbelt policy could not be installed or its trusted probe failed (nested sandbox restrictions may deny sandbox_init).' };
    }
    const denied = JSON.parse(await readFile(path.join(root, 'output', 'result.json'), 'utf8'));
    if (!['read', 'write', 'inputWrite', 'network', 'subprocess', 'fork', 'exec', 'environment'].every(key => denied[key] === true)) {
      return { ...capability, available: false, reason: 'At least one kernel boundary probe was not denied; execution is disabled.' };
    }
    return { ...capability, verified: true };
  } catch {
    return { ...capability, available: false, reason: 'Boundary probe failed; execution is disabled.' };
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
}

/** The only execution entrypoint. A fresh successful probe is mandatory, without fallback. */
export async function runSandboxedPython(options: PythonSandboxInput): Promise<PythonSandboxResult> {
  if (options.signal?.aborted) return { status: 'aborted', capability: unsupported('Execution was cancelled before probing.') };
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000)) throw new Error('Invalid sandbox timeout');
  if (options.maxOutputBytes !== undefined && (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 16 * 1024 * 1024)) throw new Error('Invalid sandbox output limit');
  const capability = await probeSandbox({ pythonPath: options.pythonPath });
  if (!capability.available || !capability.verified) return { status: 'unsupported', capability, reason: capability.reason };
  const root = await workspace();
  try {
    assertSandboxRelativePath(options.entryPoint);
    for (const [directory, files] of [['code', options.code], ['samples', options.samples]] as const) {
      const seen = new Set<string>();
      for (const file of files) {
        assertSandboxRelativePath(file.path);
        if (seen.has(file.path)) throw new Error('Duplicate sandbox file');
        seen.add(file.path);
        const destination = path.join(root, directory, file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { mode: 0o400, flag: 'wx' });
        await chmod(destination, 0o400);
      }
    }
    const result = await execute(root, capability, options);
    if (!result.installed && result.status !== 'aborted' && result.status !== 'timeout') return { status: 'unsupported', capability: { ...capability, available: false, verified: false }, reason: 'Candidate was never loaded because kernel policy installation failed.' };
    if (result.status !== 'completed') return { status: result.status, capability, reason: result.status === 'failed' ? 'Candidate execution failed or exceeded the output limit.' : 'Candidate process group was terminated.' };
    const outputPath = path.join(root, 'output', 'result.json');
    // Candidate output may contain symlinks. Resolve before reading; never follow outside output.
    const resolved = await realpath(outputPath);
    if (resolved !== outputPath) return { status: 'failed', capability, reason: 'Candidate result must be a regular output file.' };
    const info = await lstat(outputPath);
    if (!info.isFile() || info.nlink !== 1 || info.size > (options.maxOutputBytes ?? 4 * 1024 * 1024)) return { status: 'failed', capability, reason: 'Candidate result must be a bounded regular file without hardlinks.' };
    const bytes = await readFile(resolved);
    if (bytes.length > (options.maxOutputBytes ?? 4 * 1024 * 1024)) return { status: 'failed', capability, reason: 'Candidate output exceeded the limit.' };
    return { status: 'completed', capability, output: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { status: 'failed', capability, reason: 'Candidate did not produce a valid bounded JSON result.' };
  } finally { await rm(root, { recursive: true, force: true }); }
}
