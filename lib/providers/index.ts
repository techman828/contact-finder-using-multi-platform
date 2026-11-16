/**
 * Provider registry.
 *
 * To add a platform: create `lib/providers/<id>.ts` exporting a `Provider` (see lib/types.ts):
 *   id, name, website, docs, keyHelp, options[]           -> rendered automatically in Settings
 *   lookup({ linkedinUrl, apiKey, options, need, callbackUrl })
 *       -> ProviderResult, or { waiting: true } if the answer will be POSTed to callbackUrl later
 *   parseCallback(body)  (optional, webhook-based APIs; served at /api/callbacks/<id>/<token>)
 *   credits(apiKey)      (optional, powers the "Check credits" button)
 * then add it to the list below. API keys (any number per provider) are managed on the Settings page.
 */
import type { Provider } from '../types';
import signalhire from './signalhire';
import prospeo from './prospeo';

export const providers: Provider[] = [signalhire, prospeo];
export const providerById: Record<string, Provider> = Object.fromEntries(providers.map((p) => [p.id, p]));
