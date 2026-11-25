import { defaultDeliveryPolicy } from '../../shared/automation.js';
import type { RuntimeSettings } from '../../shared/types.js';

export interface ResolvedDeliveryDefaults {
  endpoint: string;
  savedEndpoint: string;
  token: string;
  hasSavedToken: boolean;
  tokenFromEnv: boolean;
  endpointFromEnv: boolean;
}

export interface ResolvedEnvironmentDelivery {
  enabled: boolean;
  endpoint: string;
  auto: boolean;
  requirePassed: boolean;
  verifyWithAi: boolean;
  timeoutSeconds: number;
  token: string;
  hasCustomEndpoint: boolean;
  hasCustomToken: boolean;
}

function validHttpEndpoint(raw: string | undefined): string {
  const trimmed = raw?.trim() || '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
      return parsed.toString();
    }
  } catch {
    // Ignore malformed environment override instead of breaking settings loads.
  }
  return '';
}

export function resolveDeliveryDefaults(
  settings: Pick<RuntimeSettings, 'deliveryDefaults'>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDeliveryDefaults {
  const savedEndpoint = settings.deliveryDefaults?.endpoint?.trim() || '';
  const envEndpoint = validHttpEndpoint(env.EVALUATOR_DELIVERY_ENDPOINT);
  const endpoint = savedEndpoint || envEndpoint || defaultDeliveryPolicy.endpoint;
  const savedToken = settings.deliveryDefaults?.token || '';
  const envToken = env.EVALUATOR_DELIVERY_TOKEN?.trim() || '';
  const token = savedToken || envToken;
  return {
    endpoint,
    savedEndpoint,
    token,
    hasSavedToken: Boolean(savedToken),
    tokenFromEnv: !savedToken && Boolean(envToken),
    endpointFromEnv: !savedEndpoint && Boolean(envEndpoint),
  };
}

export function resolveEnvironmentDelivery(
  settings: Pick<RuntimeSettings, 'deliveryDefaults' | 'environments'>,
  environmentId: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnvironmentDelivery | undefined {
  const environment = settings.environments.find((item) => item.id === environmentId);
  const delivery = environment?.delivery;
  if (!delivery) return undefined;
  const defaults = resolveDeliveryDefaults(settings, env);
  const rawEndpoint = delivery.endpoint?.trim() || '';
  const ownToken = delivery.token || '';
  return {
    enabled: delivery.enabled,
    endpoint: rawEndpoint || defaults.endpoint,
    auto: delivery.auto,
    requirePassed: delivery.requirePassed,
    verifyWithAi: delivery.verifyWithAi ?? true,
    timeoutSeconds: delivery.timeoutSeconds,
    token: ownToken || defaults.token,
    hasCustomEndpoint: Boolean(rawEndpoint && rawEndpoint !== defaults.endpoint),
    hasCustomToken: Boolean(ownToken),
  };
}

export function collectDeliverySecrets(
  settings: Pick<RuntimeSettings, 'deliveryDefaults' | 'environments'>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const secrets = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) secrets.add(trimmed);
  };
  add(settings.deliveryDefaults?.token);
  add(env.EVALUATOR_DELIVERY_TOKEN);
  for (const environment of settings.environments) {
    add(environment.delivery?.token);
  }
  return [...secrets];
}
