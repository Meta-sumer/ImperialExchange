import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The referral code from a partner link (`/register?ref=ABC12345`),
 * remembered until sign-up succeeds — Register.jsx:13-22.
 *
 * The web keeps it in localStorage so a visitor who follows the link, wanders
 * off and comes back to sign up later is still credited to the partner. Same
 * key here, in AsyncStorage: a referral code is not a secret (it is printed in
 * the link), so it does not belong in the keychain.
 *
 * Every access is best-effort, as on the web (`try { … } catch (_) {}`): a
 * storage failure costs the partner a credit, never the user a sign-up.
 */
export const PENDING_REF_KEY = 'tradepro:pending-ref';

/** Register.jsx: `(params.get('ref') || '').trim().toUpperCase()`. */
export const normaliseRef = (raw: string | null | undefined): string => (raw ?? '').trim().toUpperCase();

export const loadPendingRef = async (): Promise<string> => {
  try {
    return (await AsyncStorage.getItem(PENDING_REF_KEY)) || '';
  } catch {
    return '';
  }
};

export const savePendingRef = async (code: string): Promise<void> => {
  if (!code) return;
  try { await AsyncStorage.setItem(PENDING_REF_KEY, code); } catch { /* best-effort */ }
};

export const clearPendingRef = async (): Promise<void> => {
  try { await AsyncStorage.removeItem(PENDING_REF_KEY); } catch { /* best-effort */ }
};
