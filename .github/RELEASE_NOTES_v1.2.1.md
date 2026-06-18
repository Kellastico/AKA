## AKA 1.2.1

Windows and Linux are back. Same 1.2.0 app — this release just restores the
multi-platform installers that 1.2.0 missed.

### ✨ Added
- **Windows and Linux builds.** 1.2.0 went out macOS-only because the release
  pipeline couldn't bundle the new `aka-tool` shim for non-macOS targets. CI now
  builds it per platform, so the Windows (`.exe` / `.msi`) and Linux
  (`.AppImage` / `.deb` / `.rpm`) installers ship again.

Everything else is identical to
[1.2.0](https://github.com/Kellastico/AKA/releases/tag/v1.2.0) — overridable
built-in tools, smarter local-runtime detection, and the ANSI fix.

---

**Install:** macOS (Apple Silicon) → `AKA_1.2.1_aarch64.dmg` · Windows →
`AKA_1.2.1_x64-setup.exe` · Linux → `AKA_1.2.1_amd64.AppImage`. Unsigned build —
on macOS, right-click the app → **Open**.

**Full changelog:** https://github.com/Kellastico/AKA/blob/main/CHANGELOG.md
**Compare:** https://github.com/Kellastico/AKA/compare/v1.2.0...v1.2.1
