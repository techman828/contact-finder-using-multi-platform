import { NextResponse } from 'next/server';

/** Wrap a route handler: turns thrown errors into JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      if (status >= 500) console.error(err);
      return NextResponse.json({ error: err?.message || 'Server error' }, { status });
    }
  };
}

export const intParam = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('Invalid id'), { status: 400 });
  return n;
};
