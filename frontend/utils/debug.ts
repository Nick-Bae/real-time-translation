// frontend/utils/debug.ts
export const DEBUG =
  (typeof window !== 'undefined' && localStorage.getItem('rt_debug') === '1') ||
  process.env.NEXT_PUBLIC_DEBUG === '1';

export const tms = () =>
  typeof performance !== 'undefined' && performance.now
    ? `${performance.now().toFixed(0)}ms`
    : `${Date.now()}`;

export function d(tag: string, msg: string, data?: any) {
  if (!DEBUG) return;
  // green tag
  console.log(`%c[RT][${tms()}][${tag}] ${msg}`, 'color:#22c55e;font-weight:600', data ?? '');
}

export function g(tag: string, title: string, data?: any) {
  if (!DEBUG) return;
  console.groupCollapsed(`%c[RT][${tms()}][${tag}] ${title}`, 'color:#60a5fa');
  if (data !== undefined) console.log(data);
  console.groupEnd();
}

export const pv = (s = '', n = 80) =>
  s.length > n ? s.slice(0, n) + '…' : s;
