# ÄKÄ — Product Page Content & Prompt

> **How to use this file:** Paste the whole thing into your prompt and say something like
> *"Update the product page using the content below — keep the section structure, match the existing component styles."*
> Each block is written as ready-to-use copy. Edit any block freely; the headings map to standard product-page sections.

---

## Prompt instruction (edit to taste)

You are updating the ÄKÄ product page. Use the copy in this document as the source of truth for messaging.
- Keep the brand as **ÄKÄ** (umlauts + ™ in the hero/logo); use "AKA" only if the page already does.
- Preserve the existing visual system (yellow/dark theme, Phosphor icons).
- Map each section below to a page section: Hero → top, Synopsis → intro, Positioning → "the idea", Core Features → feature grid, Unique Angle → differentiator block, Availability → download, Pricing → footer.
- Don't invent features that aren't listed here.

---

## Hero

**Local-first. Task-driven. An agnostic ADE that is fully yours.**

Sub-line options:
- Your workflow. Your tools. Your machine.
- The environment layer for AI coding — bring any model, keep full control.

CTAs: `View on GitHub` · `Download for Mac`

---

## One-paragraph synopsis

ÄKÄ is a local-first, task-driven Agentic Development Environment (ADE). Instead of bundling a model and an editor like everyone else, ÄKÄ sits *on top of* whatever AI toolchain you already use — any OpenAI-compatible endpoint, local models via Ollama, or your own custom agents. It handles the parts the model shouldn't: task structure, step-by-step approval, diff review, and context management. You describe the work, pick your model and agent, launch, review the diff, and approve or reject — every change passes through you before it lands. Nothing leaves your machine unless you send it.

---

## Positioning ("The Idea")

Most tools — Cursor, Copilot, and their peers — decide the AI for you by welding the model to the environment. That's a constraint, not a feature. ÄKÄ keeps those concerns separate so you own your stack. It's an environment layer, not another AI tool: connect your preferred LLM or agent, define your tasks, and ÄKÄ orchestrates the workflow with diff views, approval gates, and session continuity built in. Native app, built on Tauri. Any model. Human in the loop.

Three-column version:

| WHAT | WHY | HOW |
|------|-----|-----|
| **An environment layer, not another AI tool.** ÄKÄ sits on top of any AI toolchain you already use. It handles task structure, step approval, and context management — so the model can focus on the code. | **Most tools decide the AI for you. ÄKÄ doesn't.** Cursor, Copilot, and their peers bundle the model with the environment. That's a constraint, not a feature. ÄKÄ keeps those concerns separate so you own your stack. | **Native app. Any model. Human in the loop.** Built on Tauri. Connect your preferred LLM or agent, define your tasks, and ÄKÄ orchestrates the workflow with diff views, approval gates, and session continuity built in. |

---

## Core features

- **LLM & Agent Agnostic** — Works with any OpenAI-compatible endpoint, local models via Ollama, or custom agents. Swap providers without changing your workflow.
- **Human-in-the-Loop** — Pause, review, approve, or reject every agent step before it executes. You stay in control at every decision point.
- **Local First** — Your code, your context, your machine. Nothing leaves your environment unless you explicitly send it. No telemetry, no cloud sync.
- **Diff Viewer** — Every proposed change is shown as a clean, navigable diff. Accept selectively or reject entirely before anything lands.
- **Session Continuity** — Automatic context summarization keeps sessions alive across long tasks and model swaps — no more losing your place.
- **Open Source** — Apache 2.0 licensed. Fork it, extend it, audit it. Public codebase, contributions welcome.

---

## What makes it different (unique angle)

- **It doesn't pick your AI for you.** ÄKÄ is the only piece that stays constant while your model, provider, and agent are all swappable.
- **Task-first, not chat-first.** A work-dispatch tool — describe what you want built, dispatch it, review the result — not another chat box.
- **Approval gates on every step.** Human-in-the-loop isn't a setting; it's the default path. Nothing executes or lands without your sign-off.
- **Truly local & private.** No account, no telemetry, no cloud sync — runs entirely on your machine.
- **Continuity across model swaps.** Switch the underlying model mid-task and keep your session and context intact.

---

## Availability

Free desktop app for:
- **macOS** — Apple Silicon (.dmg, arm64) and Intel (.dmg, x86_64)
- **Windows** — 64-bit (.exe)
- **Linux** — AppImage / .deb (x86_64)

Or build from source on GitHub.

---

## Pricing / footer line

**Free forever. No account required. Runs entirely on your machine.** Open source, Apache 2.0. Built for developers.

---

## Latest release (for changelog/"What's New" block)

**v0.1.0 — Initial Release · May 2026**
- Task-driven LLM orchestration with human-in-the-loop step approval
- Connect any OpenAI-compatible endpoint or local model via Ollama
- Real-time diff viewer — accept or reject every file change before it lands
- Session continuity with automatic context summarization across model swaps
- Native desktop app for macOS (Apple Silicon + Intel), Windows, and Linux
