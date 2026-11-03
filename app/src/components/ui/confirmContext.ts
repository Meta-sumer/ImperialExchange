import { createContext, useContext } from 'react';

/**
 * The confirm context on its own, so Portal can carry it into the overlay
 * layer without importing ConfirmProvider (which renders a Modal, which
 * renders a Portal — a cycle).
 */

export interface ConfirmOptions {
  message?: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export type ConfirmFn = (opts?: string | ConfirmOptions) => Promise<boolean>;

// Outside a provider the web resolves false — "not confirmed" is the safe
// answer for a question nobody could see.
export const ConfirmCtx = createContext<ConfirmFn>(() => Promise.resolve(false));

export const useConfirm = (): ConfirmFn => useContext(ConfirmCtx);
