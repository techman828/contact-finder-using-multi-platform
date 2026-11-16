export type ContactType = string | null;

export interface Contact {
  value: string;
  type: ContactType;
  verified: boolean;
  confidence?: number | null;
}

export interface MergedContact {
  value: string;
  type: ContactType;
  verified: boolean;
  sources: string[];
}

export interface Person {
  fullName: string | null;
  headline: string | null;
  company?: string | null;
  location?: string | null;
}

/** What a provider returns once it has an answer. */
export interface ProviderResult {
  found: boolean;
  person?: Person | null;
  emails: Contact[];
  phones: Contact[];
  creditsLeft?: number | null;
  message?: string | null;
  raw?: unknown;
}

/** What a webhook-based provider returns when the answer will arrive later via callback. */
export interface ProviderWaiting {
  waiting: true;
  message?: string | null;
  creditsLeft?: number | null;
  raw?: unknown;
  /**
   * The provider's own id for the pending request. Required for providers with `sharedWebhook`:
   * deliveries to the shared webhook URL are matched to the step by it.
   */
  requestId?: string | null;
}

/** Passed to parseCallback, so multi-stage providers can send a follow-up request. */
export interface CallbackContext {
  linkedinUrl: string;
  apiKey: string;
  options: Options;
  need: { email: boolean; phone: boolean };
  /** `raw` saved with the waiting step: lets a provider carry data from one stage to the next. */
  previous: unknown;
  /** True when the step is no longer waiting (timed out, or still finishing its request): must return a final result. */
  final: boolean;
}

export type OptionDef =
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string }
  | { key: string; label: string; type: 'text'; default: string; placeholder?: string; help?: string }
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number; help?: string };

export type Options = Record<string, string | number | boolean>;

export interface LookupInput {
  linkedinUrl: string;
  apiKey: string;
  options: Options;
  /** What is still missing after earlier providers ran — lets a provider avoid paying for data we already have. */
  need: { email: boolean; phone: boolean };
  /** Public URL the provider may POST its result to (only for providers that implement parseCallback). */
  callbackUrl: string | null;
}

export interface CreditsInfo {
  credits: number | null;
  plan?: string | null;
}

export interface Provider {
  id: string;
  name: string;
  website: string;
  docs: string;
  keyHelp: string;
  options: OptionDef[];
  lookup(input: LookupInput): Promise<ProviderResult | ProviderWaiting>;
  /** Max seconds to wait for a callback before moving on. */
  callbackTimeoutSec?(options: Options): number;
  /**
   * Turn a webhook payload into a result, or return ProviderWaiting to keep waiting for another
   * delivery (e.g. after sending a follow-up request; the wait time restarts).
   */
  parseCallback?(body: unknown, ctx: CallbackContext): ProviderResult | ProviderWaiting | Promise<ProviderResult | ProviderWaiting>;
  /**
   * For APIs whose webhook URL is set once in their dashboard instead of passed with each request.
   * Served at /api/webhooks/<id>. Deliveries are matched to steps by `ProviderWaiting.requestId`.
   */
  sharedWebhook?: {
    requestId(body: unknown): string | null;
    /** Return false to reject a delivery (HTTP 401). */
    verify?(body: unknown, options: Options): boolean;
    /** Setup instructions shown in Settings next to the URL. */
    help: string;
  };
  credits?(apiKey: string): Promise<CreditsInfo>;
}

export type SearchStatus = 'running' | 'done' | 'not_found' | 'error';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'found' | 'not_found' | 'error' | 'timeout' | 'skipped';
export type StopRule = 'email_and_phone' | 'email' | 'never';

export interface ProviderStep {
  provider: string;
  position: number;
  status: StepStatus;
  message: string | null;
  emails: Contact[];
  phones: Contact[];
  person: Person | null;
  credits_left: number | null;
  duration_ms: number | null;
  api_key_label: string | null;
}

export interface Search {
  id: number;
  linkedin_url: string;
  status: SearchStatus;
  full_name: string | null;
  headline: string | null;
  emails: MergedContact[];
  phones: MergedContact[];
  created_at: string;
  finished_at: string | null;
  providers?: ProviderStep[];
}

export interface PublicKey {
  id: number;
  label: string;
  /** Masked (••••last4) — the full key never leaves the server. */
  preview: string;
  enabled: boolean;
  credits: number | null;
  creditsCheckedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  lastUsedAt: string | null;
}

export interface PublicProvider {
  id: string;
  name: string;
  website: string;
  docs: string;
  keyHelp: string;
  enabled: boolean;
  keys: PublicKey[];
  canCheckCredits: boolean;
  /** For providers with a dashboard-configured webhook: the URL to paste there (null without a public URL). */
  webhook: { url: string | null; help: string } | null;
  optionDefs: OptionDef[];
  options: Options;
}

export interface PublicSettings {
  general: { stopWhen: StopRule; publicUrl: string };
  stopRules: Record<StopRule, string>;
  publicUrl: string | null;
  providers: PublicProvider[];
}
