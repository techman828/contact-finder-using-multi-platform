import { handle } from '@/lib/route';
import { allSearches } from '@/lib/searches';

const esc = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
  return `"${s.replace(/"/g, '""')}"`;
};

/** Whole history as CSV (streamed). */
export const GET = handle(async () => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode('﻿Date,LinkedIn URL,Name,Headline,Status,Emails,Phones\r\n'));
      for await (const rows of allSearches()) {
        const chunk = rows
          .map((r) =>
            [
              new Date(r.created_at).toISOString(),
              r.linkedin_url,
              r.full_name,
              r.headline,
              r.status,
              r.emails.map((e) => e.value).join('; '),
              r.phones.map((p) => p.value).join('; '),
            ]
              .map(esc)
              .join(',')
          )
          .join('\r\n');
        controller.enqueue(enc.encode(chunk + '\r\n'));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contact-search-history-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});
