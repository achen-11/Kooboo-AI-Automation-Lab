import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adoptRepair, repairCandidateHash, repairInputHash, runIsolatedRepair, validateRepairResult, withdrawRepair, type RepairTrialInput } from '../server/automation/collection/repair.js';
import { assertSandboxRelativePath, probeSandbox } from '../server/automation/collection/sandbox.js';
import { applyRepairToCollectionWorkspace, withdrawRepairFromCollectionWorkspace } from '../server/automation/collection/repair-apply.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const repaired = String.raw`
from html.parser import HTMLParser
class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.in_body = False; self.body = []; self.entities = []; self.links = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "main": self.in_body = True
        if tag == "article" and "data-id" in attrs: self.entities.append(attrs["data-id"])
        if tag == "a" and "href" in attrs: self.links.append(attrs["href"])
    def handle_endtag(self, tag):
        if tag == "main": self.in_body = False
    def handle_data(self, data):
        if self.in_body: self.body.append(data)
def extract(raw, context):
    page = Page(); page.feed(raw.decode("utf-8"))
    return {"body": "".join(page.body), "entities": page.entities, "links": page.links}
`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'collection-repair-test-'));
  const engine = 'def extract(raw, context):\n    return {"body":"broken","entities":[],"links":[]}\n';
  const failed = '<nav>导航</nav><main>修复正文 &amp; 原文<article data-id="42"></article></main><a href="/detail.aspx?id=42&amp;lang=cn">条目</a>';
  const normal = '<main>正常正文<article data-id="normal-1"></article><article data-id="normal-2"></article></main><a href="/list_2.aspx?lang=cn">下一页</a>';
  await Promise.all([writeFile(path.join(root, 'extractor.py'), engine), writeFile(path.join(root, 'failure.html'), failed), writeFile(path.join(root, 'normal.html'), normal)]);
  const input: RepairTrialInput = {
    candidate: { id: 'repair-1', taskId: 'collection-task', baseVersion: 'engine-v1', entryPoint: 'extractor.py',
      patches: [{ path: 'extractor.py', content: repaired }], reason: 'Saved template main content was omitted', evidenceIds: ['source-failure-1'], affectedObjects: ['detail:42'] },
    engineFiles: [{ path: 'extractor.py', sourcePath: path.join(root, 'extractor.py'), sha256: hash(engine) }], allowedPatchPaths: ['extractor.py'],
    samples: [
      { id: 'failure', kind: 'failure', sourcePath: path.join(root, 'failure.html'), sha256: hash(failed), url: 'https://example.invalid/detail.aspx?id=42',
        expected: { body: '修复正文 & 原文', entities: ['42'], links: ['/detail.aspx?id=42&lang=cn'] }, expectedVersion: 'independent-fixture-v1' },
      { id: 'normal', kind: 'regression', sourcePath: path.join(root, 'normal.html'), sha256: hash(normal), url: 'https://example.invalid/list.aspx?lang=cn',
        expected: { body: '正常正文', entities: ['normal-1', 'normal-2'], links: ['/list_2.aspx?lang=cn'] }, expectedVersion: 'independent-fixture-v1' },
    ],
  };
  return { root, input, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('fixed parent expectations reject forged pass reports, entity substitutions, link/query loss, duplicates and missing samples', async () => {
  const f = await fixture();
  try {
    const valid = { records: f.input.samples.map(sample => ({ id: sample.id, value: structuredClone(sample.expected) })) };
    assert.equal(validateRepairResult(f.input.samples, valid).passed, true);
    assert.equal(validateRepairResult(f.input.samples, { passed: true }).passed, false);
    for (const field of ['body', 'entities', 'links'] as const) {
      const changed = structuredClone(valid);
      changed.records[0].value[field] = (field === 'body' ? 'wrong' : ['substituted']) as never;
      assert.equal(validateRepairResult(f.input.samples, changed).passed, false);
    }
    assert.equal(validateRepairResult(f.input.samples, { records: [...valid.records, valid.records[0]] }).passed, false);
    assert.equal(validateRepairResult(f.input.samples, { records: valid.records.slice(0, 1) }).passed, false);
    const order = structuredClone(valid); order.records[1].value.entities.reverse();
    assert.equal(validateRepairResult(f.input.samples, order).passed, false);
  } finally { await f.cleanup(); }
});

test('module whitelist, traversal, original hashes, normal regression and expected-version requirements are enforced before execution', async () => {
  const f = await fixture();
  try {
    for (const unsafe of ['../engine.py', '/tmp/engine.py', '.data/key', 'a/../../key', 'a\\engine.py', 'a/./engine.py']) assert.throws(() => assertSandboxRelativePath(unsafe));
    const outside = structuredClone(f.input); outside.candidate.patches[0].path = 'platform.py';
    await assert.rejects(() => runIsolatedRepair(outside), /allowlist/);
    const noNormal = structuredClone(f.input); noNormal.samples = noNormal.samples.slice(0, 1);
    await assert.rejects(() => runIsolatedRepair(noNormal), /normal regression/);
    const unversioned = structuredClone(f.input); unversioned.samples[0].expectedVersion = '';
    await assert.rejects(() => runIsolatedRepair(unversioned), /versioned/);
    await writeFile(f.input.samples[0].sourcePath, 'changed after snapshot');
    await assert.rejects(() => runIsolatedRepair(f.input), /original sample SHA-256/);
  } finally { await f.cleanup(); }
});

test('Windows and unsupported hosts fail closed without invoking a candidate or pretending to have Windows evidence', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const capability = await probeSandbox({ platform });
    assert.equal(capability.available, false); assert.equal(capability.verified, false); assert.equal(capability.backend, 'unsupported');
  }
});

test('adoption cannot accept a JSON report, changed candidate or changed expected metadata', async () => {
  const f = await fixture();
  try {
    const forged = { status: 'passed', passed: true, capability: { available: true, verified: true } };
    assert.throws(() => adoptRepair(f.input, forged as never, 'engine-v1'), /actual successful/);
    const candidateHash = repairCandidateHash(f.input.candidate), inputHash = repairInputHash(f.input);
    f.input.candidate.patches[0].content += '\n# different candidate';
    assert.notEqual(repairCandidateHash(f.input.candidate), candidateHash);
    f.input.samples[0].expected.body = 'changed expectation';
    assert.notEqual(repairInputHash(f.input), inputHash);
  } finally { await f.cleanup(); }
});

test('failure source anchors stay fixed and cannot weaken complete normal regression expectations', async () => {
  const f = await fixture();
  try {
    const sample = f.input.samples[0];
    sample.bodyContains = ['保存原件中的固定正文证据'];
    const output = { records: f.input.samples.map(item => ({ id: item.id, value: structuredClone(item.expected) })) };
    output.records[0].value.body = '其他文字，保存原件中的固定正文证据，其他文字';
    assert.equal(validateRepairResult(f.input.samples, output).passed, true);
    output.records[1].value.body += 'changed normal template';
    assert.equal(validateRepairResult(f.input.samples, output).passed, false);
    await assert.rejects(() => runIsolatedRepair(f.input), /quote is not present/);
    f.input.samples[1].bodyContains = ['不能用锚点绕过完整的正常回归'];
    await assert.rejects(() => runIsolatedRepair(f.input), /failure samples/);
  } finally { await f.cleanup(); }
});

test('host previous body rejects already-satisfied failure baselines and stays part of immutable expected metadata', async () => {
  const f = await fixture();
  try {
    const sample = f.input.samples[0];
    sample.previousBody = '已有正文中的完整固定证据';
    sample.bodyContains = ['已有正文中的完整固定证据'];
    const before = repairInputHash(f.input);
    await assert.rejects(() => runIsolatedRepair(f.input), /already satisfied by the previous body/);
    const output = { records: f.input.samples.map(item => ({ id: item.id, value: structuredClone(item.expected) })) };
    output.records[0].value.body = sample.previousBody;
    assert.ok(validateRepairResult(f.input.samples, output).differences.some(diff => diff.field === 'contract'));
    sample.previousBody = '已有正文中的\t完整固定证据'; sample.bodyContains = ['已有正文中的 完整固定证据'];
    await assert.rejects(() => runIsolatedRepair(f.input), /already satisfied by the previous body/);
    assert.notEqual(repairInputHash(f.input), before);
    // Exact expected bodies also need a real gap; a renamed sample cannot create one.
    delete sample.bodyContains; sample.previousBody = sample.expected.body;
    await assert.rejects(() => runIsolatedRepair(f.input), /already satisfied by the previous body/);
  } finally { await f.cleanup(); }
});

test('fixed missing evidence must be added while preserving previous paragraphs, repetition and order after whitespace normalization', async () => {
  const f = await fixture();
  try {
    const sample = f.input.samples[0];
    sample.previousBody = '第一段已有正文\t应保留\n\n第二段已有正文\n第二段已有正文';
    sample.bodyContains = ['来源原件中缺失的完整正文'];
    const output = { records: f.input.samples.map(item => ({ id: item.id, value: structuredClone(item.expected) })) };
    output.records[0].value.body = '第一段已有正文 应保留\n新增说明\n第二段已有正文\n第二段已有正文\n来源原件中缺失的完整正文';
    assert.equal(validateRepairResult(f.input.samples, output).passed, true);
    for (const body of [
      '来源原件中缺失的完整正文',
      '第一段已有正文 应保留\n第二段已有正文\n来源原件中缺失的完整正文',
      '第二段已有正文\n第二段已有正文\n第一段已有正文 应保留\n来源原件中缺失的完整正文',
    ]) {
      output.records[0].value.body = body;
      const result = validateRepairResult(f.input.samples, output);
      assert.equal(result.passed, false);
      assert.ok(result.differences.some(diff => diff.field === 'body' && typeof diff.expected === 'object'));
    }
    // Legacy callers without a parent baseline keep their existing strict expectations.
    delete sample.previousBody; delete sample.bodyContains;
    output.records[0].value = structuredClone(sample.expected);
    assert.equal(validateRepairResult(f.input.samples, output).passed, true);
  } finally { await f.cleanup(); }
});

test('macOS kernel isolation: actual offline Python patch passes fixed failure and normal regression, adopts and withdraws', async t => {
  const capability = await probeSandbox();
  if (!capability.available || !capability.verified) {
    if (process.env.REQUIRE_COLLECTION_SANDBOX === '1') assert.fail(capability.reason);
    t.skip(capability.reason); return;
  }
  assert.equal(capability.backend, 'macos-seatbelt');
  const f = await fixture();
  try {
    const originalModule = await readFile(f.input.engineFiles[0].sourcePath, 'utf8');
    f.input.samples[0].previousBody = '修复正文';
    f.input.samples[1].previousBody = f.input.samples[1].expected.body;
    const trial = await runIsolatedRepair(f.input);
    assert.equal(trial.status, 'passed', JSON.stringify(trial)); assert.equal(trial.passed, true);
    assert.equal(trial.capability.verified, true); assert.equal(Object.isFrozen(trial), true);
    const adopted = adoptRepair(f.input, trial, 'engine-v1');
    assert.equal(adopted.state, 'adopted'); assert.equal(adopted.taskId, 'collection-task');
    const changed = structuredClone(f.input); changed.samples[0].expectedVersion = 'changed-after-trial';
    assert.throws(() => adoptRepair(changed, trial, 'engine-v1'), /changed after validation/);
    assert.throws(() => adoptRepair(f.input, trial, 'stale-base'), /changed after validation/);
    assert.throws(() => adoptRepair(f.input, JSON.parse(JSON.stringify(trial)), 'engine-v1'), /actual successful/);
    const reverted = withdrawRepair(adopted, adopted.version, 'Independent new template regression');
    assert.equal(reverted.version, 'engine-v1'); assert.equal(reverted.adoption.state, 'withdrawn');
    assert.equal(await readFile(f.input.engineFiles[0].sourcePath, 'utf8'), originalModule);
    // Fixing a failure may never conceal regressions on unchanged templates.
    f.input.candidate.patches[0].content = repaired.replace('page.entities,', 'page.entities[:1],');
    const regression = await runIsolatedRepair(f.input);
    assert.equal(regression.status, 'failed');
    assert.ok(regression.differences.some(diff => diff.sampleId === 'normal' && diff.field === 'entities'));
    assert.throws(() => adoptRepair(f.input, regression, 'engine-v1'), /actual successful/);
  } finally { await f.cleanup(); }
});

test('macOS candidate attacks: kernel denies credential read, host/input writes, network, fork/exec and subprocess even via native syscall', async t => {
  const capability = await probeSandbox();
  if (!capability.available || !capability.verified) {
    if (process.env.REQUIRE_COLLECTION_SANDBOX === '1') assert.fail(capability.reason);
    t.skip(capability.reason); return;
  }
  const f = await fixture();
  const previous = process.env.COLLECTION_SANDBOX_HOST_CANARY;
  process.env.COLLECTION_SANDBOX_HOST_CANARY = 'must-not-be-inherited';
  try {
    await mkdir(path.join(f.root, '.data'));
    const secretPath = path.join(f.root, '.data', 'fake-key'), forbiddenWrite = path.join(f.root, 'platform-source.py');
    await writeFile(secretPath, 'fake-not-a-real-credential'); await writeFile(forbiddenWrite, 'unchanged');
    const attack = String.raw`
import ctypes, errno, os, socket, subprocess
def denied(action):
    try:
        action(); return False
    except OSError as failure:
        return failure.errno in (errno.EPERM, errno.EACCES)
def extract(raw, context):
    checks = []
    checks.append(denied(lambda: open(SECRET, "r").read()))
    checks.append(denied(lambda: open(HOST_WRITE, "w").write("changed")))
    checks.append(denied(lambda: open(__file__, "w").write("changed")))
    checks.append(denied(lambda: open(os.path.join(context["outputDirectory"], "extra-file"), "w").write("cannot fill output volume")))
    # Call libc directly: a Python audit/import hook cannot explain these denials.
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    checks.append(libc.open(SECRET.encode(), 0) == -1 and ctypes.get_errno() == 1)
    checks.append(denied(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect(("127.0.0.1", 9))))
    checks.append(denied(lambda: subprocess.run(["/usr/bin/true"], check=True)))
    checks.append(denied(lambda: os.fork()))
    checks.append(denied(lambda: os.execv("/usr/bin/true", ["/usr/bin/true"])))
    checks.append("COLLECTION_SANDBOX_HOST_CANARY" not in os.environ)
    return {"body": "kernel-denied" if all(checks) else "ESCAPED", "entities": [], "links": []}
`.replaceAll('SECRET', JSON.stringify(secretPath)).replaceAll('HOST_WRITE', JSON.stringify(forbiddenWrite));
    f.input.candidate.patches[0].content = attack;
    for (const sample of f.input.samples) sample.expected = { body: 'kernel-denied', entities: [], links: [] };
    const trial = await runIsolatedRepair(f.input);
    assert.equal(trial.status, 'passed', JSON.stringify(trial));
    assert.equal(await readFile(secretPath, 'utf8'), 'fake-not-a-real-credential');
    assert.equal(await readFile(forbiddenWrite, 'utf8'), 'unchanged');
  } finally {
    if (previous === undefined) delete process.env.COLLECTION_SANDBOX_HOST_CANARY;
    else process.env.COLLECTION_SANDBOX_HOST_CANARY = previous;
    await f.cleanup();
  }
});

test('macOS timeout and abort kill the candidate process group, and output limits fail closed', async t => {
  const capability = await probeSandbox();
  if (!capability.available || !capability.verified) {
    if (process.env.REQUIRE_COLLECTION_SANDBOX === '1') assert.fail(capability.reason);
    t.skip(capability.reason); return;
  }
  const f = await fixture();
  try {
    f.input.candidate.patches[0].content = 'def extract(raw, context):\n    while True: pass\n';
    const timeout = await runIsolatedRepair({ ...f.input, timeoutMs: 100 });
    assert.equal(timeout.status, 'timeout');
    const controller = new AbortController();
    const running = runIsolatedRepair({ ...f.input, timeoutMs: 5000, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 400);
    const aborted = await running; clearTimeout(timer);
    assert.equal(aborted.status, 'aborted');
    f.input.candidate.patches[0].content = 'def extract(raw, context):\n    print("x" * 20000)\n    return {"body":"", "entities":[], "links":[]}\n';
    assert.equal((await runIsolatedRepair({ ...f.input, maxOutputBytes: 1024 })).status, 'failed');
  } finally { await f.cleanup(); }
});

test('macOS task adoption reprocesses affected originals in isolation and publishes only derived extraction with rollback evidence', async t => {
  const capability = await probeSandbox();
  if (!capability.available || !capability.verified) {
    if (process.env.REQUIRE_COLLECTION_SANDBOX === '1') assert.fail(capability.reason);
    t.skip(capability.reason); return;
  }
  const f = await fixture();
  try {
    f.input.candidate.affectedObjects = ['failure', 'normal'];
    const workspace = path.join(f.root, 'package');
    await mkdir(path.join(workspace, '.work/raw'), { recursive: true });
    await mkdir(path.join(workspace, '.work/extract'), { recursive: true });
    const urls: Record<string, unknown> = {};
    for (const sample of f.input.samples) {
      await writeFile(path.join(workspace, '.work/raw', `${sample.id}.html`), await readFile(sample.sourcePath));
      await writeFile(path.join(workspace, '.work/extract', `${sample.id}.json`), JSON.stringify({ fullText: sample.id === 'failure' ? 'broken' : sample.expected.body,
        title: 'Saved title', blocks: [], images: [], forms: [], hiddenBlocks: 0, links: [] }));
      urls[sample.id] = { id: sample.id, url: sample.url, rawFile: `.work/raw/${sample.id}.html`, action: 'keep' };
    }
    await writeFile(path.join(workspace, '.work/state.json'), JSON.stringify({ source: 'https://example.invalid/', urls }));
    const original = await readFile(path.join(workspace, '.work/raw/failure.html'));
    const trial = await runIsolatedRepair(f.input);
    assert.equal(trial.status, 'passed'); assert.equal(trial.outputs?.length, 2);
    const adoption = adoptRepair(f.input, trial, 'engine-v1');
    const applied = await applyRepairToCollectionWorkspace({ workspace, input: f.input, trial, adoption });
    assert.equal(applied.application.status, 'completed', JSON.stringify(applied));
    assert.equal(applied.receipt?.status, 'applied'); assert.deepEqual(applied.nextStages, ['data', 'render', 'verify']);
    assert.equal(applied.receipt?.handoffReady, false);
    const data = JSON.parse(await readFile(path.join(workspace, '.work/extract/failure.json'), 'utf8'));
    assert.equal(data.fullText, f.input.samples[0].expected.body); assert.equal(data.blocks[0].kind, 'p');
    assert.equal(data.codeRepair.version, adoption.version);
    const state = JSON.parse(await readFile(path.join(workspace, '.work/state.json'), 'utf8'));
    assert.equal(state.repairAdoptions[0].candidateSha256, trial.candidateSha256);
    assert.deepEqual(state.activeExtractionAdoptions.failure, { kind: 'repair', trialId: trial.id });
    assert.equal(JSON.parse(await readFile(path.join(workspace, `.work/code-repairs/${trial.id}/failure.previous.json`), 'utf8')).fullText, 'broken');
    assert.deepEqual(await readFile(path.join(workspace, '.work/raw/failure.html')), original);
    assert.equal(hash(await readFile(path.join(workspace, '.work/extract/failure.json'))), applied.receipt!.appliedSha256.failure);
    const withdrawn = await withdrawRepairFromCollectionWorkspace({ workspace, adoption, currentVersion: adoption.version, reason: 'New independent regression revealed a remaining extraction gap' });
    assert.equal(withdrawn.receipt.status, 'withdrawn'); assert.equal(withdrawn.version, 'engine-v1');
    assert.equal(JSON.parse(await readFile(path.join(workspace, '.work/extract/failure.json'), 'utf8')).fullText, 'broken');
    const restored = JSON.parse(await readFile(path.join(workspace, '.work/state.json'), 'utf8'));
    assert.equal(restored.repairAdoptions[0].state, 'withdrawn'); assert.deepEqual(restored.activeExtractionAdoptions.failure, { kind: 'baseline' });
    assert.deepEqual(await readFile(path.join(workspace, '.work/raw/failure.html')), original);
  } finally { await f.cleanup(); }
});

test('macOS package entry point executes actual extract_page and retains complete parsed output', async t => {
  const capability = await probeSandbox();
  if (!capability.available || !capability.verified) {
    if (process.env.REQUIRE_COLLECTION_SANDBOX === '1') assert.fail(capability.reason);
    t.skip(capability.reason); return;
  }
  const f = await fixture();
  try {
    const packageSources = {
      'siteharvest/__init__.py': '',
      'siteharvest/helper.py': 'TITLE = "Package-relative import succeeded"\n',
      'siteharvest/extract.py': 'def extract_page(raw_text, url):\n    return {}\n',
    };
    f.input.engineFiles = [];
    for (const [name, source] of Object.entries(packageSources)) {
      const sourcePath = path.join(f.root, name); await mkdir(path.dirname(sourcePath), { recursive: true }); await writeFile(sourcePath, source);
      f.input.engineFiles.push({ path: name, sourcePath, sha256: hash(source) });
    }
    f.input.candidate.entryPoint = 'siteharvest/extract.py'; f.input.allowedPatchPaths = ['siteharvest/extract.py'];
    const patch = repaired.replace('def extract(raw, context):', 'def offline(raw, context):') + String.raw`
from .helper import TITLE
def extract_page(raw_text, url):
    value = offline(raw_text.encode("utf-8"), {})
    return {"url":url, "fullText": value["body"], "entities":value["entities"], "links":[{"url":url,"where":"content"} for url in value["links"]], "title":TITLE,
            "blocks":[{"kind":"p","text":value["body"]}], "images":[], "forms":[], "tables":[], "hiddenBlocks":0}
`;
    f.input.candidate.patches = [{ path: 'siteharvest/extract.py', content: patch }];
    const trial = await runIsolatedRepair(f.input);
    assert.equal(trial.status, 'passed', JSON.stringify(trial));
    assert.equal(trial.outputs?.[0].value.parsed?.title, 'Package-relative import succeeded');
  } finally { await f.cleanup(); }
});

test('macOS installed managed runtime executes the copied real lxml extractor without exposing its .data parent', async t => {
  const pythonPath = path.resolve('.data/collection-runtime/bin/python');
  try { await access(pythonPath); } catch { t.skip('Managed collection runtime is not installed on this host'); return; }
  const capability = await probeSandbox({ pythonPath });
  if (!capability.available || !capability.verified) {
    if (process.env.REQUIRE_COLLECTION_SANDBOX === '1') assert.fail(capability.reason);
    t.skip(capability.reason); return;
  }
  assert.ok(capability.dependencyRoots?.every(root => root.endsWith('/site-packages')));
  const f = await fixture();
  try {
    f.input.pythonPath = pythonPath; f.input.engineFiles = [];
    for (const name of ['__init__.py', 'util.py', 'extract.py']) {
      const sourcePath = path.resolve('engines/site-harvest/siteharvest', name), bytes = await readFile(sourcePath);
      f.input.engineFiles.push({ path: `siteharvest/${name}`, sourcePath, sha256: hash(bytes) });
    }
    const source = await readFile(path.resolve('engines/site-harvest/siteharvest/extract.py'), 'utf8');
    f.input.candidate.entryPoint = 'siteharvest/extract.py'; f.input.allowedPatchPaths = ['siteharvest/extract.py'];
    f.input.candidate.patches = [{ path: 'siteharvest/extract.py', content: source + '\n# Independent offline fixture candidate.\n' }];
    for (const sample of f.input.samples) {
      const body = sample.kind === 'failure' ? 'Fixed failure source body preserved.' : 'Independent normal template text preserved.';
      const raw = `<html><body><main><p>${body}</p></main></body></html>`;
      await writeFile(sample.sourcePath, raw); sample.sha256 = hash(raw); sample.expected = { body, entities: [], links: [] };
    }
    const trial = await runIsolatedRepair(f.input);
    assert.equal(trial.status, 'passed', JSON.stringify(trial));
    assert.ok(trial.outputs?.every(output => Array.isArray(output.value.parsed?.blocks)));
  } finally { await f.cleanup(); }
});
