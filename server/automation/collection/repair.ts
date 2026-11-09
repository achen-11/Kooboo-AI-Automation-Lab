import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertSandboxRelativePath, runSandboxedPython, type SandboxCapability } from './sandbox.js';

export interface RepairExtraction { body: string; entities: string[]; links: string[]; parsed?: Record<string, unknown> }
export interface RepairSample {
  id: string;
  kind: 'failure' | 'regression';
  sourcePath: string;
  sha256: string;
  url: string;
  /** Parent-owned fixed expectation, never copied into the candidate sandbox. */
  expected: RepairExtraction;
  expectedVersion: string;
  /** Failure-only source quotes. Regression expectations always use exact body equality. */
  bodyContains?: string[];
  /** Host-frozen current fullText. Never passed to candidate execution. */
  previousBody?: string;
}
export interface RepairEngineFile { path: string; sourcePath: string; sha256: string }
export interface RepairCandidate {
  id: string;
  taskId: string;
  baseVersion: string;
  entryPoint: string;
  patches: { path: string; content: string }[];
  reason: string;
  evidenceIds: string[];
  affectedObjects: string[];
}
export interface RepairTrialInput {
  candidate: RepairCandidate;
  engineFiles: RepairEngineFile[];
  /** Platform-owned allowlist, not supplied by a candidate tool argument. */
  allowedPatchPaths: string[];
  samples: RepairSample[];
  pythonPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface RepairDifference { sampleId: string; field: 'body' | 'entities' | 'links' | 'contract'; expected: unknown; actual: unknown }
export interface RepairComparison { passed: boolean; differences: RepairDifference[]; sampleIds: string[] }
export interface RepairTrial extends RepairComparison {
  schemaVersion: 1;
  id: string;
  taskId: string;
  candidateId: string;
  baseVersion: string;
  candidateSha256: string;
  inputSha256: string;
  status: 'passed' | 'failed' | 'unsupported' | 'aborted' | 'timeout';
  capability: SandboxCapability;
  checkedAt: string;
  reason?: string;
  outputs?: RepairOutput[];
}
export interface RepairOutput { id: string; value: RepairExtraction; sha256: string }
export interface TaskRepairRecord { id: string; url: string; sourcePath: string; sha256: string; previous: Record<string, unknown> }
export interface TaskRepairApplication {
  schemaVersion: 1;
  status: 'completed' | 'failed' | 'unsupported' | 'aborted' | 'timeout';
  trialId: string;
  taskId: string;
  version: string;
  candidateSha256: string;
  inputSha256: string;
  checkedAt: string;
  capability: SandboxCapability;
  outputs: (RepairOutput & { sourceSha256: string; previous: Record<string, unknown> })[];
  reason?: string;
}
export interface RepairAdoption {
  schemaVersion: 1;
  taskId: string;
  candidateId: string;
  candidateSha256: string;
  inputSha256: string;
  trialId: string;
  baseVersion: string;
  version: string;
  previousVersion: string;
  state: 'adopted' | 'withdrawn';
  adoptedAt: string;
  affectedObjects: string[];
  evidenceIds: string[];
  withdrawnAt?: string;
  withdrawalReason?: string;
}

const issuedTrials = new WeakSet<RepairTrial>();
const issuedApplications = new WeakSet<TaskRepairApplication>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixed(value: unknown): string { return JSON.stringify(value); }
export function repairCandidateHash(candidate: RepairCandidate): string {
  return hash(fixed({ id: candidate.id, taskId: candidate.taskId, baseVersion: candidate.baseVersion, entryPoint: candidate.entryPoint,
    patches: [...candidate.patches].sort((a, b) => a.path.localeCompare(b.path)), reason: candidate.reason,
    evidenceIds: candidate.evidenceIds, affectedObjects: candidate.affectedObjects }));
}
export function repairInputHash(input: Pick<RepairTrialInput, 'engineFiles' | 'allowedPatchPaths' | 'samples'>): string {
  return hash(fixed({ engineFiles: input.engineFiles.map(file => ({ path: file.path, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    allowedPatchPaths: [...input.allowedPatchPaths].sort(),
    samples: input.samples.map(sample => ({ id: sample.id, kind: sample.kind, sha256: sample.sha256, url: sample.url,
      expected: sample.expected, expectedVersion: sample.expectedVersion, bodyContains: sample.bodyContains, previousBody: sample.previousBody })) }));
}
function bodyText(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }
function previousParagraphs(value: string): string[] { return value.split(/\r\n|\r|\n/u).map(bodyText).filter(Boolean); }
function hasRealFailure(sample: RepairSample): boolean {
  if (sample.kind !== 'failure' || sample.previousBody === undefined) return true;
  const previous = bodyText(sample.previousBody);
  const targets = sample.bodyContains?.length ? sample.bodyContains : [sample.expected.body];
  return targets.some(target => bodyText(target).length > 0 && !previous.includes(bodyText(target)));
}
function retainsPreviousBody(previous: string, actual: string): boolean {
  const normalized = bodyText(actual);
  let cursor = 0;
  // Keep every pre-existing paragraph, including repeated paragraphs and their order.
  // New text may be inserted between paragraphs; whitespace changes are harmless.
  for (const paragraph of previousParagraphs(previous)) {
    const position = normalized.indexOf(paragraph, cursor);
    if (position === -1) return false;
    cursor = position + paragraph.length;
  }
  return true;
}
function assertExtraction(value: unknown): value is RepairExtraction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as RepairExtraction;
  return typeof result.body === 'string' && Array.isArray(result.entities) && result.entities.every(item => typeof item === 'string')
    && Array.isArray(result.links) && result.links.every(item => typeof item === 'string');
}
function assertInput(input: RepairTrialInput): void {
  const candidate = input.candidate;
  if (!candidate.id || !candidate.taskId || !candidate.baseVersion || !candidate.reason || !candidate.evidenceIds.length || !candidate.affectedObjects.length) throw new Error('Repair candidate requires task, base version, evidence and affected objects');
  assertSandboxRelativePath(candidate.entryPoint);
  const allow = new Set(input.allowedPatchPaths), engine = new Set(input.engineFiles.map(file => file.path)), patches = new Set<string>();
  for (const name of [...engine, ...allow]) { assertSandboxRelativePath(name); if (!name.endsWith('.py')) throw new Error('Only offline Python modules may be repaired'); }
  if (engine.size !== input.engineFiles.length || !engine.has(candidate.entryPoint)) throw new Error('Engine files require unique paths and an existing entry point');
  if (!candidate.patches.length) throw new Error('Repair candidate has no module changes');
  for (const patch of candidate.patches) {
    assertSandboxRelativePath(patch.path);
    if (!allow.has(patch.path) || !engine.has(patch.path) || patches.has(patch.path)) throw new Error('Candidate patch is outside the platform allowlist or duplicated');
    if (Buffer.byteLength(patch.content) > 1024 * 1024) throw new Error('Candidate module is too large');
    patches.add(patch.path);
  }
  if (!input.samples.some(sample => sample.kind === 'failure') || !input.samples.some(sample => sample.kind === 'regression')) throw new Error('Fixed failure samples and independent normal regression samples are required');
  if (new Set(input.samples.map(sample => sample.id)).size !== input.samples.length) throw new Error('Sample identities must be unique');
  for (const sample of input.samples) {
    if (!sample.id || !sample.expectedVersion || !assertExtraction(sample.expected)) throw new Error('Sample requires a versioned fixed body/entities/links expectation');
    if (!/^[a-f0-9]{64}$/.test(sample.sha256)) throw new Error('Saved source SHA-256 is required');
    if (sample.bodyContains && (sample.kind !== 'failure' || sample.bodyContains.length === 0 || sample.bodyContains.some(quote => typeof quote !== 'string' || quote.length < 8))) throw new Error('Source quote anchors require failure samples and at least 8 characters');
    if (sample.previousBody !== undefined && typeof sample.previousBody !== 'string') throw new Error('Previous body must be host-frozen text');
    if (!hasRealFailure(sample)) throw new Error('Failure sample expectations are already satisfied by the previous body; no actual missing-body failure was established');
  }
}

/** Pure parent-side comparison. A candidate-supplied "passed" report is ignored. */
export function validateRepairResult(samples: RepairSample[], output: unknown): RepairComparison {
  const differences: RepairDifference[] = [];
  const rows = output && typeof output === 'object' && Array.isArray((output as { records?: unknown }).records)
    ? (output as { records: unknown[] }).records : [];
  const values = new Map<string, unknown>();
  const expectedIds = new Set(samples.map(sample => sample.id));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') {
      differences.push({ sampleId: '', field: 'contract', expected: 'sample record', actual: 'invalid record' }); continue;
    }
    const record = row as { id: string; value?: unknown };
    if (values.has(record.id) || !expectedIds.has(record.id)) differences.push({ sampleId: record.id, field: 'contract', expected: 'one known sample', actual: 'duplicate or unknown sample' });
    values.set(record.id, record.value);
  }
  for (const sample of samples) {
    const actual = values.get(sample.id);
    if (!assertExtraction(actual)) { differences.push({ sampleId: sample.id, field: 'contract', expected: 'body/entities/links extraction', actual: 'missing or invalid extraction' }); continue; }
    if (!hasRealFailure(sample)) differences.push({ sampleId: sample.id, field: 'contract', expected: 'a fixed body expectation absent from the previous body', actual: 'failure baseline already satisfies every body expectation' });
    if (sample.previousBody !== undefined && !retainsPreviousBody(sample.previousBody, actual.body)) differences.push({ sampleId: sample.id, field: 'body', expected: { preservePreviousParagraphs: previousParagraphs(sample.previousBody) }, actual: actual.body });
    for (const field of ['body', 'entities', 'links'] as const) {
      // Ordered identities and links intentionally preserve duplicate/order/query semantics.
      if (field === 'body' && sample.bodyContains?.length) {
        if (!sample.bodyContains.every(quote => bodyText(actual.body).includes(bodyText(quote)))) differences.push({ sampleId: sample.id, field, expected: sample.bodyContains, actual: actual.body });
      } else if (fixed(actual[field]) !== fixed(sample.expected[field])) differences.push({ sampleId: sample.id, field, expected: sample.expected[field], actual: actual[field] });
    }
  }
  return { passed: differences.length === 0 && samples.length > 0, differences, sampleIds: samples.map(sample => sample.id) };
}

export async function runIsolatedRepair(input: RepairTrialInput): Promise<RepairTrial> {
  assertInput(input);
  // Snapshot all expectations and module metadata before awaiting: callers cannot mutate a
  // running trial's expected values while the candidate executes.
  const snapshot = structuredClone({ candidate: input.candidate, engineFiles: input.engineFiles, allowedPatchPaths: input.allowedPatchPaths, samples: input.samples });
  const candidateSha256 = repairCandidateHash(snapshot.candidate), inputSha256 = repairInputHash(snapshot);
  const code = [];
  for (const file of snapshot.engineFiles) {
    const bytes = await readFile(file.sourcePath);
    if (hash(bytes) !== file.sha256) throw new Error('Saved engine module SHA-256 mismatch');
    const patch = snapshot.candidate.patches.find(patch => patch.path === file.path);
    code.push({ path: file.path, content: patch ? patch.content : bytes });
  }
  const samples = [];
  for (const [index, sample] of snapshot.samples.entries()) {
    const bytes = await readFile(sample.sourcePath);
    if (hash(bytes) !== sample.sha256) throw new Error('Saved original sample SHA-256 mismatch');
    if (sample.bodyContains?.some(quote => !bytes.toString('utf8').includes(quote))) throw new Error('Fixed failure quote is not present in the saved original');
    samples.push({ path: `${index}.raw`, content: bytes });
  }
  const result = await runSandboxedPython({ code, samples, entryPoint: snapshot.candidate.entryPoint,
    manifest: snapshot.samples.map((sample, index) => ({ id: sample.id, url: sample.url, file: `${index}.raw` })),
    pythonPath: input.pythonPath, signal: input.signal, timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes });
  const comparison = result.status === 'completed' ? validateRepairResult(snapshot.samples, result.output)
    : { passed: false, differences: [], sampleIds: snapshot.samples.map(sample => sample.id) };
  const trial: RepairTrial = { schemaVersion: 1, id: hash(fixed({ candidateSha256, inputSha256, checkedAt: new Date().toISOString() })),
    taskId: snapshot.candidate.taskId, candidateId: snapshot.candidate.id, baseVersion: snapshot.candidate.baseVersion,
    candidateSha256, inputSha256, status: result.status === 'completed' ? (comparison.passed ? 'passed' : 'failed') : result.status,
    capability: result.capability, checkedAt: new Date().toISOString(), ...comparison,
    ...(comparison.passed ? { outputs: outputRecords(result.output, snapshot.samples.map(sample => sample.id))! } : {}),
    ...(result.reason ? { reason: result.reason } : {}) };
  // Adoption accepts a platform-issued trial only. JSON submitted by a candidate cannot
  // forge the kernel receipt or validation. Persist the returned record as immutable evidence;
  // after restart rerun validation rather than accepting an untrusted deserialized report.
  issuedTrials.add(trial);
  deepFreeze(trial);
  return trial;
}
function deepFreeze(value: object): void {
  for (const member of Object.values(value)) if (member && typeof member === 'object') deepFreeze(member);
  Object.freeze(value);
}

export function adoptRepair(input: RepairTrialInput, trial: RepairTrial, currentVersion: string): RepairAdoption {
  if (!issuedTrials.has(trial) || trial.status !== 'passed' || !trial.passed || !trial.capability.available || !trial.capability.verified) throw new Error('Adoption requires an actual successful isolated platform trial');
  if (trial.taskId !== input.candidate.taskId || trial.candidateId !== input.candidate.id || currentVersion !== trial.baseVersion
    || trial.candidateSha256 !== repairCandidateHash(input.candidate) || trial.inputSha256 !== repairInputHash(input)) throw new Error('Repair candidate, base version or fixed expectations changed after validation');
  return { schemaVersion: 1, taskId: trial.taskId, candidateId: trial.candidateId, candidateSha256: trial.candidateSha256,
    inputSha256: trial.inputSha256, trialId: trial.id, baseVersion: trial.baseVersion, version: `task-repair:${trial.candidateSha256}`,
    previousVersion: currentVersion, state: 'adopted', adoptedAt: new Date().toISOString(),
    affectedObjects: [...input.candidate.affectedObjects], evidenceIds: [...input.candidate.evidenceIds] };
}

export function withdrawRepair(adoption: RepairAdoption, currentVersion: string, reason: string): { adoption: RepairAdoption; version: string } {
  if (adoption.state !== 'adopted' || currentVersion !== adoption.version || !reason.trim()) throw new Error('Withdrawal requires the active task repair and a regression reason');
  return { adoption: { ...structuredClone(adoption), state: 'withdrawn', withdrawnAt: new Date().toISOString(), withdrawalReason: reason }, version: adoption.previousVersion };
}

function outputRecords(output: unknown, ids: string[]): RepairOutput[] | undefined {
  if (!output || typeof output !== 'object' || !Array.isArray((output as { records?: unknown }).records)) return;
  const records = (output as { records: { id: string; value: RepairExtraction }[] }).records;
  if (records.length !== ids.length || new Set(records.map(record => record?.id)).size !== ids.length) return;
  if (records.some(record => !ids.includes(record?.id) || !assertExtraction(record?.value))) return;
  return ids.map(id => { const value = structuredClone(records.find(record => record.id === id)!.value); return { id, value, sha256: hash(fixed(value)) }; });
}

/** Execute an adopted version against every explicitly affected saved original. Fixed trial
 * regressions run again in the same sandbox invocation. Only the parent may write outputs. */
export async function applyTaskRepair(input: RepairTrialInput, trial: RepairTrial, adoption: RepairAdoption, records: TaskRepairRecord[]): Promise<TaskRepairApplication> {
  const expectedAdoption = adoptRepair(input, trial, input.candidate.baseVersion);
  if (adoption.state !== 'adopted' || adoption.taskId !== expectedAdoption.taskId || adoption.version !== expectedAdoption.version
    || adoption.trialId !== trial.id || adoption.inputSha256 !== trial.inputSha256 || adoption.candidateSha256 !== trial.candidateSha256) throw new Error('Application requires the validated task adoption');
  if (new Set(records.map(record => record.id)).size !== records.length || !records.length
    || records.length !== new Set(input.candidate.affectedObjects).size || records.some(record => !input.candidate.affectedObjects.includes(record.id))) throw new Error('Application must cover every existing affected object exactly once');
  const snapshot = structuredClone({ candidate: input.candidate, engineFiles: input.engineFiles, samples: input.samples, records });
  const code = [];
  for (const file of snapshot.engineFiles) {
    const bytes = await readFile(file.sourcePath);
    if (hash(bytes) !== file.sha256) throw new Error('Saved engine module SHA-256 mismatch');
    code.push({ path: file.path, content: snapshot.candidate.patches.find(patch => patch.path === file.path)?.content ?? bytes });
  }
  const all = [...snapshot.samples.map(sample => ({ ...sample, sandboxId: `regression:${sample.id}` })), ...snapshot.records.map(record => ({ ...record, sandboxId: `affected:${record.id}` }))];
  const samples = [];
  for (const [index, record] of all.entries()) {
    const bytes = await readFile(record.sourcePath);
    if (hash(bytes) !== record.sha256) throw new Error('Saved original SHA-256 changed before task application');
    samples.push({ path: `${index}.raw`, content: bytes });
  }
  const result = await runSandboxedPython({ code, samples, entryPoint: snapshot.candidate.entryPoint,
    manifest: all.map((record, index) => ({ id: record.sandboxId, url: record.url, file: `${index}.raw` })),
    pythonPath: input.pythonPath, timeoutMs: input.timeoutMs, signal: input.signal, maxOutputBytes: input.maxOutputBytes });
  const extracted = result.status === 'completed' ? outputRecords(result.output, all.map(record => record.sandboxId)) : undefined;
  const comparison = extracted && validateRepairResult(snapshot.samples.map(sample => ({ ...sample, id: `regression:${sample.id}` })),
    { records: extracted.filter(record => record.id.startsWith('regression:')).map(record => ({ id: record.id, value: record.value })) });
  const succeeded = Boolean(extracted && comparison?.passed);
  const application: TaskRepairApplication = { schemaVersion: 1, status: result.status === 'completed' ? (succeeded ? 'completed' : 'failed') : result.status,
    taskId: trial.taskId, trialId: trial.id, version: adoption.version, candidateSha256: trial.candidateSha256, inputSha256: trial.inputSha256,
    checkedAt: new Date().toISOString(), capability: result.capability, outputs: succeeded ? snapshot.records.map(record => {
      const output = extracted!.find(output => output.id === `affected:${record.id}`)!;
      return { ...output, id: record.id, sourceSha256: record.sha256, previous: record.previous };
    }) : [], ...(result.reason ? { reason: result.reason } : !succeeded ? { reason: 'Adopted candidate output contract or repeated fixed regression failed.' } : {}) };
  issuedApplications.add(application); deepFreeze(application); return application;
}

export function assertIssuedRepairApplication(application: TaskRepairApplication): void {
  if (!issuedApplications.has(application) || application.status !== 'completed' || !application.capability.verified || !application.outputs.length) throw new Error('Host writes require a successful platform-issued isolated application');
}
