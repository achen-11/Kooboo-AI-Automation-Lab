import type { PublicSettings } from './types.js';

export interface KoobooConnectionInput { id: string; name: string; origin: string; apiOrigin: string }
export type KoobooLoginResult =
  | { status: 'connected'; environment: PublicSettings['environments'][number]; sites: number }
  | { status: 'verification-required'; method: 'email' | 'tel' | 'otp' }
  | { status: 'environment-mismatch'; origin: string };
