import toast from 'react-hot-toast';

// The one support address shown to clients (wallet "Need help?", the wallet
// sidebar's Contact Support, the footer's Contact Support).
export const SUPPORT_EMAIL = 'support@imperialexchange.in';
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

// A mailto link opens the device's mail app, and silently does nothing on a
// computer with none set up (common on Windows). Copy the address as well and
// say so, so a click always gives the user something.
export function copyEmail(address = SUPPORT_EMAIL) {
  try { navigator.clipboard?.writeText(address); } catch (_) { /* no clipboard */ }
  toast.success(`Email copied: ${address}`);
}
