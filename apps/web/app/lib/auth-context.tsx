"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { api, hasAccessToken, setAccessToken, WebApiError, type Consent, type ProfileResult, type User, type Workspace } from "./api";

type AuthState = { user: User | null; workspace: Workspace | null; profile: ProfileResult["profile"]; consents: Consent[]; loading: boolean; reload: () => Promise<void>; signOut: () => void };
const AuthContext = createContext<AuthState | null>(null);
let pendingReload: Promise<void> | undefined;
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<AuthState, "reload" | "signOut"> & { loading: boolean }>({ user: null, workspace: null, profile: null, consents: [], loading: true });
  const pathname = usePathname();
  const reload = async () => {
    if (pendingReload) return pendingReload;
    pendingReload = (async () => { try {
      if (!hasAccessToken()) await api.refresh();
      let workspace: Workspace | null = null;
      try { workspace = await api.workspace.get(); } catch (error) { if (!(error instanceof WebApiError) || error.status !== 404) throw error; }
      if (!workspace) { setState((current) => ({ ...current, workspace: null, profile: null, consents: [], loading: false })); return; }
      const [profile, consents] = await Promise.all([api.profile.get(), api.consents.list()]);
      setState((current) => ({ ...current, workspace, profile: profile.profile, consents, loading: false }));
    } catch { if (!hasAccessToken()) { setAccessToken(undefined); setState((current) => ({ ...current, user: null, workspace: null, profile: null, consents: [], loading: false })); } } })();
    try { await pendingReload; } finally { pendingReload = undefined; }
  };
  useEffect(() => { const onUser = (event: Event) => { const user = (event as CustomEvent<User>).detail; setState((current) => ({ ...current, user })); }; window.addEventListener("opc:user", onUser); if (!pathname.startsWith("/auth/")) void reload(); else setState((current) => ({ ...current, loading: false })); return () => window.removeEventListener("opc:user", onUser); }, [pathname]);
  const value = useMemo<AuthState>(() => ({ ...state, reload, signOut: () => { setAccessToken(undefined); setState({ user: null, workspace: null, profile: null, consents: [], loading: false }); } }), [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthState { const context = useContext(AuthContext); if (!context) throw new Error("useAuth must be used within AuthProvider"); return context; }
export function recordUser(user: User): void { window.dispatchEvent(new CustomEvent("opc:user", { detail: user })); }
