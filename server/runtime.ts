import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
export { randomUUID, createHash } from 'node:crypto';
export { URL } from 'node:url';

/** SQLite transactions stay on the same Node connection; native Kooboo bindings are not used. */
export class Database {
  private connection: DatabaseSync;
  private depth = 0;
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
    const level = this.depth++;
    const savepoint = `nested_${level}`;
    try {
      this.exec(level ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      try { const value = operation(); this.exec(level ? `RELEASE ${savepoint}` : 'COMMIT'); return value; }
      catch (error) { this.exec(level ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK'); if(level) this.exec(`RELEASE ${savepoint}`); throw error; }
    } finally { this.depth--; }
  }
  close() { this.connection.close(); }
}
