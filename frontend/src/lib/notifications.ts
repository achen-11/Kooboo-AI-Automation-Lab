import { reactive } from 'vue';

export type MessageType = 'success' | 'info' | 'warning' | 'error';
export const notifications = reactive<{ id: number; type: MessageType; text: string }[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 0;

export function dismissMessage(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const index = notifications.findIndex(item => item.id === id);
  if (index >= 0) notifications.splice(index, 1);
}

export function holdMessage(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

export function expireMessage(id: number): void {
  holdMessage(id);
  timers.set(id, setTimeout(() => dismissMessage(id), 4000));
}

function show(type: MessageType, text: string): void {
  const duplicate = notifications.find(item => item.type === type && item.text === text);
  if (duplicate) { expireMessage(duplicate.id); return; }
  if (notifications.length >= 5) dismissMessage(notifications[0].id);
  const id = ++nextId;
  notifications.push({ id, type, text });
  expireMessage(id);
}

export const notify = {
  success: (text: string) => show('success', text),
  info: (text: string) => show('info', text),
  warning: (text: string) => show('warning', text),
  error: (text: string) => show('error', text),
};
