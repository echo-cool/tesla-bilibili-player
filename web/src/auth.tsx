import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { User } from './types';

interface AuthState {
  loggedIn: boolean;
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  loggedIn: false,
  user: null,
  loading: true,
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setLoggedIn(s.loggedIn);
      setUser(s.user);
    } catch {
      setLoggedIn(false);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ loggedIn, user, loading, refresh }}>{children}</AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
