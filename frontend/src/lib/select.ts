export type SelectValue = string | number;
export interface SelectOption { value: SelectValue; label: string; disabled?: boolean; group?: string }

export const sameSelectValue = (a: SelectValue | undefined, b: SelectValue) => a !== undefined && String(a) === String(b);
export function filterSelectOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const text = query.trim().normalize('NFKC').toLocaleLowerCase();
  return options.filter(option => !text || `${option.group || ''} ${option.label}`.normalize('NFKC').toLocaleLowerCase().includes(text));
}
export function moveSelectIndex(options: readonly SelectOption[], current: number, delta: 1 | -1): number {
  for (let step = 1; step <= options.length; step++) {
    const index = ((current < 0 ? (delta > 0 ? -1 : 0) : current) + step * delta + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}
export function selectValue(value: SelectValue, current: SelectValue | undefined, numberModifier = false): SelectValue {
  if (numberModifier || typeof current === 'number') {
    const number = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isNaN(number)) return number;
  }
  return value;
}

/** Fit the menu to the visible viewport, including when a mobile keyboard reduces it. */
export function selectMenuPlacement(anchor: { left: number; top: number; bottom: number; width: number }, viewport: { width: number; height: number; left?: number; top?: number }) {
  const leftEdge = (viewport.left || 0) + 8, topEdge = (viewport.top || 0) + 8;
  const rightEdge = leftEdge + viewport.width - 16, bottomEdge = topEdge + viewport.height - 16;
  const width = Math.max(0, Math.min(Math.max(anchor.width, 220), viewport.width - 16));
  const below = Math.max(0, bottomEdge - anchor.bottom - 6), above = Math.max(0, anchor.top - topEdge - 6);
  const opensAbove = below < 240 && above > below;
  return { left: Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)), width, maxHeight: Math.min(360, opensAbove ? above : below), opensAbove };
}
