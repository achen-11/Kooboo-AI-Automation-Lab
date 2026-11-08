export type DiagnosticStatus = 'queued' | 'collecting' | 'packing' | 'ready' | 'partial' | 'failed' | 'cancelled';
export interface DiagnosticIssue { section: string; path?: string; message: string }
export interface DiagnosticExport {
  id: string; taskId: string; generatedSiteId: string | null; resourceName: string;
  status: DiagnosticStatus; phase: string; createdAt: number; updatedAt: number; expiresAt: number;
  snapshotAt: number; taskCount: number; files: number; bytes: number;
  site: 'pending' | 'included' | 'unavailable'; issues: DiagnosticIssue[];
  filename: string; archiveBytes?: number; error?: string;
}
export const diagnosticActive = (state: DiagnosticStatus) => ['queued', 'collecting', 'packing'].includes(state);
