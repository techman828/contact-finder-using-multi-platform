'use client';

import { useEffect, useState } from 'react';
import type { OptionDef, Options, PublicProvider, PublicSettings, StopRule } from '@/lib/types';
import { api, useToast } from './client';
import KeyList, { type DraftKey, draftFromPublic } from './KeyList';

/** Working copy of a provider (keys as editable drafts). */
type Draft = Omit<PublicProvider, 'keys'> & { keys: DraftKey[] };

function OptionField({ def, value, onChange }: { def: OptionDef; value: Options[string]; onChange: (v: Options[string]) => void }) {
  if (def.type === 'boolean') {
    return (
      <>
        <label className="check">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> {def.label}
        </label>
        {def.help && <div className="help">{def.help}</div>}
      </>
    );
  }
  return (
    <label className="field">
      <span className="label">{def.label}</span>
      <input
        type={def.type === 'number' ? 'number' : 'text'}
        value={String(value ?? '')}
        placeholder={def.type === 'text' ? def.placeholder : undefined}
        min={def.type === 'number' ? def.min : undefined}
        max={def.type === 'number' ? def.max : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {def.help && <span className="help">{def.help}</span>}
    </label>
  );
}

export default function SettingsView() {
  const [toast, showToast] = useToast();
  const [data, setData] = useState<PublicSettings | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stopWhen, setStopWhen] = useState<StopRule>('email_and_phone');
  const [publicUrl, setPublicUrl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(s: PublicSettings) {
    setData(s);
    setDrafts(s.providers.map((p) => ({ ...p, options: { ...p.options }, keys: p.keys.map(draftFromPublic) })));
    setStopWhen(s.general.stopWhen);
    setPublicUrl(s.general.publicUrl || '');
    setDirty(false);
  }

  useEffect(() => {
    api<PublicSettings>('/api/settings').then(load).catch((e) => setError(e.message));
  }, []);

  const update = (id: string, patch: Partial<Draft>, silent = false) => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    if (!silent) setDirty(true);
  };

  const move = (i: number, dir: -1 | 1) => {
    setDrafts((ds) => {
      const next = [...ds];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      return next;
    });
    setDirty(true);
  };

  async function save() {
    // A key typed into "Add key" but never added would silently be lost — stop and say so.
    const pending = [...document.querySelectorAll<HTMLInputElement>('[data-pending-key]')].find((el) => el.value.trim());
    if (pending) {
      const name = drafts.find((d) => d.id === pending.dataset.pendingKey)?.name;
      setError(`You typed a ${name} key but didn't click "Add key".`);
      pending.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const s = await api<PublicSettings>('/api/settings', {
        method: 'PUT',
        body: {
          general: { stopWhen, publicUrl },
          providers: drafts.map((d) => ({
            id: d.id,
            enabled: d.enabled,
            options: d.options,
            keys: d.keys.map((k) => (k.id ? { id: k.id, label: k.label, enabled: k.enabled } : { label: k.label, enabled: k.enabled, apiKey: k.apiKey })),
          })),
        },
      });
      load(s);
      showToast('Settings saved');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;

  return (
    <>
      <div className="card">
        <h2>Search order</h2>
        <p className="muted">
          Providers are queried top to bottom — use the arrows to reorder. A provider is only called if it is enabled, has at
          least one enabled API key, and contacts are still missing.
        </p>
        <label className="field inline">
          <span className="label">Stop rule</span>
          <select
            value={stopWhen}
            onChange={(e) => {
              setStopWhen(e.target.value as StopRule);
              setDirty(true);
            }}
          >
            {Object.entries(data.stopRules).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Public app URL (for provider callbacks)</span>
          <input
            type="url"
            value={publicUrl}
            placeholder={data.publicUrl ? `Auto-detected: ${data.publicUrl}` : 'https://your-app.vercel.app'}
            onChange={(e) => {
              setPublicUrl(e.target.value);
              setDirty(true);
            }}
          />
          <span className="help">
            {data.publicUrl
              ? `Callbacks go to ${data.publicUrl}. Leave empty to keep the auto-detected URL.`
              : 'No public URL detected (running locally?) — SignalHire will use sync mode. On Vercel this is detected automatically.'}
          </span>
        </label>
      </div>

      {drafts.map((d, i) => (
        <div key={d.id} className={`card provider ${d.enabled ? '' : 'disabled'}`}>
          <div className="head">
            <div className="order">
              <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">▲</button>
              <button className="icon-btn" disabled={i === drafts.length - 1} onClick={() => move(i, 1)} title="Move down">▼</button>
            </div>
            <div className="pos">{i + 1}</div>
            <div>
              <div className="title">{d.name}</div>
              <div className="links">
                <a href={d.website} target="_blank" rel="noopener noreferrer">website</a> ·{' '}
                <a href={d.docs} target="_blank" rel="noopener noreferrer">API docs</a>
              </div>
            </div>
            <div className="spacer" />
            <label className="switch" title="Enabled">
              <input type="checkbox" checked={d.enabled} onChange={(e) => update(d.id, { enabled: e.target.checked })} />
              <span />
            </label>
          </div>

          <KeyList
            providerId={d.id}
            providerName={d.name}
            keyHelp={d.keyHelp}
            canCheckCredits={d.canCheckCredits}
            keys={d.keys}
            onChange={(keys, opts) => update(d.id, { keys }, opts?.silent)}
          />

          {d.optionDefs.map((def) => (
            <OptionField
              key={def.key}
              def={def}
              value={d.options[def.key]}
              onChange={(v) => update(d.id, { options: { ...d.options, [def.key]: v } })}
            />
          ))}
        </div>
      ))}

      {error && <p className="error">{error}</p>}
      <div className="save-bar">
        <span className="muted">{dirty ? 'Unsaved changes' : ''}</span>
        <button className="btn primary" onClick={() => save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      {toast}
    </>
  );
}
