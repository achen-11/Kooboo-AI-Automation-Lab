import type { RuleSet } from '../../../shared/types.js';

export function newDimension(dimensions: RuleSet['dimensions']): RuleSet['dimensions'][number] {
  const used = new Set(dimensions.map(item => item.id));
  let next = 1;
  while (used.has(`dimension-${next}`)) next++;
  return { id: `dimension-${next}`, label: '', weight: 0, instruction: '' };
}
