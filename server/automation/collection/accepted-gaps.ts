import type { AcceptedCollectionAssetGap, AcceptedCollectionAssetGapEntry, CollectionRun } from '../../../shared/collection.js';
import { collectionHash } from './runtime.js';

export const acceptedAssetGapEvidencePath = 'site/accepted-source-gaps.json' as const;
const groups = ['assets', 'files', 'stylesheets'] as const;
const key = (entry:AcceptedCollectionAssetGapEntry) => JSON.stringify([entry.collection, entry.kind, entry.url, entry.status, entry.note]);
const object = (value:unknown):value is Record<string,unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Read the engine's real failure fields; over-limit and unaccounted plans are ineligible. */
export function failedCollectionAssetEntries(state:unknown):AcceptedCollectionAssetGapEntry[] {
  if (!object(state)) throw new Error('采集状态无效');
  const entries = new Map<string,AcceptedCollectionAssetGapEntry>();
  for (const collection of groups) {
    const rows = state[collection];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error('素材状态清单无效：' + collection);
    for (const row of rows) {
      if (!object(row)) throw new Error('素材状态条目无效：' + collection);
      if (row.status !== 'failed') continue;
      if (typeof row.url !== 'string' || (row.note !== undefined && typeof row.note !== 'string')) throw new Error('失败素材缺少精确URL或原始错误');
      const url = new URL(row.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('失败素材URL不合法');
      const entry:AcceptedCollectionAssetGapEntry = { collection, kind:collection === 'stylesheets' ? 'stylesheet' : 'asset', url:row.url, status:'failed', note:row.note || '' };
      entries.set(key(entry),entry);
    }
  }
  return [...entries.values()].sort((a,b)=>key(a).localeCompare(key(b)));
}

export function acceptedAssetGapIndex(run:CollectionRun) {
  return { version:1, taskId:run.taskId, collectionId:run.id, inputVersionId:run.inputVersionId, acceptances:run.acceptedAssetGaps || [] };
}

export function assertAcceptedAssetGapIndex(run:CollectionRun, read:(path:string)=>Buffer) {
  if (!run.acceptedAssetGaps?.length) return;
  for (const acceptance of run.acceptedAssetGaps) {
    if (acceptance.actor !== 'human' || acceptance.taskId !== run.taskId || acceptance.collectionId !== run.id || acceptance.inputVersionId !== run.inputVersionId || acceptance.evidencePath !== acceptedAssetGapEvidencePath || !/^[a-f0-9]{64}$/.test(acceptance.stateHash)) throw new Error('素材接受记录与固定任务/输入版本不一致');
  }
  const actual = JSON.parse(read(acceptedAssetGapEvidencePath).toString('utf8'));
  if (collectionHash(JSON.stringify(actual)) !== collectionHash(JSON.stringify(acceptedAssetGapIndex(run)))) throw new Error('素材接受记录索引不完整或已变化');
}

export function acceptedCollectionAssetEntry(run:CollectionRun, entry:AcceptedCollectionAssetGapEntry) {
  return Boolean(run.acceptedAssetGaps?.some(acceptance=>acceptance.actor === 'human' && acceptance.taskId === run.taskId && acceptance.collectionId === run.id && acceptance.inputVersionId === run.inputVersionId && acceptance.evidencePath === acceptedAssetGapEvidencePath && acceptance.entries.some(saved=>key(saved) === key(entry))));
}

export function acceptedCollectionAssetFinding(run:CollectionRun, state:unknown, finding:{kind?:string;url?:string;reason?:string}) {
  if (!['asset','stylesheet'].includes(finding.kind || '') || typeof finding.url !== 'string' || typeof finding.reason !== 'string') return false;
  // The checklist uses note || status. It never supplies the status independently.
  const matches = failedCollectionAssetEntries(state).filter(entry=>entry.kind === finding.kind && entry.url === finding.url && (entry.note || entry.status) === finding.reason);
  return matches.length > 0 && matches.every(entry=>acceptedCollectionAssetEntry(run,entry));
}

export function acceptedAssetGapGuidance(acceptances:readonly AcceptedCollectionAssetGap[]|undefined):string {
  if (!acceptances?.length) return '';
  const count = new Set(acceptances.flatMap(acceptance=>acceptance.entries.map(key))).size;
  return `人类已按当前素材接受确切${count}项已失败素材/样式表，A6仅称约定素材范围通过。具体URL、原始status/note、授权理由及时间见 collection/${acceptedAssetGapEvidencePath}。仅这些记录且错误一致时适用，不能豁免全部缺失或新增缺口。生成与评测不要求恢复这些缺失原素材，不把它们列作生成/后续修复目标；禁止重新全站抓取或捏造补齐。已取得素材、可见正文、数据、关系、功能及新缺陷仍照常核验；脚本线索不等于可见正文，素材接受不表示接受正文无证据。`;
}

export function acceptedAssetGapLimitations(run:CollectionRun):string[] {
  const guidance = acceptedAssetGapGuidance(run.acceptedAssetGaps);
  return guidance ? [guidance] : [];
}
