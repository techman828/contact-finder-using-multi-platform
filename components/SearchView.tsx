'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { profileSlug } from '@/lib/linkedin';
import type { PublicSettings, Search } from '@/lib/types';
import { api, useToast } from './client';
import ResultCard from './ResultCard';

const PAGE = 50;
const POLL_MS = 1500;

export default function SearchView() {
  const [toast, showToast] = useToast();
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [current, setCurrent] = useState<Search | null>(null);
  const [history, setHistory] = useState<{ rows: Search[]; total: number }>({ rows: [], total: 0 });
  const [q, setQ] = useState('');
  const qRef = useRef(q);
  qRef.current = q;

  const providerName = useCallback(
    (id: string) => settings?.providers.find((p) => p.id === id)?.name || id,
    [settings]
  );

  const rowCount = useRef(0);
  useEffect(() => {
    rowCount.current = history.rows.length;
  }, [history.rows.length]);

  const loadHistory = useCallback(async (append = false) => {
    const offset = append ? rowCount.current : 0;
    try {
      const d = await api<{ rows: Search[]; total: number }>(
        `/api/searches?limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(qRef.current.trim())}`
      );
      setHistory((prev) => ({ rows: append ? prev.rows.concat(d.rows) : d.rows, total: d.total }));
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    api<PublicSettings>('/api/settings').then(setSettings).catch((e) => setError(e.message));
  }, []);

  // Debounced history filter.
  useEffect(() => {
    const t = setTimeout(() => loadHistory(), 250);
    return () => clearTimeout(t);
  }, [q, loadHistory]);

  // Poll the open search until it finishes.
  useEffect(() => {
    if (currentId == null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api<Search>(`/api/searches/${currentId}`);
        if (stop) return;
        setCurrent(s);
        if (s.status === 'running') timer = setTimeout(tick, POLL_MS);
        else loadHistory();
      } catch (e: any) {
        if (!stop) setError(e.message);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [currentId, loadHistory]);

  async function start(target: string) {
    if (!target.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const { id } = await api<{ id: number }>('/api/searches', { method: 'POST', body: { url: target } });
      setUrl('');
      setCurrent(null);
      setCurrentId(id);
      loadHistory();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(v: string) {
    await navigator.clipboard?.writeText(v).catch(() => {});
    showToast('Copied');
  }

  async function remove(id: number) {
    await api(`/api/searches/${id}`, { method: 'DELETE' });
    if (id === currentId) {
      setCurrentId(null);
      setCurrent(null);
    }
    loadHistory();
  }

  async function clearAll() {
    if (!confirm('Delete all search history? This cannot be undone.')) return;
    await api('/api/searches', { method: 'DELETE' });
    setCurrentId(null);
    setCurrent(null);
    loadHistory();
  }

  const ready = settings?.providers.some((p) => p.enabled && p.keys.some((k) => k.enabled));
  const contacts = (arr: { value: string }[]) =>
    arr.length ? arr.map((c) => <div key={c.value}>{c.value}</div>) : <span className="muted">—</span>;

  return (
    <>
      <form
        className="search-box"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          start(url);
        }}
      >
        <input
          type="text"
          inputMode="url"
          placeholder="Paste LinkedIn profile URL — e.g. linkedin.com/in/username"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          autoFocus
        />
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Starting…' : 'Find contacts'}
        </button>
      </form>

      {settings && !ready && (
        <p className="hint">
          No provider configured yet. <Link href="/settings">Add an API key in Settings</Link>.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {current && current.id === currentId && (
        <ResultCard search={current} providerName={providerName} onCopy={copy} onRerun={start} />
      )}

      <div className="history-head">
        <h2>
          History {history.total > 0 && <span className="muted">({history.total})</span>}
        </h2>
        <div className="history-tools">
          <input type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <a className="btn ghost" href="/api/searches/export" download>Export CSV</a>
          <button className="btn ghost danger" onClick={clearAll}>Clear</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="history">
          <thead>
            <tr><th>Profile</th><th>Emails</th><th>Phones</th><th>Date</th><th /></tr>
          </thead>
          <tbody>
            {history.rows.map((r) => {
              const slug = profileSlug(r.linkedin_url);
              const failed = r.status === 'error' && !r.emails.length && !r.phones.length;
              return (
                <tr
                  key={r.id}
                  className={r.id === currentId ? 'selected' : ''}
                  onClick={() => {
                    setCurrentId(r.id);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  <td>
                    <div className="who">
                      {r.full_name || slug}{' '}
                      {r.status === 'running' && <span className="chip">searching…</span>}
                      {failed && <span className="chip err">error</span>}
                    </div>
                    <div className="slug">{slug}</div>
                  </td>
                  <td className="list">{contacts(r.emails)}</td>
                  <td className="list">{contacts(r.phones)}</td>
                  <td className="date">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="actions">
                    <button
                      className="icon-btn"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(r.id);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {history.rows.length === 0 && <p className="muted center">{q.trim() ? 'No matches.' : 'No searches yet.'}</p>}
      {history.rows.length < history.total && (
        <button className="btn ghost center-block" onClick={() => loadHistory(true)}>Load more</button>
      )}
      {toast}
    </>
  );
}
