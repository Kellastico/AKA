## AKA 1.4.4

The release that makes AKA **actually installable**. Every macOS build before this
was unsigned, so downloading the `.dmg` and double-clicking gave *"the disk image
is corrupted"* — Gatekeeper refusing an un-notarized app, not a broken file. This
build is **signed with a Developer ID and notarized by Apple**: download, open,
drag to Applications. No right-click, no Terminal, no `xattr` incantation. Plus the
first slice of in-app model tuning.

### ✅ macOS: it just opens now
- **Signed + notarized.** The app and its bundled sidecars (`aka-runtime`,
  `aka-tool`) are signed with a Developer ID Application certificate under the
  hardened runtime, and the DMG is notarized and stapled. A fresh download opens
  on a plain double-click on any recent macOS.
- **Hardened runtime, without breaking orchestration.** AKA's whole job is
  launching *your* agents and local model runtimes — binaries Apple never signed.
  A tuned entitlements set (`disable-library-validation`, dyld-env,
  JIT/unsigned-exec for the webview) keeps those child processes alive under the
  hardened runtime. Notarization still passes.
- **CI signs every future build.** The release workflow re-enables the Apple
  signing + notarization path, gated so unsigned fallback still builds if the
  secrets are ever absent.

### 🎛️ Model tuning, in the app
- **Temperature + Top-P sliders** live in the Runtime modal under a new
  **Advanced Settings** accordion (collapsed by default — beginners never trip
  over them). Temperature runs Precise → Creative (0–2); Top-P narrows or widens
  nucleus sampling. Both write to `runtime.temperature` / `runtime.top_p` in
  `.äkä/config.json` and apply on the next run, no restart.
- **"Auto" tells the truth.** An unset slider parks its thumb at the exact value
  the model will actually receive — AKA's accuracy-leaning defaults
  (temperature **0.15** · top-p **0.9**), mirrored 1:1 with the backend — and
  dims to signal "not overridden yet." **Reset** restores that default rather
  than a made-up zero.

### 🧹 Also in this build
- **New `capture-window` tool.** An agent can screenshot AKA's own window; the
  result renders as a picture inline in the output console instead of a bare
  filename. It lives in the **deny-by-default `exec` folder** — self-gated, so it
  refuses unless you've granted it. (On macOS the first capture triggers the OS
  Screen Recording prompt — a guarantee enforced by the OS, not something the
  tool can suppress.)
- **Advanced Settings groups the knobs.** The Network Allowlist now lives beside
  the sampling sliders under Advanced Settings instead of floating loose in the
  Runtime modal. One shared `Disclosure` component (flat row + boxed variants)
  backs every accordion in the app.
- **Plugins pill adapts to width.** On narrow windows it collapses to icon-only
  and brings its name back as a hover tooltip, so it can't crowd the centered
  omnibox.
- **More of the chrome drags the window.** The empty gaps around the top bar and
  the Projects rail are now `data-tauri-drag-region` surfaces — the macOS
  click-and-drag-anywhere feel.
- **Fixed an allowlist render loop.** The empty-state selector returned a fresh
  `[]` each render, tripping zustand's snapshot cache into a re-render loop; it
  now returns a stable reference.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.4.4_aarch64.dmg` — signed + notarized, opens on double-click.
- **Windows** → `AKA_1.4.4_x64-setup.exe`
- **Linux** → `AKA_1.4.4_amd64.AppImage` (portable) · `AKA_1.4.4_amd64.deb` (Debian/Ubuntu) · `AKA-1.4.4-1.x86_64.rpm` (Fedora/RHEL)

On **Windows**, if SmartScreen warns, **More info → Run anyway** (the Windows build is not yet code-signed). The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.4.4_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.4.3...v1.4.4
