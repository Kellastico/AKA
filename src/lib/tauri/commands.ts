import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

const hasTauri = () => "__TAURI_INTERNALS__" in window;

// ---------- AppError ----------
//
// Mirror of `src-tauri/src/error.rs::AppError`. Every Tauri command that can
// fail returns one of these variants on the error channel; the frontend
// never shows a raw Rust string. Each variant carries enough context for
// ErrorBanner to render a specific, actionable message.

export type AppError =
  | { kind: "RuntimeOffline" }
  | { kind: "NoAgentsInstalled"; hints: string[] }
  | { kind: "AgentCrash"; exitCode: number; stderr: string }
  | { kind: "VerifyCommandNotFound"; cmd: string }
  | { kind: "SandboxViolation"; path: string }
  | { kind: "ConfigCorrupted"; reason: string }
  | { kind: "SummarizationFailed" }
  /**
   * Synthesized client-side when the Rust binary returns a transport-level
   * failure that isn't covered by the real AppError variants — most commonly
   * "Command X not found" when the running binary predates a new command.
   * Never emitted by Rust; always constructed by `inferLlmError` or similar.
   */
  | { kind: "BackendUnavailable"; reason: string };

/** Coerce anything thrown by an `invoke()` call into an `AppError`. */
export function asAppError(err: unknown): AppError {
  if (err && typeof err === "object" && "kind" in err) {
    const candidate = err as { kind: string };
    switch (candidate.kind) {
      case "RuntimeOffline":
      case "NoAgentsInstalled":
      case "AgentCrash":
      case "VerifyCommandNotFound":
      case "SandboxViolation":
      case "ConfigCorrupted":
      case "SummarizationFailed":
      case "BackendUnavailable":
        return err as AppError;
    }
  }
  // Anything we don't recognize is a runtime-side surprise — surface it as
  // ConfigCorrupted so the user still sees an actionable message rather
  // than a raw string we'd otherwise drop on the floor.
  const reason =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err);
  return { kind: "ConfigCorrupted", reason };
}

export async function ping(): Promise<string> {
  return invoke<string>("ping");
}

/** Opens the OS native folder picker. Returns the selected path, or null if cancelled. */
export async function pickProjectFolder(): Promise<string | null> {
  // In the Tauri desktop build, use the native OS dialog.
  if ("__TAURI_INTERNALS__" in window) {
    const result = await open({ directory: true, multiple: false });
    if (Array.isArray(result)) return result[0] ?? null;
    return result;
  }

  // Browser fallback: use a hidden <input webkitdirectory> element.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? file.webkitRelativePath.split("/")[0] : null);
    };
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"];

/** Open the OS file picker. Returns an array of selected file paths. */
export async function pickFiles(opts?: {
  images?: boolean;
}): Promise<string[]> {
  if ("__TAURI_INTERNALS__" in window) {
    const result = await open({
      multiple: true,
      directory: false,
      filters: opts?.images
        ? [{ name: "Images", extensions: IMAGE_EXTS }]
        : undefined,
    });
    if (result === null) return [];
    return Array.isArray(result) ? result : [result];
  }
  // Browser fallback — File objects don't carry filesystem paths, so we use
  // the synthetic webkitRelativePath as a best-effort label.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (opts?.images) input.accept = IMAGE_EXTS.map((e) => "." + e).join(",");
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      resolve(files.map((f) => f.name));
    };
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/** Open the OS folder picker. Returns an array of selected folder paths. */
export async function pickFolders(): Promise<string[]> {
  if ("__TAURI_INTERNALS__" in window) {
    const result = await open({ directory: true, multiple: true });
    if (result === null) return [];
    return Array.isArray(result) ? result : [result];
  }
  // Browser fallback — return the top-level folder name from webkitdirectory.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? [file.webkitRelativePath.split("/")[0]] : []);
    };
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/**
 * Open the OS "Save file" dialog. Returns the chosen path, or null if cancelled
 * or unavailable (browser dev). Used by the wrapper-stub generator to write a
 * starter script the user then edits.
 */
export async function saveFileDialog(opts?: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (!hasTauri()) return null;
  const result = await save({
    defaultPath: opts?.defaultPath,
    filters: opts?.filters,
  });
  return result ?? null;
}

// ---------- Project config (`<project>/.äkä/config.json`) ----------
//
// Every per-project setting lives in this single config file. There is no
// global config. Each command that needs config (run_agent, run_verify,
// call_llm, apply_diff) re-reads it from disk on every call — the frontend
// never sends a config struct, and the backend never caches one between
// tasks.

export type RuntimeBlock = {
  base_url: string;
  model: string;
  api_key: string | null;
  /** System prompt prepended to the chat path / exported to agents. */
  system_prompt?: string | null;
  /** Sampling controls; null falls back to AKA's accuracy-leaning defaults. */
  temperature?: number | null;
  top_p?: number | null;
  /** Explicit vision-capability override; null = auto-detect from model id. */
  vision?: boolean | null;
};

export type AgentBlock = {
  name: string;
  bin: string;
  args: string[];
  verify_cmd: string;
  /** Command the `diagnostics` built-in tool runs (typecheck/lint). */
  diagnostics_cmd: string;
  /** Tool names this agent already provides; AKA honors these first. */
  provides_tools: string[];
  dry_run_flags: string[];
};

export type SandboxBlock = {
  /** Informational only — the actual sandbox is set from the opened path. */
  project_path: string;
};

/**
 * Per-project dev-server command. Empty `cmd` = unconfigured; callers must
 * prompt the user (DevServerPromptModal) before invoking startDevServer.
 */
export type DevServerBlock = {
  cmd: string;
  args: string[];
};

/**
 * Project controls for AKA's built-in tool pantry (the overridable tool set).
 * The shim is always on PATH; this governs whether/how AKA advertises its tools.
 */
export type ToolsBlock = {
  /** Master switch — off advertises nothing (no AKA_TOOLS / manifest). */
  enabled: boolean;
  /** "advertise" = offer all built-ins; "gapfill" = only names the agent lacks. */
  mode: string;
};

/**
 * A capability "folder" — the privilege boundary a tool is routed/enforced under.
 * Mirrors the Rust `Capability` enum; the vocabulary is shared with the agent.
 */
export type Capability =
  | "fs_read"
  | "fs_write"
  | "search"
  | "git"
  | "network"
  | "exec";

/** Who provides a tool: AKA's House pantry, or a foreign (untrusted) Agent. */
export type ToolOwner = "house" | "agent";

/** A coding run phase — host-owned; gates which folders' tools the model sees. */
export type Phase = "research" | "plan" | "edit" | "review" | "commit";

/** One advertisable built-in tool, as returned by `tool_manifest`. */
export type ToolSpec = {
  name: string;
  usage: string;
  category: string;
  /** SHORT model-facing signpost (the only description shown to the model). */
  model_desc: string;
  /** Privilege boundary this tool lives in. */
  folder: Capability;
  kind: "passthrough" | "native";
};

/** The effective tool manifest for a project — advertised + shadowed. */
export type ToolManifest = {
  tools: ToolSpec[];
  shadowed: string[];
  mode: string;
  enabled: boolean;
};

/**
 * Standard MCP tool annotations — untrusted hints, retained for classification
 * only, never the basis of an enforcement decision.
 */
export type McpAnnotations = {
  readOnlyHint?: boolean | null;
  destructiveHint?: boolean | null;
  idempotentHint?: boolean | null;
  openWorldHint?: boolean | null;
};

/** The default-deny rules for a folder (materialized for the policy layer). */
export type ScopePolicy = {
  folder: Capability;
  denyByDefault: boolean;
  requiresApproval: boolean;
  projectScoped: boolean;
  allowsWrite: boolean;
  allowsEgress: boolean;
  allowsExec: boolean;
};

/**
 * One tool as the host knows it (host-facing). Everything but `modelDesc` is
 * host-only — the model never sees a `ToolEntry`, only the `ModelTool` projection.
 */
export type ToolEntry = {
  name: string;
  folder: Capability;
  modelDesc: string;
  scopePolicy: ScopePolicy;
  requiresApproval: boolean;
  /** Provenance/content hash — forward hook for the Garden; never enforced on. */
  sha256: string;
  owner: ToolOwner;
  annotations: McpAnnotations;
};

/** Host-facing registry view (full ToolEntry list). For the UI, not the model. */
export type ToolRegistry = {
  entries: ToolEntry[];
};

/** The entire surface the *model* is allowed to see for a tool. */
export type ModelTool = {
  name: string;
  modelDesc: string;
};

/**
 * Per-project capability/privilege controls (the house layer's narrow-only knobs).
 * Every default is the deny/safe value; a project may only *narrow* the
 * deny-by-default baseline, never widen a folder open.
 */
export type CapabilitiesBlock = {
  /** Network destinations explicitly allowed; empty = no egress (cloud included). */
  network_allowlist: string[];
  /** Process/tool names allowed under the `exec` folder; empty = none. */
  exec_allow: string[];
  /** Whether `git`-folder actions require explicit user approval. */
  git_requires_approval: boolean;
  /** Optional per-phase live-folder overrides, keyed by phase name. */
  phase_overrides?: Record<Phase, Capability[]> | null;
  /** Tool names where a foreign agent's own impl may win over the House built-in. */
  tool_overrides: string[];
  /**
   * Whether AKA runs the `--äkä-probe` capability handshake before a session's
   * first run. On (default) → probe-answering agents auto-enable the rich
   * treatment; off → every agent is treated as a plain agent. Purely additive.
   */
  probe: boolean;
};

export type ProjectConfig = {
  runtime: RuntimeBlock;
  agent: AgentBlock;
  mode: string;
  max_retries: number;
  sandbox: SandboxBlock;
  dev_server: DevServerBlock;
  tools: ToolsBlock;
  capabilities: CapabilitiesBlock;
  /** Custom Task Envelope template; null = use the built-in default. */
  task_template?: string | null;
};

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  runtime: {
    base_url: "http://localhost:11434/v1",
    model: "",
    api_key: null,
    system_prompt: null,
    temperature: null,
    top_p: null,
    vision: null,
  },
  agent: {
    name: "",
    bin: "",
    args: [],
    verify_cmd: "",
    diagnostics_cmd: "",
    provides_tools: [],
    dry_run_flags: [],
  },
  mode: "agent",
  max_retries: 3,
  sandbox: {
    project_path: "",
  },
  dev_server: {
    cmd: "",
    args: [],
  },
  tools: {
    enabled: true,
    mode: "advertise",
  },
  capabilities: {
    network_allowlist: [],
    exec_allow: [],
    git_requires_approval: true,
    phase_overrides: null,
    tool_overrides: [],
    probe: true,
  },
  task_template: null,
};

export async function loadConfig(projectPath: string): Promise<ProjectConfig> {
  if (!hasTauri()) {
    return { ...DEFAULT_PROJECT_CONFIG, sandbox: { project_path: projectPath } };
  }
  return invoke<ProjectConfig>("load_config", { projectPath });
}

/**
 * The effective built-in tool manifest for a project — advertised tools plus the
 * names shadowed by the agent's own tools, honoring `tools.mode`. Drives the
 * "N defaults overridden" indicator. Empty manifest outside Tauri.
 */
export async function toolManifest(projectPath: string): Promise<ToolManifest> {
  if (!hasTauri()) {
    return { tools: [], shadowed: [], mode: "advertise", enabled: true };
  }
  return invoke<ToolManifest>("tool_manifest", { projectPath });
}

export async function saveConfig(
  projectPath: string,
  config: ProjectConfig,
): Promise<void> {
  if (!hasTauri()) return;
  return invoke("save_config", { projectPath, config });
}

// ---------- Agent runner ----------

export type DetectedAgent = {
  bin: string;
  installed: boolean;
  version: string | null;
};

/**
 * The capability dial emitted to a spawned agent as `AGENT_*` env. Derived from
 * the model classification + chosen posture in `model-posture.ts`; the host only
 * relays it. A posture-aware agent honors it; others ignore the unknown env.
 */
export type AgentPosture = {
  /** Size tier `small | mid | large` → `AGENT_PROFILE`. */
  profile: string;
  /** `native | text` → `AGENT_TOOLCALL` (native only when the model supports it). */
  toolcall: string;
  /** `loose | strict` → `AGENT_GATING`. */
  gating: string;
  /** Max autonomous steps before orchestrator intervention → `AGENT_LEASH`. */
  leash: number;
};

/**
 * Launch the agent configured for `projectPath`. The backend reads the
 * project's config on every call, so changes to the agent block take effect
 * on the next run with no restart.
 */
export async function runAgent(
  task: string,
  projectPath: string,
  /**
   * Stable id for this run. Lets the backend tag its `agent://output` /
   * `agent://done` events so concurrent sessions can route their own stream,
   * and lets {@link stopAgent} target this run specifically. Omit to have the
   * backend mint one (single-run / legacy callers).
   */
  runId?: string,
  /**
   * Live runtime values captured at dispatch time. Passing these bypasses the
   * backend's disk read for model/base-URL/api-key, so a model the user just
   * switched to is honoured even if its async `saveConfig` write is still in
   * flight. Omit to let the backend read everything from `.äkä/config.json`.
   */
  modelOverride?: string,
  baseUrlOverride?: string,
  apiKeyOverride?: string | null,
  /**
   * Absolute paths of image attachments pinned to this task. AKA can't inject
   * them into the agent's own model call (the agent is a separate process that
   * makes its own LLM calls), so it hands the agent the files via the
   * `AKA_IMAGE_PATHS` env var. Omit when the task has no images.
   */
  imagePaths?: string[],
  /**
   * All attachments for this task, surfaced to the agent as `AKA_ATTACHMENTS`
   * (a JSON array of `{ name, kind, path }`). Omit when there are none.
   */
  attachments?: { name: string; kind: string; path?: string }[],
  /**
   * The capability dial for this run, emitted to the agent as `AGENT_PROFILE`/
   * `AGENT_TOOLCALL`/`AGENT_GATING`/`AGENT_LEASH`. Omit for the None posture or
   * when the dial is disabled — the backend then emits no `AGENT_*` env, and an
   * agent that doesn't honor the dial ignores it regardless (no regression).
   */
  posture?: AgentPosture,
): Promise<void> {
  return invoke("run_agent", {
    task,
    projectPath,
    runId: runId ?? null,
    modelOverride: modelOverride ?? null,
    baseUrlOverride: baseUrlOverride ?? null,
    apiKeyOverride: apiKeyOverride ?? null,
    imagePaths: imagePaths ?? null,
    attachments: attachments ?? null,
    posture: posture ?? null,
  });
}

/**
 * Stop a run. Pass the `runId` returned-through to stop just that run; omit it
 * to stop every live run (the legacy single-run behaviour).
 */
export async function stopAgent(runId?: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("stop_agent", { runId: runId ?? null });
}

/** Payload of the `agent://question` event — the agent is waiting on input. */
export type AgentQuestion = {
  runId: string;
  /** The detected prompt text (ANSI-stripped). */
  prompt: string;
  /** "confirm" → yes/no (Approve/Reject); "input" → free-text reply. */
  kind: "confirm" | "input";
};

/**
 * Deliver the user's answer to a waiting agent — types `text` (+ newline) into
 * the run's PTY. Returns false if the run isn't live (already finished/stopped).
 */
export async function answerAgent(runId: string, text: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("answer_agent", { runId, text });
}

/** Payload of the `agent://state` event — a run's lifecycle transition. */
export type AgentStateEvent = {
  runId: string;
  state: "running" | "paused";
};

/**
 * Suspend a running agent (and its child processes) via SIGSTOP. Resolves to
 * false when the run isn't live, the backend couldn't get a pid, or the
 * platform is unsupported (non-Unix). The UI hides Pause where unsupported.
 */
export async function pauseAgent(runId: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("pause_agent", { runId });
}

/** Resume a paused agent via SIGCONT. False if the run isn't live/suspendable. */
export async function resumeAgent(runId: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("resume_agent", { runId });
}

/**
 * Probe which of the user's registered agent `bins` are present on PATH.
 * AKA ships no agent catalog — the caller passes the bins from the user's
 * saved agents, and the backend reports installed-state + version per bin.
 */
export async function detectAgents(bins: string[]): Promise<DetectedAgent[]> {
  if (!hasTauri()) return [];
  return invoke<DetectedAgent[]>("detect_agents", { bins });
}

export async function recheckAgents(bins: string[]): Promise<DetectedAgent[]> {
  if (!hasTauri()) return [];
  return invoke<DetectedAgent[]>("recheck_agents", { bins });
}

// ---------- Capability probe (`--äkä-probe`) ----------

/**
 * The capability object a probe-answering agent (Änyä/Enyö) prints in response to
 * `--äkä-probe`. Field names are the agent's verbatim wire format (snake_case plus
 * the kebab `capability-contract`), so this mirrors exactly what the agent sent.
 */
export type AgentProbe = {
  /** Always `"agent"` for a valid answer. */
  type: string;
  name: string;
  /** Agent owns its own LLM connection → AKA locks the model picker. */
  manages_llm: boolean;
  /** Agent emits a typed node/phase stream → AKA enables the stream panel. */
  supports_streaming: boolean;
  supports_dry_run: boolean;
  required_args: string[];
  /** `"v1"` → host-driven phase routing + folder-keyed shadow/fallback. */
  "capability-contract"?: string | null;
  /** Advertised capability folders, retained verbatim (never trusted for policy). */
  capability_folders: string[];
};

/** Negotiated contract mode — the wire form of the Rust `ContractMode`. */
export type ContractMode = "v1" | "mcp-baseline";

/**
 * Result of probing the project's configured agent once per session. `answered`
 * separates a rich (probe-answering) agent from a plain one; `contract` is always
 * present (the safe `mcp-baseline` when the agent didn't answer or isn't v1).
 */
export type ProbeResult = {
  answered: boolean;
  contract: ContractMode;
  capabilities?: AgentProbe;
};

/** The silent-degrade result used outside Tauri and as the universal safe default. */
export const PLAIN_PROBE: ProbeResult = { answered: false, contract: "mcp-baseline" };

/**
 * Run `<agent_bin> --äkä-probe` for the project and return its advertised
 * capabilities. Never throws on a non-answer (timeout / non-JSON / non-zero exit)
 * — those resolve to {@link PLAIN_PROBE}, so a foreign agent degrades silently.
 * Caches belong to the caller: probe once per session, never per task.
 */
export async function probeAgentCapabilities(
  projectPath: string,
): Promise<ProbeResult> {
  if (!hasTauri()) return PLAIN_PROBE;
  try {
    return await invoke<ProbeResult>("probe_agent_capabilities", { projectPath });
  } catch {
    // Misconfiguration (no sandbox yet, etc.) must never break a run — treat it
    // as a plain agent, exactly like a non-answer.
    return PLAIN_PROBE;
  }
}

// ---------- Checkpoints ----------

/**
 * A git-backed working-tree snapshot for a run. Lives as a commit parked under
 * a private ref (`refs/aka/checkpoints/<runId>/<seq>`), invisible to the user's
 * `git log`/`status`/`stash`. Lets the user roll back anything the agent did —
 * AKA's agent-agnostic substitute for a proactive per-action approval gate.
 */
export type Checkpoint = {
  runId: string;
  seq: number;
  /** Commit sha to restore from. */
  sha: string;
  /** Timeline label ("Before run", "After edit to …"). */
  label: string;
  /** "prerun" | "step" | "postrun" | "manual" | "prerestore". */
  kind: string;
  /** Files differing from HEAD at snapshot time (informational). */
  filesChanged: number;
  /** Unix epoch millis. */
  createdAt: number;
};

/** Payload of the `checkpoint://created` event. */
export type CheckpointCreated = Checkpoint;

/**
 * True when `projectPath` is inside a git work tree — i.e. checkpoints are
 * available. The UI shows "checkpoints unavailable" when false (runs still work).
 */
export async function checkpointsAvailable(projectPath: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("checkpoints_available", { projectPath });
}

/**
 * Snapshot the working tree now. `kind` defaults to "manual" on the backend.
 * Returns the recorded checkpoint, or null when the project isn't a git repo.
 */
export async function createCheckpoint(
  projectPath: string,
  runId: string,
  label: string,
  kind?: string,
): Promise<Checkpoint | null> {
  if (!hasTauri()) return null;
  return invoke<Checkpoint | null>("create_checkpoint", {
    projectPath,
    runId,
    label,
    kind: kind ?? null,
  });
}

/** All checkpoints recorded for a run, oldest first. */
export async function listCheckpoints(runId: string): Promise<Checkpoint[]> {
  if (!hasTauri()) return [];
  return invoke<Checkpoint[]>("list_checkpoints", { runId });
}

/** One file's net change across a run — mirror of Rust `FileChange`. */
export type FileChange = {
  path: string;
  /** "modified" for a text change, "binary" when git reports unknown counts. */
  status: string;
  linesAdded: number;
  linesRemoved: number;
};

/**
 * Net file changes for a run, derived by diffing its prerun vs postrun
 * checkpoints (`git diff --numstat`). AKA's agent-agnostic "what did this agent
 * touch" source — works for any agent because it reads the disk, not stdout.
 * Returns [] when the run has no snapshots or the project isn't a git repo.
 */
export async function runFileChanges(
  projectPath: string,
  runId: string,
): Promise<FileChange[]> {
  if (!hasTauri()) return [];
  return invoke<FileChange[]>("run_file_changes", { projectPath, runId });
}

/**
 * Roll the working tree back to checkpoint `sha`. The backend auto-snapshots
 * the current state first, so a rollback is itself undoable.
 */
export async function restoreCheckpoint(
  projectPath: string,
  runId: string,
  sha: string,
): Promise<void> {
  if (!hasTauri()) return;
  return invoke("restore_checkpoint", { projectPath, runId, sha });
}

/** Forget a run's checkpoints and delete its private refs. Call on session close. */
export async function clearCheckpoints(projectPath: string, runId: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("clear_checkpoints", { projectPath, runId });
}

// ---------- Verification ----------

/**
 * Runs the project's configured verify command, streaming each line as a
 * `verify://output` event. Resolves to the process exit code. Pass/fail is
 * determined purely from this exit code — never from log strings.
 */
export async function runVerify(projectPath: string): Promise<number> {
  return invoke<number>("run_verify", { projectPath });
}

// ---------- Sandbox ----------

/**
 * Set the active project sandbox. All file/process operations from this point
 * on must resolve to a path inside `projectPath`. Returns the canonical
 * absolute path the Rust side recorded.
 */
export async function setSandbox(projectPath: string): Promise<string> {
  return invoke<string>("set_sandbox", { projectPath });
}

export async function clearSandbox(): Promise<void> {
  return invoke("clear_sandbox");
}

export async function currentSandbox(): Promise<string | null> {
  if (!hasTauri()) return null;
  return invoke<string | null>("current_sandbox");
}

/**
 * Ask the user to grant access to a path outside the active sandbox. The
 * Rust side emits `permission://request`; the modal answers with
 * `permission://response`. Per-session only — never persisted.
 */
export async function requestPathAccess(path: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("request_path_access", { path });
}

/**
 * Apply a unified-diff patch within the active sandbox. Every path in the
 * patch is validated before any hunk is applied; the patch is rejected
 * outright if any path escapes the sandbox.
 */
export async function applyDiff(
  patch: string,
  projectPath: string,
): Promise<void> {
  return invoke("apply_diff", { patch, projectPath });
}

/** An anchored string-replace edit request. */
export type StrReplaceReq = {
  /** Project-relative or absolute path to the file to edit. */
  path: string;
  /** Exact text to find — must be non-empty and match exactly once. */
  oldStr: string;
  /** Replacement text. */
  newStr: string;
};

/** What `applyStrReplace` returns — enough to refresh and diff the file. */
export type EditResult = {
  path: string;
  mtimeMs: number;
  linesAdded: number;
  linesRemoved: number;
};

/**
 * Anchored, scope-checked, checkpoint-before-write file edit. Enforced
 * identically for every agent: the path must resolve inside the active sandbox,
 * the anchor must be non-empty and match exactly once, and the working tree is
 * snapshotted (kind `"step"`, label "Before edit to …") before the write — so the
 * edit is undoable via `restoreCheckpoint`. Rejects raise `AppError::EditConflict`
 * (anchor empty/missing/ambiguous) or `SandboxViolation` (out of scope).
 */
export async function applyStrReplace(
  projectPath: string,
  runId: string,
  req: StrReplaceReq,
): Promise<EditResult> {
  return invoke<EditResult>("apply_str_replace", { projectPath, runId, req });
}

/**
 * Host-facing tool registry for a project — the full `ToolEntry` list (folder,
 * owner, scope policy, sha256, annotations). For the UI; not the model-facing
 * surface. Empty outside Tauri.
 */
export async function toolRegistry(projectPath: string): Promise<ToolRegistry> {
  if (!hasTauri()) return { entries: [] };
  return invoke<ToolRegistry>("tool_registry", { projectPath });
}

/**
 * Model-facing tool surface for a phase — only name + `modelDesc` of tools whose
 * folder is live in that phase, honoring `capabilities.phase_overrides`. The model
 * never sees a tool from a folder that isn't live. Empty outside Tauri.
 */
export async function phaseTools(
  projectPath: string,
  phase: Phase,
): Promise<ModelTool[]> {
  if (!hasTauri()) return [];
  return invoke<ModelTool[]>("phase_tools", { projectPath, phase });
}

// ---------- LLM runtime helpers ----------

export type DetectedRuntime = {
  name: string;
  baseUrl: string;
  /** Port responded to `GET /models` — running right now. */
  healthy: boolean;
  /** Present on this machine (CLI binary or app bundle found), running or not. */
  installed: boolean;
  /** AKA started this runtime's server and can stop it (drives the Stop button). */
  managed: boolean;
  /** AKA knows how to boot this runtime headlessly (drives the Play button). */
  launchable: boolean;
};

/**
 * A single piece of message content. Mirrors the OpenAI content-parts surface:
 * vision-capable runtimes accept an array of these (text + images) on the same
 * `/chat/completions` path, with images carried as base64 `data:` URLs.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

export async function detectRuntimes(): Promise<DetectedRuntime[]> {
  if (!hasTauri()) return [];
  return invoke<DetectedRuntime[]>("detect_runtimes");
}

/** Boot a runtime AKA knows how to launch (Ollama, MLX). Throws on spawn failure. */
export async function startRuntime(name: string): Promise<void> {
  if (!hasTauri()) return;
  await invoke("start_runtime", { name });
}

/** Stop a runtime AKA started. Resolves false if AKA wasn't managing it. */
export async function stopRuntime(name: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("stop_runtime", { name });
}

export async function listRuntimeModels(
  baseUrl: string,
  apiKey?: string | null,
): Promise<string[]> {
  if (!hasTauri()) return [];
  return invoke<string[]>("list_models", { baseUrl, apiKey: apiKey ?? null });
}

export async function checkRuntimeHealth(
  baseUrl: string,
  apiKey?: string | null,
): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("check_runtime_health", { baseUrl, apiKey: apiKey ?? null });
}

// ---------- Built-in managed runtime (sidecar) ----------
//
// The ÄKÄ Built-in Runtime is a bundled inference sidecar whose lifecycle the
// Rust backend owns (see src-tauri/src/sidecar.rs). The frontend never spawns
// or addresses it by a hardcoded port — it reads the resolved port via
// `getSidecarPort` and reacts to `runtime:ready` / `runtime:restarting` /
// `runtime:failed` events. It speaks the same OpenAI-compatible surface as
// every other runtime, so the existing llm.rs call path needs no changes.

export type SidecarStatusValue =
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "error";

export type SidecarStatus = {
  status: SidecarStatusValue;
  port: number | null;
  error: string | null;
};

export type GpuType = "apple-silicon" | "nvidia-cuda" | "cpu-only";
export type ModelTier = "light" | "standard" | "pro";

export type HardwareProfile = {
  gpuType: GpuType;
  totalRamGb: number;
  vramGb: number | null;
  recommendedTier: ModelTier;
  gpuLayers: number;
  recommendedThreads: number;
};

/**
 * Unified runtime entry. The built-in runtime (`builtin: true`) always sorts
 * first, is `managed` by ÄKÄ, and cannot be deleted — only disabled. External
 * runtimes (Ollama, LM Studio, …) are unmanaged.
 */
export type RuntimeConnection = {
  id: string;
  name: string;
  endpoint: string;
  managed: boolean;
  builtin: boolean;
  status: "ready" | "starting" | "unreachable" | "restarting" | "error";
  provider: "aka-builtin" | "ollama" | "lmstudio" | "llamacpp" | "custom";
};

export async function getSidecarStatus(): Promise<SidecarStatus> {
  if (!hasTauri()) return { status: "stopped", port: null, error: null };
  return invoke<SidecarStatus>("get_sidecar_status");
}

export async function getSidecarPort(): Promise<number | null> {
  if (!hasTauri()) return null;
  return invoke<number | null>("get_sidecar_port");
}

/** User-initiated restart of the built-in runtime. Resets the crash budget. */
export async function restartRuntime(): Promise<void> {
  if (!hasTauri()) return;
  return invoke("restart_runtime");
}

/**
 * Cancel any in-progress generation on the built-in runtime (POSTs to the
 * sidecar's `/abort`). No-op if the sidecar isn't running. Call before
 * issuing the next request whenever the user stops a generation.
 */
export async function abortRuntime(): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("abort_runtime");
}

/**
 * Explicitly load a model into the built-in runtime (POSTs to the sidecar's
 * `/v1/models/load`). Used by the model browser's "Load" button to preload with
 * a spinner and surface load errors up front. Rejects with the sidecar's error
 * message on failure. Can take tens of seconds for large models.
 */
export async function loadBuiltinModel(filename: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("load_builtin_model", { filename });
}

/** Unload the built-in runtime's current model, freeing its weights. */
export async function unloadBuiltinModel(): Promise<void> {
  if (!hasTauri()) return;
  return invoke("unload_builtin_model");
}

/** Windows opt-in "Performance Mode" — enable CUDA and restart the sidecar. */
export async function enableCudaMode(): Promise<void> {
  if (!hasTauri()) return;
  return invoke("enable_cuda_mode");
}

export async function getHardwareProfile(): Promise<HardwareProfile | null> {
  if (!hasTauri()) return null;
  return invoke<HardwareProfile>("get_hardware_profile");
}

// ---------- Local model management ----------
//
// All model file I/O lives in Rust (src-tauri/src/commands/models.rs). Models
// are `.gguf` files under `<app_data_dir>/models`. Downloads stream from
// HuggingFace and report progress via events.

export type LocalModel = {
  filename: string;
  sizeBytes: number;
};

/** Payload of the `model:download-progress` event. */
export type DownloadProgress = {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
};

/** Payload of the `model:download-complete` event. */
export type DownloadComplete = { filename: string };

/** Payload of the `model:download-error` event (error `"cancelled"` on cancel). */
export type DownloadError = { filename: string; error: string };

export async function listLocalModels(): Promise<LocalModel[]> {
  if (!hasTauri()) return [];
  return invoke<LocalModel[]>("list_local_models");
}

/**
 * Begin downloading `<repo>/<filename>` from HuggingFace. Resolves when the
 * download finishes; progress arrives via the `model:download-*` events.
 */
export async function downloadModel(repo: string, filename: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("download_model", { repo, filename });
}

export async function cancelDownload(filename: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("cancel_download", { filename });
}

export async function deleteModel(filename: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("delete_model", { filename });
}

/** Absolute path of the models directory, for display. Empty in the browser. */
export async function modelsDirPath(): Promise<string> {
  if (!hasTauri()) return "";
  return invoke<string>("models_dir_path");
}

/** Reveal the models directory in the OS file manager (creates it if absent). */
export async function openModelsFolder(): Promise<void> {
  if (!hasTauri()) return;
  return invoke("open_models_folder");
}

/** Copy an arbitrary local `.gguf` into the models directory. Returns the
 *  destination filename. */
export async function importModel(srcPath: string): Promise<string> {
  return invoke<string>("import_model", { srcPath });
}

/** Open the OS picker filtered to `.gguf` files. Returns the chosen path, or
 *  null if cancelled / unavailable in the browser. */
export async function pickGgufFile(): Promise<string | null> {
  if (!hasTauri()) return null;
  const result = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "GGUF models", extensions: ["gguf"] }],
  });
  if (result === null) return null;
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

// HuggingFace discovery — read-only metadata. These only fetch JSON (model ids,
// file names, sizes) from huggingface.co; the actual weights are pulled by
// `downloadModel`, which is `.gguf`-only and host-pinned in Rust.

/** A search hit from the HuggingFace model index. */
export type HfModel = {
  id: string;
  downloads: number;
  likes: number;
};

/** A `.gguf` file inside a repo, with its real (LFS) size. */
export type HfGgufFile = {
  filename: string;
  sizeBytes: number;
  /** One shard of a multi-part model — can't be loaded on its own. */
  sharded: boolean;
};

/** Search HuggingFace for GGUF models, ranked by downloads (max 30). */
export async function hfSearchModels(query: string): Promise<HfModel[]> {
  if (!hasTauri()) return [];
  return invoke<HfModel[]>("hf_search_models", { query });
}

/** List the `.gguf` files in a repo. Accepts `owner/name` or a pasted HF URL. */
export async function hfListGgufFiles(repo: string): Promise<HfGgufFile[]> {
  if (!hasTauri()) return [];
  return invoke<HfGgufFile[]>("hf_list_gguf_files", { repo });
}

/**
 * Call the LLM configured for `projectPath`. The backend reads the runtime
 * block from the project config on every call.
 */
export async function callLlm(
  messages: ChatMessage[],
  projectPath: string,
  model?: string | null,
): Promise<string> {
  if (!hasTauri()) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    return `[Browser preview — no Tauri runtime]\nEcho: ${last?.content ?? "(empty)"}`;
  }
  return invoke<string>("call_llm", {
    messages,
    projectPath,
    model: model ?? null,
  });
}

// ---------- Built-in "None" agent: native tool-calling loop ----------

/** An OpenAI `tools` entry advertised to the model (built host-side). */
export type ToolDef = {
  type: string;
  function: { name: string; description: string; parameters: unknown };
};

/** A tool call the model emitted. `arguments` is a raw JSON string. */
export type ToolCall = {
  id: string;
  type?: string | null;
  function: { name: string; arguments: string };
};

/** One assistant turn in the loop — a final answer, tool calls, or both. */
export type AssistantTurn = {
  content: string | null;
  toolCalls: ToolCall[];
  reasoning: string | null;
};

/** The result of executing one tool call, fed back to the model. */
export type ToolResult = { ok: boolean; content: string };

/** The phase the built-in loop runs at — read-only, +write, +exec. */
export type ToolPhase = "readonly" | "write" | "exec";

/**
 * The model-facing tool manifest for the built-in loop at `phase`. The model can
 * only ever be offered tools that are unlocked at that phase.
 */
export async function builtinToolDefs(phase: ToolPhase): Promise<ToolDef[]> {
  if (!hasTauri()) return [];
  return invoke<ToolDef[]>("builtin_tool_defs", { phase });
}

/**
 * Run one non-streamed native tool-calling turn: the model either calls a tool
 * (returned in `toolCalls`) or gives a final answer (`content`). Cloud egress is
 * gated like every other LLM call.
 */
export async function callLlmTools(
  messages: unknown[],
  tools: ToolDef[],
  projectPath: string,
  model?: string | null,
): Promise<AssistantTurn> {
  if (!hasTauri()) {
    return { content: "[Browser preview — no Tauri runtime]", toolCalls: [], reasoning: null };
  }
  return invoke<AssistantTurn>("call_llm_tools", {
    messages,
    tools,
    projectPath,
    model: model ?? null,
  });
}

/**
 * Execute one model-chosen tool call through the single policy-enforced
 * chokepoint. Resolves to `{ ok:false }` (not a throw) for a denied/malformed
 * call so the loop can recover. `phase` gates which tools may run.
 */
export async function executeBuiltinTool(
  name: string,
  argumentsJson: string,
  projectPath: string,
  phase: ToolPhase,
): Promise<ToolResult> {
  if (!hasTauri()) return { ok: false, content: "No Tauri runtime." };
  return invoke<ToolResult>("execute_builtin_tool", {
    name,
    arguments: argumentsJson,
    projectPath,
    phase,
  });
}

/**
 * Stream a chat completion. Token deltas arrive as `llm://chunk` events
 * (string payload); the stream concludes with `llm://done` on success or
 * `llm://error` on failure. Starting a new stream cancels the previous one.
 * The returned Promise resolves once the server signals end-of-stream.
 */
export async function callLlmStream(
  messages: ChatMessage[],
  projectPath: string,
  model?: string | null,
  /**
   * Stable id for this stream. The backend tags every `llm://chunk` / `llm://done`
   * / `llm://error` event with it so concurrent sessions can route their own
   * stream, and {@link stopLlmStream} can cancel just this one. Omit to have the
   * backend mint one (single-stream / legacy callers).
   */
  runId?: string,
): Promise<void> {
  if (!hasTauri()) {
    // Browser dev fallback — fake a chunked echo so the UI path can be
    // exercised without a Tauri runtime. Emits via the standard event bus,
    // matching the runId-tagged payload shape the real backend uses.
    const rid = runId ?? "";
    const last = [...messages].reverse().find((m) => m.role === "user");
    const text = `[Browser preview — no Tauri runtime] Echo: ${last?.content ?? "(empty)"}`;
    const { emit } = await import("@tauri-apps/api/event").catch(() => ({ emit: null as never }));
    if (typeof emit === "function") {
      for (const ch of text.match(/.{1,8}/g) ?? []) {
        await emit("llm://chunk", { runId: rid, text: ch });
      }
      await emit("llm://done", { runId: rid });
    }
    return;
  }
  return invoke("call_llm_stream", {
    messages,
    projectPath,
    model: model ?? null,
    runId: runId ?? null,
  });
}

/**
 * Stop an LLM stream. Pass the `runId` to cancel just that session's stream;
 * omit it to cancel every live stream (legacy single-stream behaviour).
 */
export async function stopLlmStream(runId?: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("stop_llm_stream", { runId: runId ?? null });
}

/**
 * Runtime config passed explicitly to `summarize_session` — must be the
 * *outgoing* model's runtime, captured before the swap is applied. Never
 * loaded from disk by the backend; the project config may already point at
 * the incoming model at the moment this command runs.
 */
export type SummarizerRuntime = {
  baseUrl: string;
  model: string;
  apiKey: string | null;
};

/**
 * Summarize the current session using the outgoing runtime. Returns a plain
 * string — no markdown, no preamble. The caller is responsible for clearing
 * its history and threading the summary into the new session's system
 * context.
 */
export async function summarizeSession(
  messages: ChatMessage[],
  runtime: SummarizerRuntime,
): Promise<string> {
  return invoke<string>("summarize_session", { messages, runtime });
}

// ---------- Token counter ----------
//
// Both calls are estimates — `count_tokens` is char-length/4 on the JSON
// serialization of the message array, and `get_context_limit` is a static
// family lookup, not a per-quant value. Always present `used` with a "~"
// prefix in the UI.

export type MemoryUsage = {
  /** AKA desktop-app process RSS in MB. */
  appMb: number;
  /**
   * Loaded-model footprint in MB. Built-in runtime: GGUF size from the sidecar
   * `/metrics`; Ollama: sum from `/api/ps`. 0 when unavailable.
   */
  modelMb: number;
  /** appMb + modelMb. */
  totalMb: number;
  /**
   * Built-in runtime's allocated context window (tokens), from `/metrics`.
   * null for external runtimes.
   */
  ctxSize?: number | null;
  /**
   * Built-in runtime's last-generation decode rate (tokens/sec), from
   * `/metrics`. null for external runtimes or before any generation.
   */
  lastTokensPerSec?: number | null;
};

/**
 * Returns AKA's own process RSS (via `ps`) and, when the runtime is an Ollama
 * endpoint, the total in-RAM model footprint from `/api/ps`. All values in MB.
 * Fails gracefully — returns zeros when the commands are unavailable.
 */
export async function getMemoryUsage(
  runtimeBaseUrl?: string | null,
): Promise<MemoryUsage> {
  if (!hasTauri()) return { appMb: 0, modelMb: 0, totalMb: 0 };
  return invoke<MemoryUsage>("get_memory_usage", {
    runtimeBaseUrl: runtimeBaseUrl ?? null,
  });
}

export async function countTokens(messages: ChatMessage[]): Promise<number> {
  if (!hasTauri()) {
    // Browser dev fallback — match the Rust side's char/4 heuristic.
    return Math.floor(JSON.stringify(messages).length / 4);
  }
  return invoke<number>("count_tokens", { messages });
}

export async function getContextLimit(model: string): Promise<number> {
  if (!hasTauri()) {
    const m = model.toLowerCase();
    if (m.includes("gemma")) return 128_000;
    if (m.includes("llama3") || m.includes("llama-3")) return 128_000;
    if (m.includes("deepseek")) return 128_000;
    if (m.includes("phi-4") || m.includes("phi4") || m.includes("phi-3.5")) return 128_000;
    if (m.includes("phi-3") || m.includes("phi3")) return 4_096;
    if (m.includes("qwen")) return 32_768;
    if (m.includes("mistral") || m.includes("mixtral")) return 32_768;
    return 32_768;
  }
  return invoke<number>("get_context_limit", { model });
}

// ---------- Files (read / write / watch) ----------
//
// Used by editable Markdown panes. The agent edits files on disk via its own
// tools — AKA never patches the file directly from the editor. The watcher
// emits `file://changed` whenever an external write moves the mtime, so the
// pane can reload or surface a conflict.

export type FilePayload = {
  path: string;
  contents: string;
  mtimeMs: number;
};

export async function readTextFile(path: string): Promise<FilePayload> {
  return invoke<FilePayload>("read_text_file", { path });
}

/**
 * Read an image file and return it as an OpenAI-compatible `data:` URL
 * (`data:<mime>;base64,<payload>`), ready to drop into an `image_url` content
 * part for a vision-capable model. Returns "" in browser dev (no Tauri).
 */
export async function readImageBase64(path: string): Promise<string> {
  if (!hasTauri()) return "";
  return invoke<string>("read_image_base64", { path });
}

export async function writeTextFile(
  path: string,
  contents: string,
): Promise<number> {
  return invoke<number>("write_text_file", { path, contents });
}

export async function watchFile(path: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("watch_file", { path });
}

export async function unwatchFile(path: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("unwatch_file", { path });
}

/**
 * Watch a whole project directory for changes. Emits `project://changed`
 * (debounced by the caller) whenever any non-noise file under `path` is
 * created or modified — used by the Preview pane to auto-refresh the rendered
 * app after the user or an agent edits files. Re-watching the same path
 * replaces the previous watcher.
 */
export async function watchDir(path: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("watch_dir", { path });
}

export async function unwatchDir(path: string): Promise<void> {
  if (!hasTauri()) return;
  return invoke("unwatch_dir", { path });
}

export type DirEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
};

/** List immediate children of a directory. Hides common noise (.git, node_modules, etc.). */
export async function listDir(path: string): Promise<DirEntry[]> {
  if (!hasTauri()) return [];
  return invoke<DirEntry[]>("list_dir", { path });
}

/**
 * Count newlines in a file, or recursively across all files in a directory.
 * Files > 10 MiB and unreadable paths count as 0.
 */
export async function countLines(path: string): Promise<number> {
  if (!hasTauri()) return 0;
  return invoke<number>("count_lines", { path });
}

// ---------- Interactive shell (Console pane) ----------

/**
 * Run a free-form shell line inside the project sandbox. Streams stdout /
 * stderr as `shell://output` events and emits `shell://done` on exit.
 * Throws when the project path is empty / outside the sandbox / when the
 * child can't spawn.
 */
export async function runShellCommand(
  projectPath: string,
  cmd: string,
): Promise<void> {
  return invoke("shell_run", { projectPath, cmd });
}

/** Kill the currently-running shell command. Returns false if nothing was running. */
export async function stopShellCommand(): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("shell_stop");
}

// ---------- Diff ----------

/**
 * Run `git diff --no-color HEAD` inside the project. Returns the raw unified
 * diff as a single string (empty when the working tree matches HEAD). Throws
 * a string error when the path isn't a git repo or git itself fails.
 */
export async function gitDiff(
  projectPath: string,
  filePath?: string,
): Promise<string> {
  if (!hasTauri()) return "";
  return invoke<string>("git_diff", {
    projectPath,
    filePath: filePath ?? null,
  });
}

// ---------- Dev server ----------
//
// Long-lived process for the project's dev/preview server (Vite, Next, Rails,
// whatever). The command itself is per-project — read from `dev_server.cmd`
// in the project config. UI prompts for it the first time the user clicks
// Start and then persists the answer.

export type DevServerStatus = { running: boolean };

export async function startDevServer(projectPath: string): Promise<void> {
  return invoke("start_dev_server", { projectPath });
}

export async function stopDevServer(): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("stop_dev_server");
}

export async function devServerStatus(): Promise<DevServerStatus> {
  if (!hasTauri()) return { running: false };
  return invoke<DevServerStatus>("dev_server_status");
}

/**
 * Force-kill every process listening on `port`. Resolves to the number of
 * PIDs killed (0 if the port was already free). Backs the Preview pane's
 * "Kill port & restart" button — used when the dev server fails to start
 * because something else still owns the address.
 */
export async function killPort(port: number): Promise<number> {
  if (!hasTauri()) return 0;
  return invoke<number>("kill_port", { port });
}

/**
 * Wipe the webview's HTTP cache and browsing data. Backs the Preview pane's
 * hard reload (⇧-click on Reload) — clears stale cached JS/CSS that a dev
 * server without no-cache headers can otherwise keep serving to the iframe.
 */
export async function clearWebviewCache(): Promise<void> {
  if (!hasTauri()) return;
  return invoke("clear_webview_cache");
}

// ---------- Shell ----------

/**
 * Open `url` in the user's default OS browser. The browser pane uses this
 * for its "Open in browser" button so users can hand a localhost dev server
 * off to Chrome/Safari/Firefox (DevTools, extensions, viewport debugging).
 * In the browser dev fallback, opens in a new tab.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!hasTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  return invoke("open_external_url", { url });
}
