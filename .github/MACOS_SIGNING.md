# macOS code signing & notarization

Why: AKA's macOS builds were **ad-hoc signed** (`signingIdentity: "-"`), so every
browser download triggered *"The disk image couldn't be opened — the disk image
is corrupted."* That message is Gatekeeper refusing an un-notarized, quarantined
app — not real corruption. Proper **Developer ID signing + Apple notarization**
makes the DMG open on a plain double-click, in any browser, with no Terminal.

The workflow ([release.yml](workflows/release.yml)) already passes the env vars
below to `tauri-action`; you just need to add the six **GitHub repo secrets**.
Until they're set, macOS builds fall back to unsigned and the workflow still runs.

## One-time prerequisites
- An **Apple Developer Program** membership ($99/yr) — required for Developer ID certs.

## 1. Create a "Developer ID Application" certificate
Easiest via Xcode: **Xcode → Settings → Accounts → (your team) → Manage
Certificates → + → Developer ID Application**. It lands in your login keychain.

(CLI alternative: create a CSR in **Keychain Access → Certificate Assistant →
Request a Certificate from a Certificate Authority**, upload it at
developer.apple.com → Certificates → **+** → Developer ID Application, download
and double-click the resulting `.cer`.)

## 2. Export the cert as a password-protected `.p12`
In **Keychain Access**, find *"Developer ID Application: …"*, expand it so the
**private key** is included, right-click → **Export** → `.p12`, set a password.

Then base64-encode it (this string is the `APPLE_CERTIFICATE` secret):
```bash
base64 -i DeveloperID.p12 | pbcopy   # now in your clipboard
```

## 3. Read your signing identity string
```bash
security find-identity -v -p codesigning
# copy the full quoted name, e.g.  Developer ID Application: Jane Doe (AB12CD34EF)
```
The 10-char value in parentheses is your **Team ID**.

## 4. Create an app-specific password (for notarization)
appleid.apple.com → **Sign-In and Security → App-Specific Passwords → +**.
This is `APPLE_PASSWORD`; `APPLE_ID` is your Apple ID email.

## 5. Add the six GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `APPLE_CERTIFICATE` | base64 of the `.p12` (step 2) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password (step 2) |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` (step 3) |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | app-specific password (step 4) |
| `APPLE_TEAM_ID` | the 10-char Team ID (step 3) |

## 6. Cut a release
Tag a new version (e.g. `v1.3.7`) as usual. The macOS legs will sign with the
Developer ID, notarize via `notarytool`, and staple the ticket. Verify a built
DMG with:
```bash
spctl -a -t open --context context:primary-signature -v AKA_1.3.7_aarch64.dmg
# expecting: "accepted   source=Notarized Developer ID"
```

> Note: the bundled sidecars (`aka-runtime`, `aka-tool`, declared in
> `externalBin`) are signed by the Tauri bundler with the same identity +
> hardened runtime. If notarization ever rejects a nested binary, add an
> entitlements file under `bundle.macOS.entitlements` and re-run.

## Hardened-runtime entitlements

`bundle.macOS.entitlements` points at `src-tauri/entitlements.plist`. Notarization
requires the hardened runtime, and these four exceptions are what let a hardened
AKA still do its job:

| Entitlement | Why AKA needs it |
|-------------|------------------|
| `com.apple.security.cs.allow-jit` | WKWebView's JavaScript JIT. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | WKWebView JS engine. |
| `com.apple.security.cs.disable-library-validation` | AKA is an orchestrator — it launches the user's **own** agents and local model runtimes, which are not signed by our Team ID. Without this, the hardened runtime kills those child processes. |
| `com.apple.security.cs.allow-dyld-environment-variables` | Sidecars/agents are spawned with a customized environment (PATH, model/runtime vars). |

> ⚠️ Keep `entitlements.plist` **comment-free**. Apple's entitlements parser
> (AMFI) is not a full XML parser and fails on `<!-- … -->` with
> `AMFIUnserializeXML: syntax error` mid-codesign. Document the rationale here,
> not in the plist.
