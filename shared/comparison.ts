import type { Issue, Report, Screenshot } from './types.js';

export type Role = Screenshot['role'];
export type Viewport = Screenshot['viewport'];
export type Pairing = NonNullable<Report['pairings']>[number];
export interface Selection { reference: string; target: string; pairIndex: number }
export interface PairOption { pair: Pairing; index: number }
export const opposite = (role: Role): Role => role === 'reference' ? 'target' : 'reference';

export function roleShots(shots: Screenshot[], role: Role, viewport: Viewport): Screenshot[] {
  return shots.filter(s => s.role === role && s.viewport === viewport && !s.diagnostic)
    .sort((a, b) => (a.pageY ?? 0) - (b.pageY ?? 0));
}

export function pairOptions(shots: Screenshot[], pairings: Pairing[], viewport: Viewport): PairOption[] {
  const ids = new Set(shots.filter(s => s.viewport === viewport && !s.diagnostic).map(s => s.id));
  return pairings.map((pair, index) => ({ pair, index }))
    .filter(({ pair }) => pair.target.some(id => ids.has(id)) && pair.reference.some(id => ids.has(id)));
}

/** Retain the explicit region: two different regions may occupy the same tile. */
export function selectPair(selection: Selection, option: PairOption, shots: Screenshot[], viewport: Viewport): Selection {
  const next = { ...selection, pairIndex: option.index };
  for (const role of ['reference', 'target'] as const) {
    const candidates = roleShots(shots, role, viewport).filter(s => option.pair[role].includes(s.id));
    next[role] = candidates.find(s => s.id === selection[role])?.id || candidates[0]?.id || '';
  }
  return next;
}

/** A clicked evidence ID always wins; linking only chooses the other side. */
export function selectShot(selection: Selection, role: Role, id: string, shots: Screenshot[], pairings: Pairing[], viewport: Viewport, linked: boolean): Selection {
  const own = roleShots(shots, role, viewport);
  if (!own.some(s => s.id === id)) return selection;
  const next = { ...selection, [role]: id };
  const other = opposite(role), options = pairOptions(shots, pairings, viewport);
  const option = options.find(o => o.index === selection.pairIndex && o.pair[role].includes(id))
    || options.find(o => o.pair[role].includes(id));
  if (linked && option) {
    const paired = selectPair(next, option, shots, viewport);
    return { ...paired, [role]: id };
  }
  if (!linked) return { ...next, pairIndex: option?.index ?? -1 };
  if (linked && !options.length) {
    const candidates = roleShots(shots, other, viewport);
    next[other] = candidates[Math.min(own.findIndex(s => s.id === id), candidates.length - 1)]?.id || '';
  }
  next.pairIndex = options.find(o => o.pair[role].includes(id) && o.pair[other].includes(next[other]))?.index ?? -1;
  return next;
}

/** Issue previews include referenced images, plus a real pairing when one side is absent. */
export function scopedShots(shots: Screenshot[], evidenceIds: string[] | undefined, pairings: Pairing[]): Screenshot[] {
  if (!evidenceIds) return shots.filter(s => !s.diagnostic);
  const selected = shots.filter(s => evidenceIds.includes(s.id) && !s.diagnostic);
  const ids = new Set(selected.map(s => s.id));
  for (const shot of selected) {
    const other = opposite(shot.role);
    const option = pairOptions(shots, pairings, shot.viewport).find(o => o.pair[shot.role].includes(shot.id));
    if (option && selected.some(s => s.viewport === shot.viewport && s.role === other && option.pair[other].includes(s.id))) continue;
    if (option) for (const candidate of roleShots(shots, other, shot.viewport))
      if (option.pair[other].includes(candidate.id)) ids.add(candidate.id);
  }
  return shots.filter(s => ids.has(s.id));
}

export interface Slice { shot: Screenshot; cropTop: number; height: number; gap: number }
/** Crop overlapping rows for display only. Original artifacts remain unchanged. */
export function continuousSlices(shots: Screenshot[]): Slice[] {
  let end: number | undefined;
  const result: Slice[] = [];
  for (const shot of shots) {
    const start = shot.pageY;
    const cropTop = start != null && end != null ? Math.min(shot.height, Math.max(0, end - start)) : 0;
    const gap = start != null && end != null ? Math.max(0, start - end) : 0;
    if (shot.height > cropTop) result.push({ shot, cropTop, height: shot.height - cropTop, gap });
    end = start != null ? Math.max(end ?? 0, start + shot.height) : undefined;
  }
  return result;
}

export function relatedIssues(issues: Issue[], ids: string[]): Issue[] {
  const visible = new Set(ids);
  return issues.filter(issue => issue.evidence.some(id => visible.has(id)));
}
