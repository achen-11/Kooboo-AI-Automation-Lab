import type { TimingStage } from '../../../shared/timing';
import type { DashboardStage } from '../../../shared/dashboard-analytics';

export const stageColors: Record<TimingStage | DashboardStage, string> = {
  generation: '#5279e7', repair: '#e6a65b', followup: '#d47c87', evaluation: '#2e9c79',
  delivery: '#7189a3', experience: '#9a8ac0', planning: '#dfa85b', other: '#b5bdc9',
  queue: '#b0bacb', prepare: '#91a4bc', evidence: '#65b8c0',
  optimization: '#d59b62', handoff: '#7899c1',
};

export interface CompositionItem {
  key: string;
  label: string;
  value: number;
  amount: string;
  color: string;
}
