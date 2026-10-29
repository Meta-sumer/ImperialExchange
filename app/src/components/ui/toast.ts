import { createStore } from 'zustand/vanilla';

/**
 * Toasts — the react-hot-toast API the web calls 330 times, kept call-for-
 * call so a ported screen changes its import line and nothing else:
 *
 *   toast.success('Order placed');
 *   toast.error(errorMessage(err));
 *   toast.error(msg, { duration: 5000 });
 *   toast('Enter your 2FA code', { icon: '🔐' });
 *   const id = toast.loading('Saving…'); … toast.success('Saved', { id });
 *   toast.dismiss(id);
 *
 * plus `orderToast` from client/src/utils/toast.jsx — a success toast with
 * its own × so a trader can clear an order confirmation before the timer.
 *
 * Durations are react-hot-toast's own defaults, which the web never
 * overrides globally: blank 4s, error 4s, success 2s, loading until
 * replaced or dismissed. The web's `toastOptions` styling lives in
 * ToastHost.
 *
 * This file is the state. ToastHost renders it.
 */

export type ToastType = 'success' | 'error' | 'loading' | 'blank';

export interface ToastOptions {
  /** Reusing an id replaces that toast in place — loading → success. */
  id?: string;
  duration?: number;
  /** An emoji or short glyph shown instead of the type icon. */
  icon?: string;
  /** Render a × button (orderToast). */
  dismissButton?: boolean;
}

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  icon: string | null;
  duration: number;
  dismissButton: boolean;
  createdAt: number;
}

/** react-hot-toast's defaults (core/store.ts `defaultTimeouts`). */
export const DEFAULT_DURATION: Record<ToastType, number> = {
  blank: 4000,
  error: 4000,
  success: 2000,
  loading: Infinity,
};

/** react-hot-toast's TOAST_LIMIT. */
export const TOAST_LIMIT = 20;

/* ── Pure list operations (exported for tests) ─────────────────────── */

/** Newest first; an existing id is replaced where it stands. */
export const upsertToast = (list: ToastItem[], item: ToastItem): ToastItem[] => {
  const at = list.findIndex((t) => t.id === item.id);
  if (at >= 0) {
    const next = list.slice();
    next[at] = item;
    return next;
  }
  return [item, ...list].slice(0, TOAST_LIMIT);
};

/** Remove one toast, or all of them when `id` is undefined. */
export const removeToast = (list: ToastItem[], id?: string): ToastItem[] =>
  (id === undefined ? [] : list.filter((t) => t.id !== id));

/* ── Store + timers ─────────────────────────────────────────────────── */

export const toastStore = createStore<{ toasts: ToastItem[] }>()(() => ({ toasts: [] }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let counter = 0;
const genId = (): string => {
  counter += 1;
  return `t${counter}`;
};

const clearTimer = (id: string): void => {
  const h = timers.get(id);
  if (h) clearTimeout(h);
  timers.delete(id);
};

const dismiss = (id?: string): void => {
  if (id === undefined) {
    for (const h of timers.values()) clearTimeout(h);
    timers.clear();
  } else {
    clearTimer(id);
  }
  toastStore.setState((s) => ({ toasts: removeToast(s.toasts, id) }));
};

const show = (type: ToastType, message: string, opts: ToastOptions = {}): string => {
  const id = opts.id ?? genId();
  const duration = opts.duration ?? DEFAULT_DURATION[type];
  const item: ToastItem = {
    id,
    type,
    message: String(message ?? ''),
    icon: opts.icon ?? null,
    duration,
    dismissButton: !!opts.dismissButton,
    createdAt: Date.now(),
  };
  clearTimer(id);
  toastStore.setState((s) => ({ toasts: upsertToast(s.toasts, item) }));
  if (Number.isFinite(duration)) {
    timers.set(id, setTimeout(() => dismiss(id), duration));
  }
  return id;
};

type ToastFn = ((message: string, opts?: ToastOptions) => string) & {
  success: (message: string, opts?: ToastOptions) => string;
  error: (message: string, opts?: ToastOptions) => string;
  loading: (message: string, opts?: ToastOptions) => string;
  /** No id dismisses every toast, as in react-hot-toast. */
  dismiss: (id?: string) => void;
};

export const toast: ToastFn = Object.assign(
  (message: string, opts?: ToastOptions) => show('blank', message, opts),
  {
    success: (message: string, opts?: ToastOptions) => show('success', message, opts),
    error: (message: string, opts?: ToastOptions) => show('error', message, opts),
    loading: (message: string, opts?: ToastOptions) => show('loading', message, opts),
    dismiss,
  },
);

/**
 * client/src/utils/toast.jsx `orderToast` — success, 4s, with a × so the
 * trader can clear it early. Used for order placed / filled confirmations.
 */
export const orderToast = (message: string, opts: ToastOptions = {}): string =>
  show('success', message, { duration: 4000, ...opts, dismissButton: true });
