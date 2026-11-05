export function initializeArtifacts() {
  k.DB.sqlite.execute('CREATE TABLE IF NOT EXISTS evaluator_artifacts (evaluation_id TEXT NOT NULL, run_id TEXT NOT NULL, file TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(evaluation_id,run_id,file))');
}
export function saveArtifact(evaluationId: string, runId: string, file: string, content: string) {
  k.DB.sqlite.execute('INSERT OR REPLACE INTO evaluator_artifacts VALUES (@evaluationId,@runId,@file,@content)', { evaluationId, runId, file, content });
}
export function artifact(evaluationId: string, runId: string, file: string): string | null {
  const row = k.DB.sqlite.query('SELECT content FROM evaluator_artifacts WHERE evaluation_id=@evaluationId AND run_id=@runId AND file=@file', { evaluationId, runId, file })[0];
  return row ? String(row.content) : null;
}
