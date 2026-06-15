/**
 * Task Envelope — the structured wrapper AKA builds around the user's raw
 * prompt before handing it to an agent (Execute mode). A bare instruction like
 * "add a logout button" gives a small local model nothing to anchor on; the
 * envelope reframes it with an explicit objective, scope boundary, success
 * criteria, and an attachment manifest. This is feature 08 (Context Engine) —
 * AKA stays agent-agnostic: the envelope is just better prompt *text*, never a
 * model- or agent-specific instruction.
 *
 * The default template is editable per project (persisted as
 * `ProjectConfig.task_template`); "Reset to default" stores `null` and falls
 * back to {@link DEFAULT_TASK_TEMPLATE} here.
 */

import type { Attachment } from "../../stores/use-attachments-store";

/**
 * Placeholders the template may contain. Unknown placeholders are left intact;
 * a missing section collapses to an empty string so the prompt never carries a
 * dangling header.
 */
export const TEMPLATE_PLACEHOLDERS = [
  "{task}",
  "{scope}",
  "{success_criteria}",
  "{attachments}",
] as const;

/**
 * The built-in envelope. Tuned to sharpen instruction-following on small local
 * models: objective first (verbatim), then hard scope rails, then a concrete
 * definition of done, then the attachment manifest. Users can edit this per
 * project from the Provider Manager's Advanced tuning section.
 */
export const DEFAULT_TASK_TEMPLATE = `# Task

{task}

## Scope
{scope}

## Definition of done
{success_criteria}
{attachments}`;

const DEFAULT_SCOPE =
  "Only modify files inside this project. Make the smallest change that satisfies the task — do not refactor, rename, reformat, or touch unrelated code. If the request is ambiguous, choose the most conventional interpretation and state the assumption.";

const GENERIC_SUCCESS =
  "The task is fully implemented, the project still builds, and no unrelated behavior changed.";

export type BuildEnvelopeArgs = {
  /** The user's prompt, used verbatim as the objective. */
  task: string;
  /** Per-project override; falls back to {@link DEFAULT_TASK_TEMPLATE}. */
  template?: string | null;
  /** Every attachment pinned to this turn (files, folders, images, URLs). */
  attachments?: Attachment[];
  /**
   * The materialized attachment context (inlined file contents / folder trees)
   * already produced by `materializeAttachments`. Appended verbatim after the
   * framing so nothing the user attached is lost.
   */
  attachmentContext?: string;
  /** The project's verify command, used as the concrete success criterion. */
  verifyCmd?: string;
  /** Whether the selected model can see images (see `resolveVision`). */
  visionModel?: boolean;
};

/** Build the success-criteria section from the verify command, if any. */
function successCriteria(verifyCmd?: string): string {
  const cmd = verifyCmd?.trim();
  if (!cmd) return GENERIC_SUCCESS;
  return `The project's verification command passes:\n\n\`\`\`\n${cmd}\n\`\`\``;
}

/**
 * Build the attachment manifest section. Lists each attachment by kind, name,
 * and absolute path/URL so the agent can locate it on disk. For images on a
 * vision-capable model it adds an explicit instruction to actually look at the
 * image — without this, vision models routinely ignore an attached path.
 * Returns "" when there are no attachments (the section collapses away).
 */
export function buildAttachmentManifest(
  attachments: Attachment[] | undefined,
  visionModel: boolean | undefined,
): string {
  if (!attachments || attachments.length === 0) return "";

  const lines = attachments.map((a) => {
    const where = a.kind === "url" ? a.url : a.path;
    const loc = where ? ` — \`${where}\`` : "";
    return `- ${a.kind}: ${a.name}${loc}`;
  });

  const images = attachments.filter((a) => a.kind === "image" && a.path);
  let visionNote = "";
  if (images.length > 0 && visionModel) {
    const ref =
      images.length === 1
        ? "the attached image"
        : "the attached images";
    visionNote = `\n\nUse ${ref} as the visual reference for this task — inspect ${
      images.length === 1 ? "it" : "them"
    } before making changes.`;
  }

  return `\n\n## Attachments\n${lines.join("\n")}${visionNote}`;
}

/**
 * Compose the full Task Envelope. Pure and deterministic. Sections that have no
 * content collapse to an empty string, and the result is trimmed, so the prompt
 * never carries an empty header or trailing whitespace.
 */
export function buildTaskEnvelope({
  task,
  template,
  attachments,
  attachmentContext,
  verifyCmd,
  visionModel,
}: BuildEnvelopeArgs): string {
  const tpl = template && template.trim() ? template : DEFAULT_TASK_TEMPLATE;
  const manifest = buildAttachmentManifest(attachments, visionModel);

  const filled = tpl
    .replaceAll("{task}", task.trim())
    .replaceAll("{scope}", DEFAULT_SCOPE)
    .replaceAll("{success_criteria}", successCriteria(verifyCmd))
    .replaceAll("{attachments}", manifest);

  const ctx = attachmentContext?.trim();
  return (ctx ? `${filled.trim()}\n${ctx}` : filled).trim();
}
