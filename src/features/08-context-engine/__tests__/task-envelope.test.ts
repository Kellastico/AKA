import { describe, expect, it } from "vitest";
import type { Attachment } from "../../../stores/use-attachments-store";
import {
  DEFAULT_TASK_TEMPLATE,
  buildAttachmentManifest,
  buildTaskEnvelope,
} from "../task-envelope";

function img(name: string, path?: string): Attachment {
  return { id: name, kind: "image", name, path, approxTokens: 0 };
}
function file(name: string, path: string): Attachment {
  return { id: name, kind: "file", name, path, approxTokens: 0 };
}

describe("buildTaskEnvelope", () => {
  it("fills the default template with the verbatim task and generic success", () => {
    const out = buildTaskEnvelope({ task: "Add a logout button" });
    expect(out).toContain("# Task");
    expect(out).toContain("Add a logout button");
    expect(out).toContain("## Scope");
    expect(out).toContain("## Definition of done");
    // No attachments → the manifest section collapses away entirely.
    expect(out).not.toContain("## Attachments");
  });

  it("uses the verify command as the concrete success criterion when set", () => {
    const out = buildTaskEnvelope({ task: "x", verifyCmd: "npm test" });
    expect(out).toContain("verification command passes");
    expect(out).toContain("npm test");
  });

  it("lists attachments with their absolute paths", () => {
    const out = buildTaskEnvelope({
      task: "x",
      attachments: [file("notes.md", "/abs/notes.md"), img("ui.png", "/abs/ui.png")],
    });
    expect(out).toContain("## Attachments");
    expect(out).toContain("file: notes.md — `/abs/notes.md`");
    expect(out).toContain("image: ui.png — `/abs/ui.png`");
  });

  it("adds an explicit look-at-the-image instruction only for vision models", () => {
    const withVision = buildTaskEnvelope({
      task: "x",
      attachments: [img("ui.png", "/abs/ui.png")],
      visionModel: true,
    });
    expect(withVision).toContain("visual reference");

    const withoutVision = buildTaskEnvelope({
      task: "x",
      attachments: [img("ui.png", "/abs/ui.png")],
      visionModel: false,
    });
    // Path is still listed, but no "look at it" instruction for a text model.
    expect(withoutVision).toContain("image: ui.png");
    expect(withoutVision).not.toContain("visual reference");
  });

  it("honors a custom template and its placeholders", () => {
    const out = buildTaskEnvelope({
      task: "Do the thing",
      template: "ONLY: {task}",
      verifyCmd: "make",
    });
    expect(out).toBe("ONLY: Do the thing");
  });

  it("falls back to the default template when the override is blank", () => {
    const out = buildTaskEnvelope({ task: "y", template: "   " });
    expect(out).toContain("# Task");
    expect(out).toContain("y");
  });

  it("appends the materialized attachment context after the framing", () => {
    const out = buildTaskEnvelope({
      task: "x",
      attachmentContext: "\n\n---\n\nAttached context:\n\n### File: a.txt\nhello",
    });
    const taskIdx = out.indexOf("# Task");
    const ctxIdx = out.indexOf("Attached context");
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(taskIdx);
  });

  it("default template references every documented placeholder", () => {
    for (const p of ["{task}", "{scope}", "{success_criteria}", "{attachments}"]) {
      expect(DEFAULT_TASK_TEMPLATE).toContain(p);
    }
  });
});

describe("buildAttachmentManifest", () => {
  it("returns empty string when there are no attachments", () => {
    expect(buildAttachmentManifest([], true)).toBe("");
    expect(buildAttachmentManifest(undefined, true)).toBe("");
  });

  it("uses the singular instruction for one image", () => {
    const out = buildAttachmentManifest([img("a.png", "/a.png")], true);
    expect(out).toContain("the attached image");
    expect(out).toContain("inspect it");
  });

  it("uses the plural instruction for multiple images", () => {
    const out = buildAttachmentManifest(
      [img("a.png", "/a.png"), img("b.png", "/b.png")],
      true,
    );
    expect(out).toContain("the attached images");
    expect(out).toContain("inspect them");
  });
});
