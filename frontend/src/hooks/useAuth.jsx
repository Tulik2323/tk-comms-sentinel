// hooks/useAuth.js — ניהול מצב אימות גלובלי
import { useState, useEffect, createContext, useContext } from 'react';
import api from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // בדוק token שמור מ-localStorage
    const token     = localStorage.getItem('nm_token');
    const savedUser = localStorage.getItem('nm_user');
    if (token && savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch (_) {}
    }
    setLoading(false);
  }, []);

  function login(token, userData) {
    localStorage.setItem('nm_token', token);
    localStorage.setItem('nm_user', JSON.stringify(userData));
    setUser(userData);
  }

  function logout() {
    localStorage.removeItem('nm_token');
    localStorage.removeItem('nm_user');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
