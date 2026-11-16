import { db } from './db';
import { type KeyInput, type KeyRow, listKeys, syncProviderKeys, toPublicKey } from './keys';
import { providerById, providers } from './providers';
import type { Options, PublicSettings, StopRule } from './types';

export const STOP_RULES: Record<StopRule, string> = {
  email_and_phone: 'Stop once an email AND a phone are found',
  email: 'Stop once an email is found',
  never: 'Always query every provider',
};

interface General {
  stopWhen: StopRule;
  /** Overrides the auto-detected public URL used for provider callbacks. */
  publicUrl: string;
}
const DEFAULT_GENERAL: General = { stopWhen: 'email_and_phone', publicUrl: '' };

/** Stored in settings.providers (API keys live in the api_keys table). */
interface SavedProvider {
  id: string;
  enabled: boolean;
  options: Options;
}

export interface ProviderConfig extends SavedProvider {
  /** Number of enabled API keys. */
  activeKeys: number;
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const sql = await db();
  const [row] = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return row ? (row.value as T) : fallback;
}

export async function getGeneralSettings(): Promise<General> {
  return { ...DEFAULT_GENERAL, ...(await getSetting<Partial<General>>('general', {})) };
}

/**
 * Public base URL that providers can reach for callbacks.
 * Settings override > APP_URL > Vercel production domain. Null on localhost.
 */
export function resolvePublicUrl(general: General): string | null {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const url = general.publicUrl || process.env.APP_URL || (vercel ? `https://${vercel}` : '');
  const clean = url.trim().replace(/\/+$/, '');
  if (!clean || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(clean)) return null;
  return clean;
}

function buildConfigs(saved: SavedProvider[], keys: KeyRow[]) {
  const savedById = Object.fromEntries(saved.map((s) => [s.id, s]));
  const order = [...new Set([...saved.map((s) => s.id).filter((id) => providerById[id]), ...providers.map((p) => p.id)])];
  return order.map((id) => {
    const p = providerById[id];
    const s: Partial<SavedProvider> = savedById[id] || {};
    const defaults = Object.fromEntries(p.options.map((o) => [o.key, o.default]));
    const own = keys.filter((k) => k.provider === id);
    return {
      config: {
        id,
        enabled: s.enabled ?? true,
        options: { ...defaults, ...(s.options || {}) },
        activeKeys: own.filter((k) => k.enabled).length,
      } satisfies ProviderConfig,
      keys: own,
    };
  });
}

/** Provider config in waterfall order (server side). */
export async function getProviderConfigs(): Promise<ProviderConfig[]> {
  const [saved, keys] = await Promise.all([getSetting<SavedProvider[]>('providers', []), listKeys()]);
  return buildConfigs(saved, keys).map((x) => x.config);
}

/** Settings safe to send to the browser (API keys masked). */
export async function publicSettings(): Promise<PublicSettings> {
  const [general, saved, keys] = await Promise.all([getGeneralSettings(), getSetting<SavedProvider[]>('providers', []), listKeys()]);
  return {
    general,
    stopRules: STOP_RULES,
    publicUrl: resolvePublicUrl(general),
    providers: buildConfigs(saved, keys).map(({ config: c, keys: own }) => {
      const p = providerById[c.id];
      return {
        id: c.id,
        name: p.name,
        website: p.website,
        docs: p.docs,
        keyHelp: p.keyHelp,
        enabled: c.enabled,
        keys: own.map(toPublicKey),
        canCheckCredits: typeof p.credits === 'function',
        optionDefs: p.options,
        options: c.options,
      };
    }),
  };
}

export interface SettingsInput {
  general?: Partial<General>;
  /** Array order = waterfall order. `keys` (if present) replaces the provider's key list, in order. */
  providers?: { id: string; enabled?: boolean; options?: Options; keys?: KeyInput[] }[];
}

export async function saveSettings(input: SettingsInput): Promise<PublicSettings> {
  const prevGeneral = await getGeneralSettings();
  const prevProviders = Object.fromEntries((await getSetting<SavedProvider[]>('providers', [])).map((s) => [s.id, s]));
  const sql = await db();

  await sql.begin(async (tx) => {
    if (input.general) {
      const g = input.general;
      const stopWhen = (g.stopWhen && g.stopWhen in STOP_RULES ? g.stopWhen : prevGeneral.stopWhen) as StopRule;
      let publicUrl = String(g.publicUrl ?? prevGeneral.publicUrl ?? '').trim().replace(/\/+$/, '');
      if (publicUrl && !/^https:\/\//i.test(publicUrl)) publicUrl = `https://${publicUrl.replace(/^https?:\/\//i, '')}`;
      await tx`
        INSERT INTO settings (key, value) VALUES ('general', ${{ stopWhen, publicUrl } as any}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    }

    if (Array.isArray(input.providers)) {
      const list = input.providers.filter((x) => providerById[x.id]);
      const next: SavedProvider[] = list.map((x) => {
        const prev: Partial<SavedProvider> = prevProviders[x.id] || {};
        const options: Options = {};
        for (const d of providerById[x.id].options) {
          const v = x.options?.[d.key] ?? prev.options?.[d.key] ?? d.default;
          if (d.type === 'boolean') options[d.key] = Boolean(v);
          else if (d.type === 'number') options[d.key] = Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, Number(v) || d.default));
          else options[d.key] = String(v ?? '').trim();
        }
        return { id: x.id, enabled: x.enabled ?? prev.enabled ?? true, options };
      });
      await tx`
        INSERT INTO settings (key, value) VALUES ('providers', ${next as any}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

      for (const x of list) {
        if (Array.isArray(x.keys)) await syncProviderKeys(tx, x.id, providerById[x.id].name, x.keys);
      }
    }
  });
  return publicSettings();
}
