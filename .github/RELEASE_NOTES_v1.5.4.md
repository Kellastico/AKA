## AKA 1.5.4

Terminal work and code edits now read in color inside the run timeline, so you can see at a glance what the model and agent are doing in the background.

### 🎨 Color-coded commands and code — in the tool accordions
Expand any tool row in the run timeline and the detail is now syntax-highlighted:

- **Shell commands** are colored by role: the command verb is **blue**, a delete/remove command (`rm`, `rmdir`, `git rm`, `npm uninstall`, …) is **red**, file paths are **yellow**, and the rest of the line is plain white — so a destructive command is impossible to miss and you can always see *which file* is being touched.
- This works wherever the command shows up. Many agents echo the command as the first line of the tool's **output** (e.g. `ls -la '…'`, `rm '…'`) rather than as a separate input — those lines are now colorized in place, while directory listings and program stdout stay neutral.
- **Code edits** keep their green/red add-remove gutter, and the code itself is now colored — function and tag names blue, strings and paths yellow, keywords violet, numbers purple, comments muted. An edit reads as code, not a flat block of text.

It's deliberately scoped: the coloring lives **inside the accordions** (the expandable command/diff detail), so the collapsed timeline stays clean and your final answers keep their normal formatting. And it's dependency-free — a small, tested tokenizer, no syntax-highlighting library pulled in.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.5.4_aarch64.dmg`
- **Windows** → `AKA_1.5.4_x64-setup.exe`
- **Linux** → `AKA_1.5.4_amd64.AppImage` (portable) · `AKA_1.5.4_amd64.deb` (Debian/Ubuntu) · `AKA-1.5.4-1.x86_64.rpm` (Fedora/RHEL)
