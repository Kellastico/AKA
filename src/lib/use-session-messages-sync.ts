import { useEffect } from "react";
import { useMessagesStore } from "../stores/use-messages-store";
import { useProjectsStore } from "../stores/use-projects-store";

/**
 * Keeps the visible chat history in lockstep with the active session. When
 * `useProjectsStore.activeSessionId` changes, the current `messages` are
 * snapshotted under the previous session id and the incoming session's
 * messages are loaded.
 *
 * Mount once in AppShell — it owns the subscription for the app's lifetime.
 */
export function useSessionMessagesSync() {
  useEffect(() => {
    // Initial align: load whatever session is already active at mount time.
    const initial = useProjectsStore.getState().activeSessionId;
    useMessagesStore.getState().loadSession(initial);

    let prev = initial;
    return useProjectsStore.subscribe((state) => {
      if (state.activeSessionId === prev) return;
      prev = state.activeSessionId;
      useMessagesStore.getState().loadSession(state.activeSessionId);
    });
  }, []);
}
