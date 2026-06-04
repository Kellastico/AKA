import { useEffect, useRef, useState } from "react";
import { Cube, Stack } from "@phosphor-icons/react";
import { Popover } from "../Popover";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { useModelBrowserStore } from "../../features/01-llm-provider/use-model-browser-store";
import { HealthDot } from "../../features/01-llm-provider/ConnectionPanel";
import { useActiveSessionRunning } from "../../stores/use-chat-store";
import { useSessionStore } from "../../stores/use-session-store";
import { useAgentsStore } from "../../stores/use-agents-store";
import { useMessagesStore } from "../../stores/use-messages-store";
import {
  PickerGroupLabel,
  PickerOption,
  PickerPillButton,
} from "./PickerPill";

export function ModelPicker({ compact }: { compact?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // When the Model Browser opens (from "Manage models"), close this popover so
  // it doesn't linger behind the modal.
  const modelBrowserOpen = useModelBrowserStore((s) => s.open);
  const openModelBrowser = useModelBrowserStore((s) => s.openBrowser);
  const openRuntimePanel = useRuntimeStore((s) => s.setRuntimePanelOpen);
  useEffect(() => {
    if (modelBrowserOpen) setOpen(false);
  }, [modelBrowserOpen]);

  const active = useRuntimeStore((s) => s.active);
  const healthy = useRuntimeStore((s) => s.healthy);
  const models = useRuntimeStore((s) => s.models);
  const loadingModels = useRuntimeStore((s) => s.loadingModels);
  const modelsError = useRuntimeStore((s) => s.modelsError);
  const selectedId = useRuntimeStore((s) => s.selectedModelId);
  const select = useRuntimeStore((s) => s.selectModel);
  // Lock the picker while a response is streaming — swapping mid-generation
  // tears down the request and creates inconsistent state.
  const running = useActiveSessionRunning();
  // Model is session-locked when the active agent owns its LLM connection
  // (external processes like Aider commit to a model at spawn time).
  const sessionHasMessages = useMessagesStore((s) => s.messages.length > 0);
  const selectedAgent = useAgentsStore((s) =>
    s.agents.find((a) => a.id === s.selectedAgentId),
  );
  // ...but never lock when there's no model selected. A runtime switch can null
  // the selection (the old model isn't served here); locking that empty state
  // would trap the user — checklist says "Select a model" while the picker is
  // disabled. With no model, always allow a pick.
  const modelSessionLocked =
    sessionHasMessages &&
    selectedAgent?.llmOwnership === "agent" &&
    selectedId != null;

  // When a runtime switch strands the session with no valid model, the store
  // bumps this counter — pop the picker open so the next step is obvious.
  const pickModelNudge = useRuntimeStore((s) => s.pickModelNudge);
  const lastNudge = useRef(pickModelNudge);
  useEffect(() => {
    if (pickModelNudge !== lastNudge.current) {
      lastNudge.current = pickModelNudge;
      setOpen(true);
    }
  }, [pickModelNudge]);

  const label = selectedId ?? (active ? "Select model" : "Connect runtime");

  return (
    <>
      <PickerPillButton
        buttonRef={ref}
        icon={
          <span className="inline-flex items-center gap-1.5">
            <HealthDot healthy={healthy} size={6} />
            <Cube size={14} />
          </span>
        }
        label={label}
        open={open}
        compact={compact}
        disabled={running}
        disabledTitle="Wait for the response to finish, or press Stop, before switching models."
        sessionLocked={modelSessionLocked}
        onClick={() => {
          setOpen((v) => !v);
        }}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        width={300}
      >
        <div>
            <div className="flex items-center justify-between px-1 pt-1">
              <PickerGroupLabel>
                {active?.baseUrl ?? "No runtime"}
              </PickerGroupLabel>
            </div>

            {!active || !healthy ? (
              <div className="px-3 pb-3 pt-1 text-xs text-white/60">
                {active ? (
                  <>
                    Runtime offline. Start your server or{" "}
                    <button
                      onClick={() => {
                        setOpen(false);
                        openRuntimePanel(true);
                      }}
                      className="underline hover:text-white"
                    >
                      pick another
                    </button>
                    .
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setOpen(false);
                      openRuntimePanel(true);
                    }}
                    className="underline hover:text-white"
                  >
                    Connect a runtime
                  </button>
                )}
              </div>
            ) : loadingModels ? (
              <div className="px-3 py-2 text-xs text-white/50">Loading models…</div>
            ) : modelsError ? (
              <div className="px-3 py-2 text-xs text-red-300">{modelsError}</div>
            ) : models.length === 0 ? (
              <div className="px-3 py-2 text-xs text-white/50">
                Runtime returned no models.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
              {models.map((m) => (
                <PickerOption
                  key={m}
                  selected={m === selectedId}
                  onClick={() => {
                    setOpen(false);
                    if (m === selectedId) return;
                    // Defensive: any rejection in the apply callback or the
                    // handoff itself becomes an in-app toast, never an
                    // uncaught promise that could blank the WebView.
                    useSessionStore
                      .getState()
                      .performHandoff(
                        "model",
                        selectedId ?? "(unset)",
                        m,
                        async () => {
                          try {
                            await select(m);
                          } catch (err) {
                            useRuntimeStore.getState().pushToast({
                              kind: "error",
                              text:
                                err instanceof Error
                                  ? `Couldn't switch model: ${err.message}`
                                  : "Couldn't switch model.",
                            });
                          }
                        },
                      )
                      .catch((err) => {
                        useRuntimeStore.getState().pushToast({
                          kind: "error",
                          text:
                            err instanceof Error
                              ? `Model swap failed: ${err.message}`
                              : "Model swap failed.",
                        });
                      });
                  }}
                >
                  {m}
                </PickerOption>
              ))}
              </div>
            )}

            <div className="mt-1 border-t border-white/10 pt-1">
              <button
                onClick={() => {
                  setOpen(false);
                  openModelBrowser();
                }}
                className="inline-flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-white/70 hover:bg-white/10 hover:text-white"
              >
                <Stack size={13} />
                Manage models
              </button>
            </div>
        </div>
      </Popover>
    </>
  );
}
