import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeCollectionPath } from './runtime.js';
import { applyTaskRepair, assertIssuedRepairApplication, withdrawRepair, type RepairAdoption, type RepairExtraction, type RepairTrial, type RepairTrialInput, type TaskRepairApplication } from './repair.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export interface CollectionRepairReceipt {
  schemaVersion: 1;
  status: 'applying' | 'applied' | 'rolled-back' | 'withdrawing' | 'withdrawn';
  trialId: string;
  taskId: string;
  version: string;
  candidateSha256: string;
  inputSha256: string;
  sampleIds: string[];
  sourceSha256: Record<string, string>;
  appliedSha256: Record<string, string>;
  previousSha256: Record<string, string | null>;
  previousStateSha256: string;
  receipt: string;
  checkedAt: string;
  handoffReady: false;
}

function extracted(value: RepairExtraction, previous: Record<string, unknown>, url: string): Record<string, unknown> {
  let result: Record<string, unknown>;
  if (value.parsed) {
    if (typeof value.parsed !== 'object' || Array.isArray(value.parsed) || value.parsed.fullText !== value.body
      || !Array.isArray(value.parsed.links) || JSON.stringify(value.parsed.links.map(link => typeof link === 'string' ? link : link?.url)) !== JSON.stringify(value.links)) throw new Error('Candidate parsed output does not match its validated body/link projection');
    const parsed = value.parsed;
    // The module may provide extraction fields, never workspace/state paths or source identity.
    const fields = ['fullText', 'contactLinks', 'inlineGraphics', 'dataImages', 'stylesheets', 'interactionHints', 'base', 'pageType', 'title', 'description', 'canonical', 'robots', 'lang', 'hreflang', 'og', 'h1', 'headings', 'blocks', 'images', 'links', 'forms', 'tables', 'embeds', 'jsonld', 'jsonldRaw', 'words', 'hiddenBlocks', 'emails', 'phones'];
    result = Object.fromEntries(fields.filter(field => Object.hasOwn(parsed, field)).map(field => [field, parsed[field]]));
    for (const field of ['blocks', 'images', 'forms', 'tables', 'headings', 'embeds']) if (!Array.isArray(result[field])) result[field] = [];
    if (typeof result.hiddenBlocks !== 'number') result.hiddenBlocks = 0;
    for (const field of ['title', 'description', 'canonical', 'robots', 'lang', 'pageType']) if (typeof result[field] !== 'string') result[field] = typeof previous[field] === 'string' ? previous[field] : '';
  } else {
    result = { ...previous, fullText: value.body, words: value.body.length, blocks: [{ kind: 'p', text: value.body, hidden: false }],
      links: value.links.map(url => ({ url, text: '', where: 'content' })), entities: [...value.entities] };
  }
  result.url = url;
  result.entities = [...value.entities];
  result.words = typeof result.words === 'number' && Number.isFinite(result.words) && result.words >= 0 ? result.words : value.body.length;
  return result;
}

async function atomic(root: string, relative: string, bytes: string | Buffer) {
  const target = safeCollectionPath(root, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}

/** The sandbox receives no workspace path. Only this host adapter updates derived extraction.
 * Original response/HTML files are preserved and checked again immediately before publication. */
export async function applyRepairToCollectionWorkspace(options: {
  workspace: string; input: RepairTrialInput; trial: RepairTrial; adoption: RepairAdoption;
}): Promise<{ application: TaskRepairApplication; receipt?: CollectionRepairReceipt; nextStages: ['data', 'render', 'verify'] }> {
  const { workspace, input, trial, adoption } = options;
  const statePath = safeCollectionPath(workspace, '.work/state.json');
  const previousState = await readFile(statePath);
  const state = JSON.parse(previousState.toString('utf8'));
  if (!state.urls || typeof state.urls !== 'object' || Array.isArray(state.urls)) throw new Error('Collection state has no object registry');
  const entries = Object.values(state.urls) as Record<string, unknown>[];
  const records = await Promise.all(input.candidate.affectedObjects.map(async id => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Affected extraction object identity is invalid');
    const matched = entries.filter(record => record.id === id);
    if (matched.length !== 1 || typeof matched[0].rawFile !== 'string' || typeof matched[0].url !== 'string') throw new Error('Every affected object must exist once and have a saved original');
    const record = matched[0];
    if (!(record.rawFile as string).startsWith('.work/raw/')) throw new Error('Repair input must be a saved raw original');
    const sourcePath = safeCollectionPath(workspace, record.rawFile as string), bytes = await readFile(sourcePath);
    const previousPath = safeCollectionPath(workspace, `.work/extract/${id}.json`);
    let previous: Record<string, unknown> = {};
    try { previous = JSON.parse(await readFile(previousPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { id, url: (typeof record.finalUrl === 'string' && record.finalUrl) || record.url as string, sourcePath, sha256: hash(bytes), previous };
  }));
  const application = await applyTaskRepair(input, trial, adoption, records);
  if (application.status !== 'completed') return { application, nextStages: ['data', 'render', 'verify'] };
  assertIssuedRepairApplication(application);
  input.signal?.throwIfAborted();
  if (hash(await readFile(statePath)) !== hash(previousState)) throw new Error('Collection state changed during isolated repair; retry under the task lease');
  const folder = `.work/code-repairs/${trial.id}`;
  const receiptPath = `${folder}/receipt.json`;
  // Immutable trial/apply artifacts make an interrupted operation inspectable after restart.
  await mkdir(safeCollectionPath(workspace, folder), { recursive: false, mode: 0o700 }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(safeCollectionPath(workspace, '.work/code-repairs'), { recursive: true, mode: 0o700 });
      await mkdir(safeCollectionPath(workspace, folder), { mode: 0o700 });
    } else throw error;
  });
  const previousFiles = new Map<string, Buffer | undefined>();
  const appliedFiles = new Map<string, string>();
  const receipt: CollectionRepairReceipt = { schemaVersion: 1, status: 'applying', trialId: trial.id, taskId: trial.taskId,
    version: adoption.version, candidateSha256: trial.candidateSha256, inputSha256: trial.inputSha256,
    sampleIds: records.map(record => record.id), sourceSha256: Object.fromEntries(records.map(record => [record.id, record.sha256])),
    appliedSha256: {}, previousSha256: {}, previousStateSha256: hash(previousState), receipt: receiptPath, checkedAt: new Date().toISOString(), handoffReady: false };
  await atomic(workspace, `${folder}/previous-state.json`, previousState);
  await atomic(workspace, `${folder}/trial.json`, json(trial));
  await atomic(workspace, `${folder}/adoption.json`, json(adoption));
  await atomic(workspace, `${folder}/candidate.json`, json(input.candidate));
  for (const output of application.outputs) {
    const record = records.find(record => record.id === output.id)!;
    if (hash(await readFile(record.sourcePath)) !== output.sourceSha256) throw new Error('Saved original changed during isolated repair');
    const target = `.work/extract/${output.id}.json`;
    let bytes: Buffer | undefined;
    try { bytes = await readFile(safeCollectionPath(workspace, target)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (bytes && JSON.stringify(JSON.parse(bytes.toString())) !== JSON.stringify(record.previous)) throw new Error('Previous extraction changed during isolated repair');
    previousFiles.set(output.id, bytes);
    receipt.previousSha256[output.id] = bytes ? hash(bytes) : null;
    if (bytes) await atomic(workspace, `${folder}/${output.id}.previous.json`, bytes);
    const value = extracted(output.value, record.previous, record.url);
    value.codeRepair = { trialId: trial.id, version: adoption.version, candidateSha256: trial.candidateSha256, sourceSha256: output.sourceSha256 };
    const serialized = json(value); appliedFiles.set(output.id, serialized); receipt.appliedSha256[output.id] = hash(serialized);
    await atomic(workspace, `${folder}/${output.id}.applied.json`, serialized);
  }
  await atomic(workspace, receiptPath, json(receipt));
  try {
    for (const [id, bytes] of appliedFiles) {
      input.signal?.throwIfAborted();
      await atomic(workspace, `.work/extract/${id}.json`, bytes);
      const data = JSON.parse(bytes), record = entries.find(record => record.id === id)!;
      for (const field of ['title', 'description', 'canonical', 'robots', 'lang', 'pageType', 'words']) if (Object.hasOwn(data, field)) record[field] = data[field];
      record.images = Array.isArray(data.images) ? data.images.length : 0;
      record.links = Array.isArray(data.links) ? data.links.length : 0;
    }
    state.repairAdoptions ??= [];
    if (!Array.isArray(state.repairAdoptions)) throw new Error('Collection repair adoption history is invalid');
    state.repairAdoptions.push({ trialId: receipt.trialId, taskId: receipt.taskId, version: receipt.version, candidateSha256: receipt.candidateSha256,
      inputSha256: receipt.inputSha256, sampleIds: receipt.sampleIds, sourceSha256: receipt.sourceSha256, appliedSha256: receipt.appliedSha256, receipt: receipt.receipt });
    state.activeExtractionAdoptions ??= {};
    if (typeof state.activeExtractionAdoptions !== 'object' || Array.isArray(state.activeExtractionAdoptions)) throw new Error('Active extraction adoption registry is invalid');
    for (const id of receipt.sampleIds) state.activeExtractionAdoptions[id] = { kind: 'repair', trialId: receipt.trialId };
    await atomic(workspace, '.work/state.json', json(state));
    receipt.status = 'applied'; await atomic(workspace, receiptPath, json(receipt));
  } catch (error) {
    for (const [id, bytes] of previousFiles) {
      if (bytes) await atomic(workspace, `.work/extract/${id}.json`, bytes);
      else await rm(safeCollectionPath(workspace, `.work/extract/${id}.json`), { force: true });
    }
    await atomic(workspace, '.work/state.json', previousState);
    receipt.status = 'rolled-back'; await atomic(workspace, receiptPath, json(receipt));
    throw error;
  }
  return { application, receipt, nextStages: ['data', 'render', 'verify'] };
}

/** Restore exactly this active task adoption. Other objects and later independent state
 * changes survive. Old extraction gaps remain gaps; a withdrawal does not claim acceptance. */
export async function withdrawRepairFromCollectionWorkspace(options: {
  workspace: string; adoption: RepairAdoption; currentVersion: string; reason: string; signal?: AbortSignal;
}): Promise<{ adoption: RepairAdoption; version: string; receipt: CollectionRepairReceipt; nextStages: ['data', 'render', 'verify'] }> {
  const { workspace, adoption, currentVersion, reason } = options;
  const withdrawn = withdrawRepair(adoption, currentVersion, reason);
  if (!/^[a-f0-9]{64}$/.test(adoption.trialId)) throw new Error('Invalid repair trial identity');
  const folder = `.work/code-repairs/${adoption.trialId}`;
  const receiptPath = `${folder}/receipt.json`;
  const originalReceipt = await readFile(safeCollectionPath(workspace, receiptPath));
  const receipt: CollectionRepairReceipt = JSON.parse(originalReceipt.toString());
  if (receipt.status !== 'applied' || receipt.trialId !== adoption.trialId || receipt.taskId !== adoption.taskId
    || receipt.version !== adoption.version || receipt.candidateSha256 !== adoption.candidateSha256 || receipt.inputSha256 !== adoption.inputSha256) throw new Error('Withdrawal receipt does not match the active task adoption');
  const stateBytes = await readFile(safeCollectionPath(workspace, '.work/state.json'));
  const state = JSON.parse(stateBytes.toString());
  const previousStateBytes = await readFile(safeCollectionPath(workspace, `${folder}/previous-state.json`));
  if (hash(previousStateBytes) !== receipt.previousStateSha256) throw new Error('Previous collection state rollback evidence changed');
  const previousState = JSON.parse(previousStateBytes.toString());
  const currentRecords = Object.values(state.urls ?? {}) as Record<string, unknown>[];
  const previousRecords = Object.values(previousState.urls ?? {}) as Record<string, unknown>[];
  const backups = new Map<string, Buffer | undefined>(), current = new Map<string, Buffer>();
  for (const id of receipt.sampleIds) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid affected object identity in repair receipt');
    const pointer = state.activeExtractionAdoptions?.[id];
    if (pointer?.kind !== 'repair' || pointer.trialId !== adoption.trialId) throw new Error('A newer extraction adoption is active; cannot withdraw over it');
    const record = currentRecords.find(record => record.id === id);
    if (!record || typeof record.rawFile !== 'string' || hash(await readFile(safeCollectionPath(workspace, record.rawFile))) !== receipt.sourceSha256[id]) throw new Error('Saved original changed; withdrawal requires a new extraction decision');
    const bytes = await readFile(safeCollectionPath(workspace, `.work/extract/${id}.json`));
    if (hash(bytes) !== receipt.appliedSha256[id]) throw new Error('Applied extraction changed; cannot overwrite it during withdrawal');
    current.set(id, bytes);
    try { backups.set(id, await readFile(safeCollectionPath(workspace, `${folder}/${id}.previous.json`))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') backups.set(id, undefined); else throw error; }
    if ((backups.get(id) ? hash(backups.get(id)!) : null) !== receipt.previousSha256[id]) throw new Error('Previous extraction rollback evidence changed');
  }
  options.signal?.throwIfAborted();
  receipt.status = 'withdrawing'; await atomic(workspace, receiptPath, json(receipt));
  try {
    for (const [id, bytes] of backups) {
      options.signal?.throwIfAborted();
      if (bytes) await atomic(workspace, `.work/extract/${id}.json`, bytes);
      else await rm(safeCollectionPath(workspace, `.work/extract/${id}.json`), { force: true });
      const record = currentRecords.find(record => record.id === id)!;
      const previous = previousRecords.find(record => record.id === id);
      if (!previous) throw new Error('Previous object metadata is missing from withdrawal evidence');
      for (const field of ['title', 'description', 'canonical', 'robots', 'lang', 'pageType', 'words', 'images', 'links']) {
        if (Object.hasOwn(previous, field)) record[field] = previous[field]; else delete record[field];
      }
      state.activeExtractionAdoptions[id] = previousState.activeExtractionAdoptions?.[id] ?? { kind: 'baseline' };
    }
    const history = state.repairAdoptions?.find((item: { trialId?: string }) => item.trialId === adoption.trialId);
    if (!history) throw new Error('Active repair adoption history is missing');
    Object.assign(history, { state: 'withdrawn', withdrawalReason: reason, withdrawnAt: withdrawn.adoption.withdrawnAt });
    await atomic(workspace, '.work/state.json', json(state));
    await atomic(workspace, `${folder}/withdrawal.json`, json(withdrawn.adoption));
    receipt.status = 'withdrawn'; await atomic(workspace, receiptPath, json(receipt));
  } catch (error) {
    for (const [id, bytes] of current) await atomic(workspace, `.work/extract/${id}.json`, bytes);
    await atomic(workspace, '.work/state.json', stateBytes);
    await atomic(workspace, receiptPath, originalReceipt);
    throw error;
  }
  return { ...withdrawn, receipt, nextStages: ['data', 'render', 'verify'] };
}
