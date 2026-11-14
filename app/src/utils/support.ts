import { Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { toast } from '@/components/ui';

/** The support mailbox — the web's client/src/utils/support.js. */
export const SUPPORT_EMAIL = 'support@imperialexchange.in';
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

/** Copies the support address and says so. */
export async function copySupportEmail(): Promise<void> {
  try {
    await Clipboard.setStringAsync(SUPPORT_EMAIL);
    toast.success(`Email copied: ${SUPPORT_EMAIL}`);
  } catch {
    toast(`Write to ${SUPPORT_EMAIL}`);
  }
}

/** Opens the mail app on the support address; with no mail app, copies it instead. */
export async function openSupportMail(): Promise<void> {
  try {
    await Linking.openURL(SUPPORT_MAILTO);
  } catch {
    await copySupportEmail();
  }
}
