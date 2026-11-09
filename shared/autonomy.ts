/** Frozen only onto new tasks. Absence deliberately preserves historical hard budgets. */
export interface AutonomousExecution {
  version: 1;
  mode: 'completion-first';
  policy: {
    retryBaseMs: number;
    retryMaxMs: number;
    maxSameFailures: number;
    maxNoProgress: number;
    maxStrategyReturns: number;
    maxDiagnostics: number;
    hardMaxRounds?: number;
    hardCostCny?: number;
  };
  objective: { id: string; description: string };
  checkpoint: { nextAt?: number; stage?: string; reason?: string; progressKey?: string; diagnosticRequired?: boolean };
  window: { index: number; startedAt: number; attemptsBase: number; tokensBase: number; elapsedMsBase: number };
  history: {
    failures: { fingerprint: string; progressKey: string; strategy: string; at: number; reason: string }[];
    strategies: string[];
    noProgress: number;
    diagnostics: number;
    strategyReturns: number;
  };
  stopReason?: string;
}

export const defaultAutonomousPolicy: AutonomousExecution['policy'] = {
  retryBaseMs: 5000, retryMaxMs: 300000, maxSameFailures: 4,
  maxNoProgress: 8, maxStrategyReturns: 2, maxDiagnostics: 2,
};

export function createAutonomousExecution(description: string, limits: { hardMaxRounds?: number; hardCostCny?: number } = {}, now = Date.now()): AutonomousExecution {
  if(limits.hardMaxRounds!==undefined&&(!Number.isSafeInteger(limits.hardMaxRounds)||limits.hardMaxRounds<1))throw new Error('自主执行硬轮数不合法');
  if(limits.hardCostCny!==undefined&&(!Number.isFinite(limits.hardCostCny)||limits.hardCostCny<=0))throw new Error('自主执行硬费用不合法');
  return {version:1,mode:'completion-first',policy:{...defaultAutonomousPolicy,...limits},objective:{id:'delivery',description},checkpoint:{},window:{index:0,startedAt:now,attemptsBase:0,tokensBase:0,elapsedMsBase:0},history:{failures:[],strategies:[],noProgress:0,diagnostics:0,strategyReturns:0}};
}
