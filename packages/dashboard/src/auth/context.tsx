import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { getStoredAdminToken, setStoredAdminToken } from './token';

interface AdminAuthContextValue {
  adminToken: string;
  saveAdminToken: (token: string) => void;
  clearAdminToken: () => void;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [adminToken, setAdminToken] = useState<string>(getStoredAdminToken);

  const saveAdminToken = useCallback((token: string) => {
    const trimmed = token.trim();
    setAdminToken(trimmed);
    setStoredAdminToken(trimmed);
  }, []);

  const clearAdminToken = useCallback(() => {
    setAdminToken('');
    setStoredAdminToken('');
  }, []);

  return (
    <AdminAuthContext.Provider value={{ adminToken, saveAdminToken, clearAdminToken }}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be used within AdminAuthProvider');
  return ctx;
}
