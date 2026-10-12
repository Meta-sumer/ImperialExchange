import { create } from 'zustand';
import { api, tokens, setSessionLostHandler } from '../services/api';
import { wsClient } from '../services/ws';

// The client app is the CUSTOMER portal — only the USER role may sign in here
// (staff use the admin portal). Mirrors the web client's gate.
const CLIENT_ROLE = 'USER';

export const useAuth = create((set, get) => ({
  user: null,
  loading: true, // true until the initial session check resolves

  // Restore a session from stored tokens on app launch.
  init: async () => {
    const token = await tokens.getAccess();
    if (!token) { set({ loading: false }); return; }
    try {
      const { data } = await api.get('/auth/me');
      if (data.data?.role !== CLIENT_ROLE) {
        await tokens.clear();
        set({ user: null, loading: false });
        return;
      }
      set({ user: data.data, loading: false });
      wsClient.connect();
    } catch (e) {
      await tokens.clear();
      set({ user: null, loading: false });
    }
  },

  login: async (email, password, twoFactorCode) => {
    const { data } = await api.post('/auth/login', { email, password, twoFactorCode });
    if (data.data.user?.role !== CLIENT_ROLE) {
      throw new Error('This is a staff account. Please sign in from the admin portal.');
    }
    await tokens.set(data.data.accessToken, data.data.refreshToken);
    set({ user: data.data.user });
    wsClient.connect();
    return data.data.user;
  },

  logout: async () => {
    try {
      const refreshToken = await tokens.getRefresh();
      await api.post('/auth/logout', { refreshToken });
    } catch {}
    wsClient.disconnect();
    await tokens.clear();
    set({ user: null });
  },
}));

// When a refresh fails irrecoverably, drop the user back to the login screen.
setSessionLostHandler(() => useAuth.setState({ user: null }));
