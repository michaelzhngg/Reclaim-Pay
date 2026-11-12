"use client";

import React, {
  createContext,
  useState,
  useEffect,
  useContext,
  ReactNode,
  useCallback,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  login as loginAction,
  logout as logoutAction,
  getCurrentUser,
} from "@/lib/actions/auth";
import type { User } from "@/lib/api/types";
import { homePathForRole } from "@/lib/roles";
import LoadingOverlay from "@/components/LoadingOverlay";

// Module-level cache — survives remounts within the same page lifecycle
let _sessionCache: { user: User | null; ts: number } | null = null;
const SESSION_TTL_MS = 30_000;

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Merges fields the server just saved, so the nav and forms show them without a reload. */
  updateUser: (fields: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [sessionChecked, setSessionChecked] = useState<boolean>(false);
  const router = useRouter();
  const pathname = usePathname();

  // Reset isLoading whenever the route actually changes.
  // This is the reliable signal that router.push() has completed —
  // HRRoleGuard / EmployeeRoleGuard can then render their children.
  // Waits for the first session check, or a hard reload would reach the guards
  // with no user yet and bounce to /login.
  useEffect(() => {
    if (sessionChecked) setIsLoading(false);
  }, [pathname, sessionChecked]);

  // 1. Verify session on app start — skip if a fresh cache entry exists
  useEffect(() => {
    async function verifySession() {
      const now = Date.now();
      if (_sessionCache && now - _sessionCache.ts < SESSION_TTL_MS) {
        setUser(_sessionCache.user);
        setSessionChecked(true);
        return;
      }
      try {
        const currentUser = await getCurrentUser();
        _sessionCache = { user: currentUser, ts: Date.now() };
        setUser(currentUser);
      } catch (error) {
        console.error("Session verification failed:", error);
        _sessionCache = null;
        setUser(null);
      } finally {
        setSessionChecked(true);
      }
    }
    verifySession();
  }, []);

  // 2. Login — calls server action which sets HttpOnly cookie
  const login = useCallback(
    async (email: string, password: string) => {
      try {
        const result = await loginAction(email, password);

        if (result.error) {
          throw new Error(result.error);
        }

        // Trigger the loading overlay AFTER successful credential check
        setIsLoading(true);
        _sessionCache = { user: result.user, ts: Date.now() };
        setUser(result.user);

        // Brief delay to show the loading experience, then redirect.
        // NOTE: setIsLoading(false) is intentionally NOT called here.
        // router.push() is non-blocking — it returns before the page actually
        // changes. Calling setIsLoading(false) after it would drop the overlay
        // while the user is still on the login page.
        // The login component will simply unmount when navigation completes.
        await new Promise(resolve => setTimeout(resolve, 1800));

        router.push(homePathForRole(result.user?.role));
      } catch (error) {
        // Only reset loading on failure so the form becomes interactive again
        setIsLoading(false);
        throw error;
      }
    },
    [router]
  );

  // 3. Logout — calls server action which deletes HttpOnly cookie
  const logout = useCallback(async () => {
    await logoutAction();
    _sessionCache = null;
    setUser(null);
    router.push("/login");
  }, [router]);

  // 4. Profile edits: keep the session cache in step with the saved user
  const updateUser = useCallback((fields: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...fields };
      _sessionCache = { user: next, ts: Date.now() };
      return next;
    });
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, updateUser }}>
      {/* The public landing renders straight away so link previews and crawlers see its content. */}
      {isLoading && pathname !== "/" ? <LoadingOverlay show={true} /> : children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
