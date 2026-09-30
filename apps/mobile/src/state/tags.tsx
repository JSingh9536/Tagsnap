import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { useAuth } from './auth';
import { fetchMyTags, subscribeToMyTags } from '../lib/api';
import { syncNow } from '../lib/sync';
import { allOutbox, cacheTags, cachedTags, type OutboxRow } from '../lib/db';
import { clearBadge, registerForPush } from '../lib/notifications';
import type { TagWithRelations } from '@tagsnap/shared';

/**
 * Everything the field app knows about this user's tags — the ones the server
 * has and the ones still sitting on the phone.
 *
 * The two lists are kept separate rather than merged into one. A queued tag
 * has no ticket number, no tonnage, and no status the office has ever seen,
 * and pretending otherwise produces a list where a driver cannot tell what has
 * actually been sent.
 */

interface TagsState {
  tags: TagWithRelations[];
  outbox: OutboxRow[];
  loading: boolean;
  syncing: boolean;
  online: boolean;
  error: string | null;
  lastSyncedAt: Date | null;
}

interface TagsApi extends TagsState {
  refresh: () => Promise<void>;
  kickSync: () => Promise<void>;
  /** Tags the office has sent back and is waiting on. */
  rescans: TagWithRelations[];
}

const Ctx = createContext<TagsApi | null>(null);

/** Slow poll as a backstop for a dropped realtime socket. */
const POLL_MS = 60_000;

export function TagsProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();

  const [state, setState] = useState<TagsState>({
    tags: [],
    outbox: [],
    loading: true,
    syncing: false,
    online: true,
    error: null,
    lastSyncedAt: null,
  });

  const syncing = useRef(false);

  /** Tags the office has sent back. The only state where somebody is waiting. */
  const rescans = useMemo(
    () => state.tags.filter((t) => t.status === 'rescan_requested'),
    [state.tags]
  );

  // Read by the badge effect below, which must not re-run every time the count
  // changes — only act on the current value when something else re-renders.
  const rescanCount = useRef(0);
  rescanCount.current = rescans.length;

  const loadOutbox = useCallback(async () => {
    const rows = await allOutbox();
    setState((s) => ({ ...s, outbox: rows }));
  }, []);

  const refresh = useCallback(async () => {
    if (!profile) return;
    try {
      const tags = await fetchMyTags();
      await cacheTags(tags);
      setState((s) => ({ ...s, tags, loading: false, error: null }));
    } catch (err) {
      // Falling back to the cache is the difference between a useful screen
      // and a spinner in a dead zone.
      const cached = await cachedTags<TagWithRelations>();
      setState((s) => ({
        ...s,
        tags: cached.length > 0 ? cached : s.tags,
        loading: false,
        error:
          err instanceof Error && /network|fetch/i.test(err.message)
            ? null // no signal is not an error worth shouting about
            : (err as Error).message,
      }));
    } finally {
      await loadOutbox();
    }
  }, [profile, loadOutbox]);

  const kickSync = useCallback(async () => {
    if (!profile || syncing.current) return;
    syncing.current = true;
    setState((s) => ({ ...s, syncing: true }));

    try {
      const result = await syncNow(profile.company_id);
      if (result.sent > 0) await refresh();
      setState((s) => ({ ...s, lastSyncedAt: new Date() }));
    } catch {
      // The worker records its own failures per row; nothing useful to add.
    } finally {
      syncing.current = false;
      setState((s) => ({ ...s, syncing: false }));
      await loadOutbox();
    }
  }, [profile, refresh, loadOutbox]);

  // Initial load.
  useEffect(() => {
    if (!profile) {
      setState((s) => ({ ...s, tags: [], loading: false }));
      return;
    }
    void refresh().then(() => kickSync());
  }, [profile, refresh, kickSync]);

  // Drain the queue the moment signal comes back. This is the single most
  // valuable listener in the app — it is what makes leaving a dead zone feel
  // like nothing happened.
  useEffect(() => {
    const unsub = NetInfo.addEventListener((netState) => {
      const online = Boolean(netState.isConnected && netState.isInternetReachable !== false);
      setState((s) => ({ ...s, online }));
      if (online) void kickSync();
    });
    return unsub;
  }, [kickSync]);

  // And on return to the foreground, since a phone in a pocket may have
  // reconnected while the listener was asleep.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void refresh();
        void kickSync();
      }
    });
    return () => sub.remove();
  }, [refresh, kickSync]);

  // Live updates, so a driver sees "Approved" without pulling to refresh.
  useEffect(() => {
    if (!profile) return;
    return subscribeToMyTags(profile.id, () => {
      void refresh();
    });
  }, [profile, refresh]);

  // Register this device for push once we know who is holding it. Deliberately
  // here rather than at sign-in: the token is tied to a profile, and this is
  // the first point where the profile is settled.
  useEffect(() => {
    if (!profile) return;
    void registerForPush(profile.id);
  }, [profile]);

  // Clear the badge once there is genuinely nothing waiting on the driver.
  useEffect(() => {
    if (rescanCount.current === 0) void clearBadge();
  });

  useEffect(() => {
    if (!profile) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [profile, refresh]);


  const api = useMemo<TagsApi>(
    () => ({ ...state, refresh, kickSync, rescans }),
    [state, refresh, kickSync, rescans]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useTags(): TagsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTags must be used inside TagsProvider');
  return ctx;
}
