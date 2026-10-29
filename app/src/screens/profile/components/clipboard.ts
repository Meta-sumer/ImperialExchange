import * as Clipboard from 'expo-clipboard';

import { toast } from '@/components/ui';

/**
 * `navigator.clipboard.writeText(text); toast.success(message)` — the web's
 * copy buttons (User ID, referral code).
 *
 * The web toasts without waiting for the write; here the toast follows the
 * write, and a failed write says so instead of claiming a copy.
 */
export const copyText = async (text: string, message: string): Promise<void> => {
  try {
    await Clipboard.setStringAsync(text);
    toast.success(message);
  } catch {
    toast.error('Could not copy to the clipboard');
  }
};
