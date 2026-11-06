import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
export { randomUUID, createHash } from 'node:crypto';
export { URL } from 'node:url';

/** SQLite transactions stay on the same Node connection; native Kooboo bindings are not used. */
export class Database {
  private connection: DatabaseSync;
  constructor(file: string) { this.connection = new DatabaseSync(file); }
  exec(sql: string) { this.connection.exec(sql); }
  prepare(sql: string) {
    const statement = this.connection.prepare(sql);
    return {
      all: (...values: unknown[]): any[] => statement.all(...values as SQLInputValue[]),
      get: (...values: unknown[]): any => statement.get(...values as SQLInputValue[]),
      run: (...values: unknown[]) => statement.run(...values as SQLInputValue[]),
    };
  }
  transaction<T>(operation: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.exec('COMMIT'); return value; }
    catch (error) { this.exec('ROLLBACK'); throw error; }
  }
  close() { this.connection.close(); }
}
