import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config';

const ACCESS = 'accessToken';
const REFRESH = 'refreshToken';

// Token helpers (AsyncStorage is the mobile equivalent of the web localStorage).
export const tokens = {
  get: (k) => AsyncStorage.getItem(k),
  getAccess: () => AsyncStorage.getItem(ACCESS),
  getRefresh: () => AsyncStorage.getItem(REFRESH),
  set: async (access, refresh) => {
    if (access != null) await AsyncStorage.setItem(ACCESS, access);
    if (refresh != null) await AsyncStorage.setItem(REFRESH, refresh);
  },
  clear: () => AsyncStorage.multiRemove([ACCESS, REFRESH]),
};

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

// Attach the bearer token on every request.
api.interceptors.request.use(async (config) => {
  const token = await tokens.getAccess();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Transparent access-token refresh on 401 (mirrors the web client) ──
let isRefreshing = false;
let queue = [];
const flush = (err, token = null) => {
  queue.forEach((p) => (err ? p.reject(err) : p.resolve(token)));
  queue = [];
};

// Called when the session is unrecoverable — the auth store subscribes to this.
let onSessionLost = null;
export const setSessionLostHandler = (fn) => { onSessionLost = fn; };

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const code = error.response?.data?.error?.code;
    if (status === 401 && !original._retry && (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN')) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => queue.push({ resolve, reject }))
          .then((token) => { original.headers.Authorization = `Bearer ${token}`; return api(original); });
      }
      original._retry = true;
      isRefreshing = true;
      try {
        const refreshToken = await tokens.getRefresh();
        if (!refreshToken) throw new Error('no refresh token');
        const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, { refreshToken });
        const newAccess = data.data?.accessToken;
        const newRefresh = data.data?.refreshToken;
        await tokens.set(newAccess, newRefresh);
        flush(null, newAccess);
        original.headers.Authorization = `Bearer ${newAccess}`;
        return api(original);
      } catch (e) {
        flush(e, null);
        await tokens.clear();
        if (onSessionLost) onSessionLost();
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(error);
  }
);

// Extract a human message from an axios error (same shape as the backend).
export const errorMessage = (err) =>
  err?.response?.data?.error?.message ||
  err?.response?.data?.message ||
  err?.message ||
  'Something went wrong';
