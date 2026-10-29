import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ConfirmDialog } from './ConfirmDialog';

/**
 * App-wide confirmation dialog, ported from client/src/components/ConfirmProvider.jsx —
 * a promise-based replacement for window.confirm():
 *
 *   const confirm = useConfirm();
 *   if (await confirm('Close all positions?')) { … }
 *
 * Resolves true on Confirm, false on Cancel / backdrop / back button —
 * exactly like the native popup. Pass a string to keep the web's message
 * verbatim, or an options object for a custom title/labels.
 *
 * One deliberate addition: it renders at Z.critical rather than Z.modal, so
 * a confirm raised from INSIDE an open modal (delete a watchlist from the
 * manager) sits above that modal instead of level with it.
 */

export interface ConfirmOptions {
  message?: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export type ConfirmFn = (opts?: string | ConfirmOptions) => Promise<boolean>;

interface ConfirmState {
  message: string;
  title: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
}

/** Defaults, verbatim from ConfirmProvider.jsx:25-31. Exported for tests. */
export const normaliseConfirm = (opts?: string | ConfirmOptions): ConfirmState => {
  const o: ConfirmOptions = typeof opts === 'string' ? { message: opts } : (opts ?? {});
  return {
    message: o.message || 'Are you sure?',
    title: o.title || 'Please confirm',
    confirmText: o.confirmText || 'Confirm',
    cancelText: o.cancelText || 'Cancel',
    danger: !!o.danger,
  };
};

// Outside a provider the web resolves false — "not confirmed" is the safe
// answer for a question nobody could see.
const ConfirmCtx = createContext<ConfirmFn>(() => Promise.resolve(false));

export const useConfirm = (): ConfirmFn => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<ConfirmState | null>(null);
  // Kept while the dialog animates out, so the text does not blank mid-fade.
  const [last, setLast] = useState<ConfirmState | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    // A second confirm while one is open settles the first as "no" rather
    // than orphaning its promise — the web would leave it hanging forever.
    resolverRef.current?.(false);
    const next = normaliseConfirm(opts);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setState(next);
      setLast(next);
    });
  }, []);

  const settle = (val: boolean): void => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setState(null);
    r?.(val);
  };

  const shown = state ?? last;

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={!!state}
        title={shown?.title}
        message={shown?.message}
        confirmText={shown?.confirmText}
        cancelText={shown?.cancelText}
        danger={shown?.danger}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmCtx.Provider>
  );
}
