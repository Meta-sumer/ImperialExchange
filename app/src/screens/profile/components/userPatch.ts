import { useAuthStore } from '@/store/auth';
import { withSavedFields } from '@/utils/profile';

/**
 * Lay fields the server has just confirmed written over the signed-in user,
 * before the page's /auth/me re-read — so a re-read that fails (it is silent
 * on failure) cannot leave the page on the state from before the change.
 * See withSavedFields.
 *
 * Only for the same person: an answer that lands after a sign-out or a
 * "View As User" switch is dropped.
 */
export const applyToSignedInUser = (userId: string, fields: Readonly<Record<string, unknown>>): void => {
  const { user, setUser } = useAuthStore.getState();
  if (!user || user.id !== userId) return;
  setUser(withSavedFields(user, fields));
};
