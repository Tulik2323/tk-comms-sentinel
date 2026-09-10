// hooks/useDevices.js — טעינה ורענון אוטומטי של מכשירים
import { useState, useEffect, useCallback } from 'react';
import api from '../lib/api';

export function useDevices(autoRefreshSec = 30) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const fetch = useCallback(async () => {
    try {
      const res = await api.get('/devices');
      setDevices(Array.isArray(res.data) ? res.data : res.data?.devices ?? []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'שגיאה בטעינת מכשירים');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    if (!autoRefreshSec) return;
    const interval = setInterval(fetch, autoRefreshSec * 1000);
    return () => clearInterval(interval);
  }, [fetch, autoRefreshSec]);

  return { devices, loading, error, refetch: fetch };
}
