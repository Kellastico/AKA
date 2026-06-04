import { describe, expect, it } from "vitest";
import { findFix } from "../error-fixes";

const NEXT_ORPHAN_STDERR = `
x Another next dev server is already running.

- Local: http://localhost:3000
- PID: 73931
- Dir: /Users/dev/projects/myapp
- Log: .next/dev/logs/next-development.log

Run kill 73931 to stop it.
`.trim();

const NEXT_ORPHAN_NO_PID = `x Another next dev server is already running.`;

const PORT_8000_PYTHON = `OSError: [Errno 48] Address already in use`;

const LIBRESSL = `NotOpenSSLWarning: urllib3 v2 only supports OpenSSL 1.1.1+, currently the 'ssl' module is compiled with 'LibreSSL 3.3.6'.`;

const NOT_GIT = `fatal: not a git repository (or any of the parent directories): .git`;

describe("findFix", () => {
  it("returns null for unrecognised stderr", () => {
    expect(findFix("xyzzy boom")).toBeNull();
    expect(findFix("")).toBeNull();
  });

  describe("Next.js orphan dev-server", () => {
    it("matches and resolves the PID into a runnable kill command", () => {
      const fix = findFix(NEXT_ORPHAN_STDERR);
      expect(fix).not.toBeNull();
      expect(fix!.id).toBe("next-orphan-dev-server");
      expect(fix!.title).toContain("73931");
      expect(fix!.commands).toHaveLength(1);
      expect(fix!.commands[0]).toMatch(/^kill 73931/);
      // Graceful TERM first, SIGKILL fallback — both must mention the PID
      // explicitly so the user can see exactly what will run before
      // confirming the fix.
      expect(fix!.commands[0]).toContain("kill -9 73931");
    });

    it("refuses to offer the fix without a parseable PID", () => {
      // The marker phrase alone is not enough — without a PID, the kill
      // command would be useless. The match function should reject this.
      const fix = findFix(NEXT_ORPHAN_NO_PID);
      expect(fix?.id).not.toBe("next-orphan-dev-server");
    });

    it("never exposes the placeholder '<pid>' command to callers", () => {
      // Defensive check on the dynamic-merge in findFix: if a future change
      // breaks the override, the literal "<pid>" placeholder would leak
      // through and the confirm sheet would show "kill <pid>" — a bug we
      // don't want to ship silently.
      const fix = findFix(NEXT_ORPHAN_STDERR);
      expect(fix!.commands.join(" ")).not.toContain("<pid>");
    });
  });

  describe("Static fixes (no dynamic hook)", () => {
    it("matches Python port-in-use to the port-8000 freer", () => {
      const fix = findFix(PORT_8000_PYTHON);
      expect(fix?.id).toBe("port-in-use-8000");
    });

    it("matches LibreSSL warning to the Homebrew Python swap", () => {
      const fix = findFix(LIBRESSL);
      expect(fix?.id).toBe("libressl-python");
    });

    it("matches non-git folder to git init", () => {
      const fix = findFix(NOT_GIT);
      expect(fix?.id).toBe("git-not-initialised");
    });
  });

  describe("Specificity ordering", () => {
    it("prefers the Next-orphan fix over the generic port freer when both could match", () => {
      // Construct a stderr that contains BOTH the orphan marker (with PID)
      // and the generic 'address already in use' phrasing. The more
      // specific Next entry is registered first, so it should win.
      const mixed = `${NEXT_ORPHAN_STDERR}\n\nAlso: address already in use`;
      const fix = findFix(mixed);
      expect(fix?.id).toBe("next-orphan-dev-server");
    });
  });
});
