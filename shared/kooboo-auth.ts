import type { PublicSettings } from './types.js';

export interface KoobooConnectionInput { id: string; name: string; origin: string; apiOrigin: string }
export type KoobooLoginResult =
  | { status: 'connected'; environment: PublicSettings['environments'][number]; sites: number }
  | { status: 'verification-required'; method: 'email' | 'tel' | 'otp' }
  | { status: 'environment-mismatch'; origin: string };

export type KoobooBrowserLoginStatus =
  | { sessionId: string; status: 'waiting'; browserChannel: string; message?: string }
  | { sessionId: string; status: 'verifying' }
  | { sessionId: string; status: 'connected'; environment: PublicSettings['environments'][number]; sites: number }
  | { sessionId: string; status: 'environment-mismatch'; origin: string }
  | { sessionId: string; status: 'cancelled'; error?: string }
  | { sessionId: string; status: 'failed'; error: string };
