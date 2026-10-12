import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../services/api';

const SEL_KEY = 'selectedAccountId';
const isDemo = (t) => ['DEMO', 'VIRTUAL'].includes(String(t || '').toUpperCase());

/**
 * The user's trading accounts + which one is "active" (used by the order
 * ticket, positions, wallet). Mirrors the web header account switcher.
 */
export const useAccounts = create((set, get) => ({
  accounts: [],
  selectedId: null,
  loading: true,

  load: async () => {
    try {
      const { data } = await api.get('/user/accounts');
      const accounts = data?.data || [];
      let selectedId = get().selectedId || (await AsyncStorage.getItem(SEL_KEY));
      // Fall back to the first REAL account, else the first account.
      if (!selectedId || !accounts.some((a) => a._id === selectedId)) {
        const real = accounts.find((a) => !isDemo(a.accountType));
        selectedId = (real || accounts[0])?._id || null;
      }
      set({ accounts, selectedId, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  select: async (id) => {
    set({ selectedId: id });
    try { await AsyncStorage.setItem(SEL_KEY, id); } catch {}
  },

  selected: () => get().accounts.find((a) => a._id === get().selectedId) || null,
}));
