import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const maintenancePath = (directory: string) => resolve(directory, 'update-maintenance.json');
export const inMaintenance = (directory: string) => existsSync(maintenancePath(directory));
