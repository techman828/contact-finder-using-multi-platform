'use client';

import { profileSlug } from '@/lib/linkedin';
import type { MergedContact, Search, StepStatus } from '@/lib/types';

const STEP_LABEL: Record<StepStatus, string> = {
  pending: 'waiting',
  running: 'searching…',
  waiting: 'waiting for callback…',
  found: 'found',
  not_found: 'no data',
  error: 'error',
  timeout: 'timeout',
  skipped: 'skipped',
};

function ContactRow({ c, kind, onCopy }: { c: MergedContact; kind: 'email' | 'phone'; onCopy: (v: string) => void }) {
  const href = kind === 'email' ? `mailto:${c.value}` : `tel:${c.value.replace(/[^\d+]/g, '')}`;
  return (
    <div className="contact">
      <div className="meta">
        <a className="value" href={href}>{c.value}</a>
        {c.type && <span className="chip">{c.type}</span>}
        {c.verified && <span className="chip ok">verified</span>}
        {c.sources.map((s) => <span key={s} className="chip">{s}</span>)}
      </div>
      <button className="btn small ghost" onClick={() => onCopy(c.value)}>Copy</button>
    </div>
  );
}

export default function ResultCard({
  search: s,
  providerName,
  onCopy,
  onRerun,
}: {
  search: Search;
  providerName: (id: string) => string;
  onCopy: (v: string) => void;
  onRerun: (url: string) => void;
}) {
  const running = s.status === 'running';
  const steps = s.providers || [];
  const list = (items: MergedContact[], kind: 'email' | 'phone') =>
    items.length ? (
      items.map((c) => <ContactRow key={c.value} c={c} kind={kind} onCopy={onCopy} />)
    ) : (
      <div className="none">{running ? 'Searching…' : 'Not found'}</div>
    );
  const msgs = steps.filter((p) => p.message && p.status !== 'skipped');

  return (
    <article className="card" aria-live="polite">
      <div className="person">
        <div>
          <div className="person-name">{s.full_name || profileSlug(s.linkedin_url)}</div>
          {s.headline && <div className="person-sub">{s.headline}</div>}
          <a href={s.linkedin_url} target="_blank" rel="noopener noreferrer">{s.linkedin_url}</a>
        </div>
        {!running && (
          <button className="btn small" onClick={() => onRerun(s.linkedin_url)} title="Search this profile again">
            Search again
          </button>
        )}
      </div>

      <div className="contacts">
        <div><h3>Emails</h3>{list(s.emails, 'email')}</div>
        <div><h3>Phones</h3>{list(s.phones, 'phone')}</div>
      </div>

      <div className="steps">
        {steps.map((p) => (
          <span key={p.provider} className={`step ${p.status}`} title={p.message || ''}>
            {(p.status === 'running' || p.status === 'waiting') && <span className="spinner" />}
            <b>{providerName(p.provider)}</b> {STEP_LABEL[p.status] || p.status}
            {p.status === 'found' && ` · ${p.emails.length}✉ ${p.phones.length}☎`}
            {p.duration_ms != null && ` · ${(p.duration_ms / 1000).toFixed(1)}s`}
            {p.api_key_label && ` · ${p.api_key_label}`}
            {p.credits_left != null && ` · ${p.credits_left} cr left`}
            {['found', 'not_found', 'error', 'timeout', 'waiting'].includes(p.status) && (
              <a className="raw" href={`/api/searches/${s.id}/raw/${p.provider}`} target="_blank" title="Raw API response">raw</a>
            )}
          </span>
        ))}
      </div>
      {msgs.length > 0 && (
        <ul className="step-msgs">
          {msgs.map((p) => (
            <li key={p.provider}><b>{providerName(p.provider)}:</b> {p.message}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
