import { describe, expect, it } from "vitest";
import {
  extractBusyPort,
  humanizeError,
  isPortInUseError,
} from "../humanize-error";

// The exact shape Vite prints when strictPort is set (or a port it tries is
// held) — this is the failure from the bug report. Note "is already in use".
const VITE_PORT_ALREADY_IN_USE = `
> vite

error when starting dev server:
Error: Port 5174 is already in use
    at httpServerStart (node_modules/vite/dist/node/chunks/node.js:10661:10)
`.trim();

const NEXT_ORPHAN_STDERR = `
> myapp@0.1.0 dev
> next dev

⚠ Port 3000 is in use by process 73931, using available port 3001 instead.
▲ Next.js 16.2.4 (Turbopack)
- Local: http://localhost:3001
✓ Ready in 505ms

x Another next dev server is already running.

- Local: http://localhost:3000
- PID: 73931
- Dir: /Users/dev/projects/myapp
- Log: .next/dev/logs/next-development.log

Run kill 73931 to stop it.
`.trim();

const VITE_PORT_IN_USE = `
[vite] http server error: Error: listen EADDRINUSE: address already in use 127.0.0.1:5173
    at Server.setupListenHandle [as _listen2] (node:net:1817:16)
`.trim();

const PY_PORT_IN_USE_MAC = `
Traceback (most recent call last):
  File "/usr/lib/python3.11/socketserver.py", line 458, in __init__
    self.server_bind()
OSError: [Errno 48] Address already in use
`.trim();

const PY_PORT_IN_USE_LINUX = `
OSError: [Errno 98] Address already in use
`.trim();

const NODE_EADDR = `Error: listen EADDRINUSE: address already in use :::3000`;

const MISSING_PACKAGE_JSON = `npm error code ENOENT
npm error syscall open
npm error path /Users/foo/proj/package.json
npm error errno -2
npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/Users/foo/proj/package.json'`;

const NOT_A_GIT_REPO = `fatal: not a git repository (or any of the parent directories): .git`;

const STDIN_EOF = `EOFError: EOF when reading a line`;

const CMD_NOT_FOUND = `bash: aider: command not found`;

const LIBRESSL_WARNING = `/usr/lib/python3/dist-packages/urllib3/__init__.py:35: NotOpenSSLWarning: urllib3 v2 only supports OpenSSL 1.1.1+, currently the 'ssl' module is compiled with 'LibreSSL 3.3.6'. See: https://github.com/urllib3/urllib3/issues/3020
  warnings.warn(`;

const LITELLM_NO_PROVIDER = `litellm.BadRequestError: LLM Provider NOT provided. Pass in the LLM provider you are trying to call.`;

const MODEL_NOT_REGISTERED = `ProviderModelNotFoundError: Model not found: qwen3.5:9b. Did you mean: gpt-4o-mini`;

const AGENT_PATH_AS_PROMPT = `OSError: [Errno 63] File name too long: 'Build a simple TODO app with vanilla HTML/CSS/JS'`;

describe("humanizeError", () => {
  it("returns null for empty stderr", () => {
    expect(humanizeError("")).toBeNull();
    expect(humanizeError("   \n   ")).toBeNull();
  });

  it("returns null for unrecognised stderr", () => {
    expect(humanizeError("some totally novel runtime panic xyzzy")).toBeNull();
  });

  it("recognises Next.js orphan dev-server and captures the PID in the hint", () => {
    const out = humanizeError(NEXT_ORPHAN_STDERR);
    expect(out).not.toBeNull();
    expect(out!.title).toMatch(/previous Next\.js dev server/i);
    expect(out!.hint).toContain("73931");
  });

  it("recognises Vite EADDRINUSE", () => {
    const out = humanizeError(VITE_PORT_IN_USE);
    expect(out?.title).toMatch(/port .* in use/i);
  });

  it("recognises Vite's 'Port N is already in use' wording and names the port", () => {
    const out = humanizeError(VITE_PORT_ALREADY_IN_USE);
    expect(out?.title).toMatch(/port 5174 is already in use/i);
    expect(out?.hint).toContain("5174");
  });

  it("recognises Python OSError 48 (macOS)", () => {
    const out = humanizeError(PY_PORT_IN_USE_MAC);
    expect(out?.title).toMatch(/port .* in use/i);
  });

  it("recognises Python OSError 98 (Linux)", () => {
    const out = humanizeError(PY_PORT_IN_USE_LINUX);
    expect(out?.title).toMatch(/port .* in use/i);
  });

  it("recognises Node EADDRINUSE", () => {
    const out = humanizeError(NODE_EADDR);
    expect(out?.title).toMatch(/port .* in use/i);
  });

  it("recognises ENOENT on package.json", () => {
    const out = humanizeError(MISSING_PACKAGE_JSON);
    expect(out?.title).toMatch(/package\.json/i);
  });

  it("recognises a non-git folder", () => {
    const out = humanizeError(NOT_A_GIT_REPO);
    expect(out?.title).toMatch(/git/i);
  });

  it("recognises stdin EOF (interactive prompt) errors", () => {
    const out = humanizeError(STDIN_EOF);
    expect(out?.title).toMatch(/stdin/i);
  });

  it("recognises bash command-not-found and names the binary", () => {
    expect(humanizeError("bash: aider: command not found")?.title).toContain("aider");
  });

  it("recognises zsh command-not-found (binary after the phrase)", () => {
    expect(humanizeError("zsh: command not found: opencode")?.title).toContain("opencode");
  });

  it("recognises env-style exec failure", () => {
    expect(
      humanizeError("env: 'aider': No such file or directory")?.title,
    ).toContain("aider");
  });

  it("recognises the LibreSSL urllib3 warning", () => {
    const out = humanizeError(LIBRESSL_WARNING);
    expect(out?.title).toMatch(/libressl/i);
  });

  it("recognises litellm 'no provider' error", () => {
    const out = humanizeError(LITELLM_NO_PROVIDER);
    expect(out?.title).toMatch(/provider/i);
  });

  it("recognises an agent's 'model not registered' error", () => {
    const out = humanizeError(MODEL_NOT_REGISTERED);
    expect(out?.title).toMatch(/registered/i);
  });

  it("recognises the 'prompt sent as file path' agent bug", () => {
    const out = humanizeError(AGENT_PATH_AS_PROMPT);
    expect(out?.title).toMatch(/file path/i);
  });

  it("prefers the Next-orphan rule over the generic port-in-use rule", () => {
    // The Next orphan stderr also contains 'Port 3000 is in use' earlier on,
    // but that phrasing doesn't match the EADDRINUSE/address-already-in-use
    // regex so the more specific Next rule wins cleanly. This is a guard
    // against someone broadening the generic regex later and silently
    // stealing the match.
    const out = humanizeError(NEXT_ORPHAN_STDERR);
    expect(out?.title).not.toMatch(/that port is already in use/i);
  });
});

describe("isPortInUseError", () => {
  it("matches EADDRINUSE", () => {
    expect(isPortInUseError(VITE_PORT_IN_USE)).toBe(true);
    expect(isPortInUseError(NODE_EADDR)).toBe(true);
  });

  it("matches macOS Errno 48", () => {
    expect(isPortInUseError(PY_PORT_IN_USE_MAC)).toBe(true);
  });

  it("matches Linux Errno 98", () => {
    expect(isPortInUseError(PY_PORT_IN_USE_LINUX)).toBe(true);
  });

  it("matches the generic 'address already in use' phrasing", () => {
    expect(isPortInUseError("listen EADDRINUSE: address already in use")).toBe(true);
  });

  it("returns false for the Next-orphan case (port rolled forward, then quit)", () => {
    // The orphan-dev-server scenario is NOT a port conflict in the kill-port
    // sense — Next already grabbed a free port, then voluntarily exited.
    // Killing the URL bar's port wouldn't help. This is exactly the case
    // that motivated gating the Kill-port button on this predicate.
    expect(isPortInUseError(NEXT_ORPHAN_STDERR)).toBe(false);
  });

  it("matches Vite's 'Port N is already in use' wording", () => {
    expect(isPortInUseError(VITE_PORT_ALREADY_IN_USE)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPortInUseError(MISSING_PACKAGE_JSON)).toBe(false);
    expect(isPortInUseError(NOT_A_GIT_REPO)).toBe(false);
    expect(isPortInUseError(CMD_NOT_FOUND)).toBe(false);
    expect(isPortInUseError("")).toBe(false);
  });
});

describe("extractBusyPort", () => {
  it("pulls the port from Vite's 'Port N is already in use'", () => {
    expect(extractBusyPort(VITE_PORT_ALREADY_IN_USE)).toBe(5174);
  });

  it("pulls the port from a Node EADDRINUSE address (host:port)", () => {
    expect(extractBusyPort(VITE_PORT_IN_USE)).toBe(5173);
  });

  it("pulls the port from a Node EADDRINUSE address (:::port)", () => {
    expect(extractBusyPort(NODE_EADDR)).toBe(3000);
  });

  it("returns null when the error carries no port (Python [Errno 48])", () => {
    expect(extractBusyPort(PY_PORT_IN_USE_MAC)).toBeNull();
  });

  it("returns null for unrelated errors", () => {
    expect(extractBusyPort(NOT_A_GIT_REPO)).toBeNull();
    expect(extractBusyPort("")).toBeNull();
  });
});
