/**
 * Concurrency policy for running multiple sessions at once.
 *
 * AKA used to allow only one running session at a time. That cap is being
 * lifted — but on memory-constrained machines, running several sessions
 * against *different* models is the path to a swap-storm or an OOM crash,
 * because each distinct model loads its own weights. Running them against the
 * *same* model is cheap: the model server holds one copy of the weights and
 * shares it.
 *
 * This module is the single, pure (no React, no store) source of truth for two
 * decisions:
 *   - `gateForRun`        — may a session start a run now, or do we warn first?
 *   - `adviceForNewSession` — should we nudge the user to reuse their model when
 *                             they spin up another session?
 *
 * Keeping it pure makes the policy trivially unit-testable; callers read live
 * state from the stores and feed it in.
 */

/** The RAM tier (GB) at or below which we treat a machine as "limited". */
export const LIMITED_RAM_GB = 16;

// RAM read back as an f32 for a nominal "16 GB" machine lands right around 16.0
// (give or take rounding); the next common memory tier is 18 GB. A 17 GB cutoff
// reliably captures every ≤16 GB machine without ever catching an 18 GB+ one.
const LIMITED_RAM_CUTOFF_GB = 17;

/**
 * True when total RAM is known and small enough that loading multiple distinct
 * models could realistically overwhelm the machine. Unknown/zero RAM (no
 * hardware probe yet) is treated as *not* limited — we never warn on missing
 * data.
 */
export function isLimitedHardware(totalRamGb: number | null | undefined): boolean {
  return totalRamGb != null && totalRamGb > 0 && totalRamGb < LIMITED_RAM_CUTOFF_GB;
}

/** A session that currently has a run in flight, plus the model it's using. */
export type RunningSession = { sessionId: string; modelId: string | null };

/**
 * The verdict for an attempted run.
 *  - `allow`     — start immediately, no modal.
 *  - `warn-ram`  — limited hardware + a concurrent run on a *different* model:
 *                  show the big (non-restrictive) RAM warning before starting.
 */
export type RunGate =
  | { kind: "allow" }
  | { kind: "warn-ram"; runningModels: string[]; incomingModelId: string | null };

/** Distinct, non-null model ids across the running sessions, in first-seen order. */
function uniqueModels(running: RunningSession[]): string[] {
  return [...new Set(running.map((s) => s.modelId).filter((m): m is string => !!m))];
}

/**
 * True when every running session is on the *same* model as the incoming run.
 * A null incoming model can't be confirmed as a match, so it counts as a
 * divergence (the run flow always has a selected model by the time it gets
 * here, but we stay defensive).
 */
export function allSameModel(
  running: RunningSession[],
  incomingModelId: string | null,
): boolean {
  return (
    incomingModelId != null &&
    running.length > 0 &&
    running.every((s) => s.modelId === incomingModelId)
  );
}

/**
 * Decide whether a session may start a run, given what else is already running
 * and how much memory the machine has.
 *
 * The warning only fires for the genuinely risky case: a memory-limited machine
 * about to hold a *second distinct model* in memory. Roomy machines, the first
 * run, and same-model concurrency all pass straight through.
 */
export function gateForRun(input: {
  totalRamGb: number | null | undefined;
  runningSessions: RunningSession[];
  incomingModelId: string | null;
}): RunGate {
  const { totalRamGb, runningSessions, incomingModelId } = input;
  // No concurrency → nothing to weigh.
  if (runningSessions.length === 0) return { kind: "allow" };
  // Warnings are a small-machine safety net; roomy machines run whatever.
  if (!isLimitedHardware(totalRamGb)) return { kind: "allow" };
  // One shared model across all sessions = one copy of the weights = cheap.
  if (allSameModel(runningSessions, incomingModelId)) return { kind: "allow" };
  // Limited RAM + a different model loading alongside the running one(s).
  return { kind: "warn-ram", runningModels: uniqueModels(runningSessions), incomingModelId };
}

/**
 * Whether to surface the "reuse your current model" advice when the user spins
 * up another session. Only relevant when a concurrent run is actually live on a
 * memory-constrained machine — otherwise the tip is noise.
 */
export function adviceForNewSession(input: {
  totalRamGb: number | null | undefined;
  runningSessions: RunningSession[];
}): boolean {
  return isLimitedHardware(input.totalRamGb) && input.runningSessions.length > 0;
}
