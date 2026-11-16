'use client';

import { useState } from 'react';
import type { PublicKey } from '@/lib/types';
import { api } from './client';

/** A key as edited in the form. Saved keys have an `id`; new ones carry the raw `apiKey` until saved. */
export interface DraftKey extends Partial<Omit<PublicKey, 'id' | 'label' | 'enabled'>> {
  uid: string;
  id?: number;
  label: string;
  enabled: boolean;
  apiKey?: string;
  check?: { ok: boolean; text: string };
}

export const draftFromPublic = (k: PublicKey): DraftKey => ({ ...k, uid: `k${k.id}` });

const ERROR_TEXT: Record<string, string> = {
  NO_CREDITS: 'out of credits',
  INVALID_API_KEY: 'invalid key',
  ACCOUNT_DISABLED: 'account disabled',
  RATE_LIMITED: 'rate limited',
};

function ago(iso: string | null | undefined) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const maskRaw = (k: string) => (k.length > 8 ? `••••${k.slice(-4)}` : '••••');

function KeyStatus({ k }: { k: DraftKey }) {
  if (k.check) return <span className={`help ${k.check.ok ? 'ok-text' : 'err-text'}`}>{k.check.text}</span>;
  if (!k.id) return <span className="chip">new · unsaved</span>;
  const parts: React.ReactNode[] = [];
  if (k.lastErrorCode) {
    parts.push(
      <span key="e" className="chip err" title={`Last error ${ago(k.lastErrorAt)}`}>
        {ERROR_TEXT[k.lastErrorCode] || k.lastErrorCode}
      </span>
    );
  }
  if (k.credits != null && !(k.credits === 0 && k.lastErrorCode === 'NO_CREDITS')) {
    parts.push(
      <span key="c" className={`chip ${k.credits > 0 ? 'ok' : 'err'}`} title={k.creditsCheckedAt ? `Checked ${ago(k.creditsCheckedAt)}` : ''}>
        {k.credits.toLocaleString()} credits
      </span>
    );
  }
  if (k.lastUsedAt) parts.push(<span key="u" className="help">used {ago(k.lastUsedAt)}</span>);
  return parts.length ? <>{parts}</> : <span className="help">not checked yet</span>;
}

export default function KeyList({
  providerId,
  providerName,
  keyHelp,
  canCheckCredits,
  keys,
  onChange,
}: {
  providerId: string;
  providerName: string;
  keyHelp: string;
  canCheckCredits: boolean;
  keys: DraftKey[];
  onChange: (keys: DraftKey[], opts?: { silent?: boolean }) => void;
}) {
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const patch = (uid: string, p: Partial<DraftKey>, silent = false) =>
    onChange(keys.map((k) => (k.uid === uid ? { ...k, ...p } : k)), { silent });

  const move = (i: number, dir: -1 | 1) => {
    const next = [...keys];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  };

  function add() {
    // Several keys can be pasted at once (one per line, or comma separated).
    const values = newKey.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
    if (!values.length) return;
    const known = new Set(keys.filter((k) => k.apiKey).map((k) => k.apiKey));
    const dup = values.find((v, i) => known.has(v) || values.indexOf(v) !== i);
    if (dup) {
      setAddError(`${maskRaw(dup)} is already in the list`);
      return;
    }
    const base = keys.length;
    const added = values.map((v, i) => ({
      uid: `new-${Date.now()}-${i}`,
      label: newLabel.trim() ? (values.length > 1 ? `${newLabel.trim()} ${i + 1}` : newLabel.trim()) : `Key ${base + i + 1}`,
      enabled: true,
      apiKey: v,
    }));
    onChange([...keys, ...added]);
    setNewKey('');
    setNewLabel('');
    setAddError(null);
  }

  async function check(k: DraftKey) {
    patch(k.uid, { check: { ok: true, text: 'Checking…' } }, true);
    try {
      const r = k.id
        ? await api<{ credits: number | null; plan?: string; key: PublicKey }>(`/api/keys/${k.id}/credits`, { method: 'POST' })
        : await api<{ credits: number | null; plan?: string }>(`/api/providers/${providerId}/credits`, { method: 'POST', body: { apiKey: k.apiKey } });
      const fresh = 'key' in r && r.key ? { ...r.key } : {};
      patch(k.uid, { ...fresh, check: { ok: true, text: `✓ ${r.credits ?? '?'} credits${r.plan ? ` (${r.plan})` : ''}` } }, true);
    } catch (e: any) {
      patch(k.uid, { check: { ok: false, text: `✕ ${e.message}` } }, true);
    }
  }

  const checkAll = () => keys.filter((k) => k.enabled).forEach(check);
  const active = keys.filter((k) => k.enabled).length;

  return (
    <div className="keys">
      <div className="keys-head">
        <span className="label">
          API keys <span className="muted">({active} active{keys.length !== active ? ` of ${keys.length}` : ''})</span>
        </span>
        {canCheckCredits && keys.length > 1 && (
          <button className="btn small ghost" onClick={checkAll}>Check all</button>
        )}
      </div>

      {keys.length > 0 && (
        <ul className="key-list">
          {keys.map((k, i) => (
            <li key={k.uid} className={`key-item ${k.enabled ? '' : 'disabled'}`}>
              <div className="order">
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Try earlier">▲</button>
                <button className="icon-btn" disabled={i === keys.length - 1} onClick={() => move(i, 1)} title="Try later">▼</button>
              </div>
              <span className="key-pos">{i + 1}</span>
              <input
                type="text"
                className="key-label"
                value={k.label}
                maxLength={60}
                placeholder={`Key ${i + 1}`}
                onChange={(e) => patch(k.uid, { label: e.target.value })}
                aria-label="Key label"
              />
              <code className="key-preview">{k.id ? k.preview : maskRaw(k.apiKey || '')}</code>
              <span className="key-status"><KeyStatus k={k} /></span>
              <span className="key-actions">
                {canCheckCredits && <button className="btn small" onClick={() => check(k)}>Check</button>}
                <label className="switch" title={k.enabled ? 'Enabled' : 'Disabled'}>
                  <input type="checkbox" checked={k.enabled} onChange={(e) => patch(k.uid, { enabled: e.target.checked })} />
                  <span />
                </label>
                <button
                  className="icon-btn"
                  title="Remove key"
                  onClick={() => {
                    if (!k.id || confirm(`Remove "${k.label}" (${k.preview}) from ${providerName}? It is deleted when you save.`)) {
                      onChange(keys.filter((x) => x.uid !== k.uid));
                    }
                  }}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="key-add">
        <input
          type="text"
          className="key-label"
          placeholder="Label (optional)"
          value={newLabel}
          maxLength={60}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={`Paste API key — ${keyHelp}`}
          value={newKey}
          onChange={(e) => {
            setNewKey(e.target.value);
            setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          data-pending-key={providerId}
        />
        <button className="btn" onClick={add} disabled={!newKey.trim()}>Add key</button>
      </div>
      {addError ? (
        <span className="help err-text">{addError}</span>
      ) : (
        <span className="help">
          Keys are tried top to bottom. If a key is out of credits, invalid or rate-limited, the next key is used automatically.
          You can paste several keys at once (one per line or comma-separated).
        </span>
      )}
    </div>
  );
}
