import { create } from "zustand";
import { api, ApiError } from "../services/api";
import type { Me } from "../types/auth";

type Status = "loading" | "anonymous" | "authenticated";

interface AuthState {
  status: Status;
  me: Me | null;
  /** Ask the server who we are. The session cookie is HttpOnly: only the server can read it. */
  refresh: () => Promise<Me | null>;
  login: (portal: string, email: string, password: string, remember: boolean) => Promise<Me>;
  logout: () => Promise<void>;
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  status: "loading",
  me: null,
  refresh: async () => {
    try {
      const me = await api.me();
      set({ me, status: "authenticated" });
      return me;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) set({ me: null, status: "anonymous" });
      else set((s) => ({ status: s.me ? "authenticated" : "anonymous" }));
      return null;
    }
  },
  login: async (portal, email, password, remember) => {
    await api.login(portal, email, password, remember);
    const me = await api.me();
    set({ me, status: "authenticated" });
    return me;
  },
  logout: async () => {
    try {
      await api.logout();
    } finally {
      set({ me: null, status: "anonymous" });
    }
  },
  clear: () => set({ me: null, status: "anonymous" }),
}));

/** UI convenience only: the backend checks the same permission on every request. */
export function useCan() {
  const me = useAuth((s) => s.me);
  return (perm: string) => !!me && !me.must_change_password && me.permissions.includes(perm);
}
