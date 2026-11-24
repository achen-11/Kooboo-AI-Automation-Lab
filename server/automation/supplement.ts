import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type {
  SupplementalFileRef,
  SupplementMode,
  SupplementPreviewSummary,
  TaskSupplementBatch,
  TaskSupplementContext,
  TaskSupplementPendingUpload,
} from '../../shared/supplement.js';
import type { Vault } from '../lib/vault.js';
import { Conflict } from '../lib/store.js';
import { koobooClient } from './kooboo.js';
import { mergeTaskMaterials, syncMaterialManifestToSite, uploadMaterialsToKoobooSite } from './kooboo-materials.js';
import { prepareManualFollowupResume } from './autonomy.js';
import { clearSiteRetry } from './retry-guard.js';
import type { AutomationStore } from './store.js';

export class SupplementStore {
  constructor(private readonly store: AutomationStore) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_task_supplements(
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auto_task_supplements_task ON auto_task_supplements(task_id, created_at DESC);
    `);
  }

  list(taskId: string): TaskSupplementBatch[] {
    const rows = this.store.db
      .prepare('SELECT json FROM auto_task_supplements WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as TaskSupplementBatch);
  }

  get(id: string): TaskSupplementBatch | undefined {
    const row = this.store.db
      .prepare('SELECT json FROM auto_task_supplements WHERE id = ?')
      .get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TaskSupplementBatch) : undefined;
  }

  put(batch: TaskSupplementBatch): TaskSupplementBatch {
    this.store.db
      .prepare(
        `INSERT INTO auto_task_supplements VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, json = excluded.json`,
      )
      .run(batch.id, batch.taskId, batch.createdAt, JSON.stringify(batch));
    return batch;
  }
}

export function saveLocalMaterialFile(
  store: AutomationStore,
  directory: string,
  input: { name: string; type: string; bytes: Buffer },
): MaterialFile {
  const filesDir = resolve(directory, 'materials');
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const candidates = store.db
    .prepare("SELECT json FROM auto_files WHERE json_extract(json,'$.name') = ? AND json_extract(json,'$.sha256') = ?")
    .all(input.name, sha256) as Array<{ json: string }>;
  for (const row of candidates) {
    const saved = JSON.parse(row.json) as MaterialFile;
    const filePath = resolve(filesDir, saved.id);
    if (saved.type === input.type && existsSync(filePath)) {
      const existingSha = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      if (existingSha === sha256) return saved;
    }
  }
  const item: MaterialFile = {
    id: randomUUID(),
    name: input.name,
    type: input.type,
    size: input.bytes.length,
    sha256,
  };
  writeFileSync(resolve(filesDir, item.id), input.bytes, { mode: 0o600, flag: 'wx' });
  store.db.prepare('INSERT INTO auto_files VALUES(?, ?)').run(item.id, JSON.stringify(item));
  return item;
}

export function extractPendingAskUserInput(task: AutomationTask): TaskSupplementPendingUpload | undefined {
  const pending = task.generation?.pending as
    | { callId?: unknown; name?: unknown; args?: Record<string, unknown> }
    | null
    | undefined;
  if (!pending || typeof pending !== 'object' || pending.name !== 'ask_user_input' || typeof pending.callId !== 'string') {
    return undefined;
  }
  const args = pending.args && typeof pending.args === 'object' ? pending.args : {};
  const upload = args.upload && typeof args.upload === 'object' ? (args.upload as Record<string, unknown>) : undefined;
  const target =
    upload?.target === 'mediaLibrary' || upload?.target === 'cmsFile' || upload?.target === 'iframe'
      ? upload.target
      : undefined;
  return {
    callId: pending.callId,
    kind: typeof args.kind === 'string' ? args.kind : 'upload',
    question: typeof args.question === 'string' ? args.question : '请补充输入或上传所需文件',
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    ...(target ? { target } : {}),
    ...(Array.isArray(upload?.accept) ? { accept: upload.accept.map(String) } : {}),
    ...(typeof upload?.folder === 'string' ? { folder: upload.folder } : {}),
    ...(typeof upload?.maxFiles === 'number' ? { maxFiles: upload.maxFiles } : {}),
    ...(typeof upload?.purpose === 'string' ? { purpose: upload.purpose } : {}),
  };
}

export function createSupplementBatch(params: {
  taskId: string;
  mode: SupplementMode;
  status: TaskSupplementBatch['status'];
  note: string;
  sourceUrl?: string;
  replacementContentUrl?: string;
  replacementReferenceUrl?: string;
  skipSourceTransfer?: boolean;
  skipReferencePreflight?: boolean;
  allowFreeDesignWithoutReference?: boolean;
  autoApply?: boolean;
  inputFiles?: MaterialFile[];
  files?: SupplementalFileRef[];
  summary?: SupplementPreviewSummary;
}): TaskSupplementBatch {
  const now = Date.now();
  return {
    id: randomUUID(),
    taskId: params.taskId,
    mode: params.mode,
    status: params.status,
    createdAt: now,
    updatedAt: now,
    note: params.note,
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    ...(params.replacementContentUrl ? { replacementContentUrl: params.replacementContentUrl } : {}),
    ...(params.replacementReferenceUrl ? { replacementReferenceUrl: params.replacementReferenceUrl } : {}),
    ...(params.skipSourceTransfer !== undefined ? { skipSourceTransfer: params.skipSourceTransfer } : {}),
    ...(params.skipReferencePreflight !== undefined ? { skipReferencePreflight: params.skipReferencePreflight } : {}),
    ...(params.allowFreeDesignWithoutReference !== undefined
      ? { allowFreeDesignWithoutReference: params.allowFreeDesignWithoutReference }
      : {}),
    ...(params.autoApply !== undefined ? { autoApply: params.autoApply } : {}),
    ...(params.inputFiles?.length ? { inputFiles: params.inputFiles } : {}),
    files: params.files || [],
    ...(params.summary ? { summary: params.summary } : {}),
  };
}

export function buildSupplementContext(task: AutomationTask, store: AutomationStore, supplements: SupplementStore): TaskSupplementContext {
  const version = store.version(task.versionId);
  const batches = supplements.list(task.id);
  const pendingUpload = extractPendingAskUserInput(task);
  const canSupplement =
    task.kind === 'generation' &&
    Boolean(task.stopped) &&
    ['interrupted', 'pending', 'failed', 'cancelled'].includes(task.status);
  return {
    batches,
    ...(pendingUpload ? { pendingUpload } : {}),
    effectiveContentUrl: task.generation?.overrideContentUrl?.trim() || version?.contentUrl || '',
    effectiveReferenceUrl: task.generation?.overrideReferenceUrl?.trim() || version?.referenceUrl || '',
    canSupplement,
    hasTargetSite: Boolean(task.generatedSiteId),
    ...(task.interruption?.userSummary?.category ? { interruptionCategory: task.interruption.userSummary.category } : {}),
    ...(task.generation?.referencePreflight?.status === 'failed'
      ? {
          referencePreflightFailed: true,
          referencePreflightDetail: task.generation.referencePreflight.detail || '',
        }
      : {}),
    ...(task.generation?.skipReferencePreflight ? { skipReferencePreflight: true } : {}),
    ...(task.generation?.allowFreeDesignWithoutReference ? { allowFreeDesignWithoutReference: true } : {}),
  };
}

export async function applySupplementBatch(params: {
  batch: TaskSupplementBatch;
  task: AutomationTask;
  store: AutomationStore;
  supplements: SupplementStore;
  vault: Vault;
  directory: string;
  signal: AbortSignal;
  selectedFileIds?: string[];
  noteOverride?: string;
  skipSourceTransferOverride?: boolean;
  skipReferencePreflightOverride?: boolean;
  allowFreeDesignWithoutReferenceOverride?: boolean;
  replacementContentUrlOverride?: string;
  replacementReferenceUrlOverride?: string;
  fetcher?: typeof fetch;
}): Promise<{ task: AutomationTask; batch: TaskSupplementBatch }> {
  const { batch, task, store, supplements, vault, directory, signal } = params;
  if (task.kind !== 'generation') throw new Conflict('仅支持为生成任务补充资料');
  if (!task.stopped || !['interrupted', 'pending', 'failed', 'cancelled'].includes(task.status)) {
    throw new Conflict('请等待当前执行停止后再导入补充资料并恢复');
  }
  if (store.dispositions.get('delivery', task.generatedSiteId || task.id)) {
    throw new Conflict('该任务或生成站已归档，请先移回在列后再补充资料');
  }
  if (!['ready', 'collecting'].includes(batch.status) && batch.mode !== 'manual') {
    throw new Conflict('当前资料批次状态不支持重复应用');
  }

  const chosenIds = params.selectedFileIds?.length ? new Set(params.selectedFileIds) : undefined;
  const chosenFiles = chosenIds ? batch.files.filter(f => chosenIds.has(f.id)) : batch.files;
  const effectiveNote = (params.noteOverride !== undefined ? params.noteOverride : batch.note).trim();
  const nextContentUrl =
    params.replacementContentUrlOverride !== undefined
      ? params.replacementContentUrlOverride.trim()
      : (batch.replacementContentUrl || '').trim();
  const nextReferenceUrl =
    params.replacementReferenceUrlOverride !== undefined
      ? params.replacementReferenceUrlOverride.trim()
      : (batch.replacementReferenceUrl || '').trim();
  const requestedSkipTransfer =
    params.skipSourceTransferOverride !== undefined ? params.skipSourceTransferOverride : batch.skipSourceTransfer;
  const requestedSkipReferencePreflight =
    params.skipReferencePreflightOverride !== undefined
      ? params.skipReferencePreflightOverride
      : batch.skipReferencePreflight;
  const requestedAllowFreeDesign =
    params.allowFreeDesignWithoutReferenceOverride !== undefined
      ? params.allowFreeDesignWithoutReferenceOverride
      : batch.allowFreeDesignWithoutReference;

  if (
    !chosenFiles.length &&
    !effectiveNote &&
    !nextContentUrl &&
    !nextReferenceUrl &&
    !requestedSkipTransfer &&
    !requestedSkipReferencePreflight &&
    !requestedAllowFreeDesign
  ) {
    throw new Conflict('请至少上传文件、填写补充说明、提供新网址或选择明确的处理方式');
  }

  task.generation ??= {};
  const wasReferencePreflightFailed = task.generation.referencePreflight?.status === 'failed';
  const existingSupp = task.generation.supplementalFiles || [];
  task.generation.supplementalFiles = mergeTaskMaterials(existingSupp, chosenFiles);
  if (effectiveNote) {
    task.generation.supplementalNotes = [...(task.generation.supplementalNotes || []), effectiveNote].slice(-20);
  }

  const version = store.version(task.versionId);
  const currentContentUrl = task.generation.overrideContentUrl?.trim() || version?.contentUrl || '';
  if (nextContentUrl && nextContentUrl !== currentContentUrl) {
    task.generation.overrideContentUrl = nextContentUrl;
    delete task.generation.sourceSandbox;
    delete task.generation.transferTaskId;
    delete task.generation.transferComplete;
    delete task.generation.transferFallbackAttempted;
    delete task.generation.skipSourceTransfer;
  }
  const currentReferenceUrl = task.generation.overrideReferenceUrl?.trim() || version?.referenceUrl || '';
  if (nextReferenceUrl) {
    if (nextReferenceUrl !== currentReferenceUrl) {
      task.generation.overrideReferenceUrl = nextReferenceUrl;
    }
    delete task.generation.referencePreflight;
    delete task.generation.skipReferencePreflight;
    delete task.generation.allowFreeDesignWithoutReference;
  }

  const hasUploadedReferenceImages = chosenFiles.some(f => f.type.startsWith('image/'));
  if (requestedAllowFreeDesign) {
    task.generation.allowFreeDesignWithoutReference = true;
    delete task.generation.skipReferencePreflight;
    delete task.generation.referencePreflight;
  } else if (
    requestedSkipReferencePreflight ||
    (wasReferencePreflightFailed && !nextReferenceUrl && hasUploadedReferenceImages)
  ) {
    task.generation.skipReferencePreflight = true;
    delete task.generation.allowFreeDesignWithoutReference;
  }

  const isSourceAccess = task.interruption?.userSummary?.category === 'source-access';
  if (
    requestedSkipTransfer ||
    (!nextContentUrl &&
      !wasReferencePreflightFailed &&
      isSourceAccess &&
      (chosenFiles.length > 0 || Boolean(effectiveNote)))
  ) {
    task.generation.skipSourceTransfer = true;
    task.generation.transferComplete = true;
    if (task.generation.sourceSandbox) task.generation.sourceSandbox.complete = true;
  }

  const pending = extractPendingAskUserInput(task);
  let uploadedCount = 0;
  let answeredPending = false;
  let continuedConversation = false;
  const uploadedMappings: string[] = [];

  if (task.generatedSiteId) {
    const site = store.site(task.generatedSiteId);
    if (!site) throw new Conflict('未找到任务绑定的目标站点记录');
    const allFiles = mergeTaskMaterials(version?.files || [], task.generation.supplementalFiles);

    let mode: 'materials' | 'mediaLibrary' = 'materials';
    let mediaFolder: string | undefined;
    if (pending?.kind === 'upload' && pending.target === 'mediaLibrary' && chosenFiles.length) {
      mode = 'mediaLibrary';
      mediaFolder = pending.folder || `automation-uploads/${task.id}`;
    }

    const { environment, origin, request } = koobooClient(task, vault, signal);
    const apiOrigin = new URL(environment.apiOrigin || origin).origin;

    const uploadResult = chosenFiles.length
      ? await uploadMaterialsToKoobooSite({
          task,
          siteId: site.siteId,
          files: chosenFiles,
          apiOrigin,
          token: environment.token!,
          request,
          directory,
          signal,
          mode,
          mediaFolder,
          fetcher: params.fetcher,
        })
      : { uploaded: [], newlyImportedCount: 0 };

    uploadedCount = uploadResult.uploaded.length;
    for (const u of uploadResult.uploaded) uploadedMappings.push(u.mapping);

    if (allFiles.length && mode === 'materials' && uploadResult.uploaded.length > 0) {
      await syncMaterialManifestToSite({ task, siteId: site.siteId, allFiles, request });
    }

    const referenceDecisionNote = task.generation.allowFreeDesignWithoutReference
      ? '参考站决策：操作者已明确授权放弃不可达的参考站，改为结合内容站与资料包自由设计。'
      : task.generation.skipReferencePreflight
        ? '参考站决策：操作者已补充参考站截图并确认跳过外链预检，请严格以补充截图作为视觉还原基准。'
        : '';

    if (pending) {
      const choiceText = task.generation.allowFreeDesignWithoutReference
        ? `放弃参考站，明确授权 AI 结合业务资料自由设计${effectiveNote ? `（${effectiveNote}）` : ''}`
        : nextReferenceUrl
          ? `已更换参考站地址为 ${nextReferenceUrl}${effectiveNote ? `（${effectiveNote}）` : ''}`
          : task.generation.skipReferencePreflight || uploadedCount > 0
            ? `已补充参考站截图/资料（共 ${uploadedCount} 个文件）并按补充截图还原${effectiveNote ? `（${effectiveNote}）` : ''}`
            : effectiveNote || `已补充 ${uploadedCount} 份资料`;
      const value =
        pending.kind === 'upload'
          ? uploadResult.uploaded.map(u => ({
              ...(u.id ? { id: u.id } : {}),
              name: u.name,
              ...(u.url ? { url: u.url } : {}),
              ...(u.relativeUrl ? { relativeUrl: u.relativeUrl } : {}),
              ...(u.key ? { key: u.key } : {}),
              mimeType: u.mimeType,
              size: u.size,
              storage: u.storage,
            }))
          : pending.kind === 'confirm'
            ? true
            : choiceText;
      const answerFeedback = [effectiveNote, referenceDecisionNote].filter(Boolean).join('\n');
      task.generation.next = {
        action: 'answer',
        callId: pending.callId,
        answer: {
          confirmed: true,
          kind: pending.kind,
          value,
          ...(answerFeedback ? { feedback: answerFeedback } : {}),
        },
        reason: '已通过 Automation Lab 补充资料/确认输入并回答挂起调用',
        evidence: [`human-supplement:${batch.id}`],
      };
      answeredPending = true;
    } else if (task.generation.deliveryId) {
      const lines = [
        '操作者通过 Automation Lab 补充了新的资料与说明，请基于本次补充资料继续完成当前站点任务：',
        ...(effectiveNote ? [`补充说明：${effectiveNote}`] : []),
        ...(uploadedMappings.length
          ? ['新增/更新文件映射：', ...uploadedMappings.map(line => `- ${line}`)]
          : []),
        ...(nextReferenceUrl ? [`更新参考地址：${nextReferenceUrl}`] : []),
        ...(referenceDecisionNote ? [referenceDecisionNote] : []),
      ];
      task.generation.next = {
        action: 'continue',
        message: lines.join('\n'),
        reason: '人工补充资料并继续原生成会话',
        evidence: [`human-supplement:${batch.id}`],
      };
      continuedConversation = true;
    }
  }

  if (!task.generatedSiteId || (!task.generation.deliveryId && !pending)) {
    const appendix = [
      `[人工/AI 补充资料 ${batch.id.slice(0, 8)}]`,
      ...(effectiveNote ? [`补充说明：${effectiveNote}`] : []),
      ...(chosenFiles.length ? [`补充文件（共 ${chosenFiles.length} 个）：${chosenFiles.map(f => f.name).join('、')}`] : []),
      ...(nextContentUrl ? [`新源站地址：${nextContentUrl}`] : []),
      ...(nextReferenceUrl ? [`新参考地址：${nextReferenceUrl}`] : []),
      ...(task.generation.skipReferencePreflight
        ? ['参考站决策：已上传参考站截图并跳过外链预检，请优先查看补充截图并以此作为视觉还原基准。']
        : []),
      ...(task.generation.allowFreeDesignWithoutReference
        ? ['参考站决策：操作者已明确授权放弃参考站，改为结合内容站与资料包自由设计。']
        : []),
    ].join('\n');
    task.message = task.message ? `${task.message}\n\n${appendix}` : appendix;
  }

  delete task.generation.transferFallbackAttempted;
  delete task.interruption;
  task.error = '';
  task.status = 'queued';
  prepareManualFollowupResume(task, store);
  if (task.followup) {
    task.followup.state = 'resolved';
    task.followup.executionStopped = true;
  }
  clearSiteRetry(task, store);
  store.put(task);

  const now = Date.now();
  batch.status = 'applied';
  batch.updatedAt = now;
  batch.appliedAt = now;
  batch.appliedResult = { uploadedCount, answeredPending, continuedConversation };
  supplements.put(batch);

  store.event(
    task.id,
    `已应用${batch.mode === 'ai-assisted' ? ' AI 整理' : '人工'}补充资料（${chosenFiles.length} 个文件${effectiveNote ? ' + 补充说明' : ''}）并重新入队继续执行`,
  );

  return { task, batch };
}
