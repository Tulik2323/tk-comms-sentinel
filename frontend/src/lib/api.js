// lib/api.js — axios instance עם JWT header אוטומטי
import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

// הוסף JWT לכל בקשה אוטומטית
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('nm_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// טפל בפקיעת token גלובלית
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('nm_token');
      localStorage.removeItem('nm_user');
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;

// --- helper: פורמט bps ---
export function formatBps(bps) {
  if (bps == null || isNaN(bps)) return '—';
  if (bps >= 1e9)  return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6)  return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3)  return `${(bps / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(bps)} bps`;
}

// --- helper: פורמט uptime ---
export function formatUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// --- helper: צבע לפי utilization % ---
export function utilColor(pct) {
  if (pct > 80) return '#ef4444';
  if (pct > 60) return '#f97316';
  return '#22c55e';
}
