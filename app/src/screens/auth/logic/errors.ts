/**
 * How the auth pages word a refusal. Pure: no React, no React Native.
 */

/**
 * The server's message only, else `fallback` — VerifyEmail.jsx reads
 * `err.response.data.error.message || 'Verification failed'` and never shows
 * a transport error's text ("Network Error") in its place.
 */
export const serverMessage = (err: unknown, fallback: string): string => {
  const e = err as { response?: { data?: { error?: { message?: unknown } } } } | null | undefined;
  const server = e?.response?.data?.error?.message;
  return typeof server === 'string' && server.trim() ? server : fallback;
};
