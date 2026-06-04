import { useEffect } from "react";
import { useMessagesStore } from "../stores/use-messages-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";
import { useTokenCounterStore } from "../stores/use-token-counter-store";

// Subscribes the global token counter to (a) conversation message changes and
// (b) active-model changes. A model swap or session clear resets the warned
// flag so the 90% toast can fire again in the new session.

export function useTokenCounterSync() {
  useEffect(() => {
    let prevMessages = useMessagesStore.getState().messages;
    let prevModel = useRuntimeStore.getState().selectedModelId;

    // Initial compute on mount.
    void useTokenCounterStore.getState().refresh();

    const unsubMessages = useMessagesStore.subscribe((state) => {
      if (state.messages === prevMessages) return;
      const cleared = state.messages.length === 0 && prevMessages.length > 0;
      prevMessages = state.messages;
      if (cleared) useTokenCounterStore.getState().reset();
      void useTokenCounterStore.getState().refresh();
    });

    const unsubRuntime = useRuntimeStore.subscribe((state) => {
      if (state.selectedModelId === prevModel) return;
      prevModel = state.selectedModelId;
      // Model swap: only the context-window limit changes, not the message
      // text. Clearing `used` would cause the meter to flicker to 0% mid-swap,
      // which looks like a screen glitch. We only clear the `warned` flag so
      // the 90% toast can re-fire against the new limit, and let `refresh()`
      // recompute used + ratio + status in a single state update.
      useTokenCounterStore.setState({ warned: false });
      void useTokenCounterStore.getState().refresh();
    });

    return () => {
      unsubMessages();
      unsubRuntime();
    };
  }, []);
}
