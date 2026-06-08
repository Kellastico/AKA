import { useState } from "react";
import { Project, useProjectsStore } from "../../stores/use-projects-store";
import { useMessagesStore } from "../../stores/use-messages-store";
import { usePrefsStore } from "../../stores/use-prefs-store";
import { DeleteProjectModal } from "../DeleteProjectModal";

/**
 * Shared "delete this project" behaviour for the various project headers
 * (PillMorph, BottomSheet, …). Each header renders its own hover affordance
 * with mode-appropriate colors, then calls `requestDelete()` and drops `modal`
 * into its tree. The full-screen warning + "don't show again" suppression and
 * the actual removal all live here so the headers stay presentational.
 *
 * `onClose` closes the surrounding popover/sheet once the project is gone.
 */
export function useProjectDeletion(project: Project, onClose: () => void) {
  const removeProject = useProjectsStore((s) => s.removeProject);
  const suppressWarning = usePrefsStore((s) => s.suppressDeleteProjectWarning);
  const setSuppressWarning = usePrefsStore(
    (s) => s.setSuppressDeleteProjectWarning,
  );
  const [open, setOpen] = useState(false);

  // Forget the project plus every trace its sessions left in memory — archived
  // messages keyed by session id would otherwise leak forever. Files on disk
  // are never touched; this only removes the project from AKA.
  const doDelete = () => {
    const forgetSession = useMessagesStore.getState().forgetSession;
    for (const s of project.sessions) forgetSession(s.id);
    void removeProject(project.id);
    onClose();
  };

  // The full-screen warning is skippable via "Don't show this again"; once
  // suppressed, deletion happens immediately.
  const requestDelete = () => {
    if (suppressWarning) {
      doDelete();
      return;
    }
    setOpen(true);
  };

  const modal = (
    <DeleteProjectModal
      open={open}
      projectName={project.name}
      projectPath={project.path}
      onConfirm={(dontShowAgain) => {
        setOpen(false);
        if (dontShowAgain) void setSuppressWarning(true);
        doDelete();
      }}
      onCancel={() => setOpen(false)}
    />
  );

  return { requestDelete, modal };
}
