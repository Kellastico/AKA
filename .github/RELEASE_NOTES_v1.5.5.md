## AKA 1.5.5

The context window is now something you can see, size, and trust: every size is priced against your own machine, with stark warnings before it can take that machine down. Alongside it, live CPU and GPU readings, a reasoning switch, a redesigned HuggingFace picker, and a Filetree that opens and searches files in place.

### 🧠 Context size: visible, adjustable, priced against your machine
Open the Context Window modal and you'll see the model's context size, with a slider to change it on AKA's built-in runtime.

- **Sized from the model, not a guess.** The slider runs up to the window the model was trained for, and every position is priced from the model's own GGUF header (layers, KV heads, head size) against this machine's RAM.
- **Stark warnings, never a block.** Past 75% of RAM it warns of heavy swapping. Past 100% it warns the runtime will almost certainly crash, and names the largest window that fits. The choice stays yours.
- **Real reasons when something fails.** If a size can't be applied, the message now says why instead of a bare "Couldn't set context size".
- **Ollama, honestly.** For Ollama's GGUF models the modal shows the model's max context and how much of it fits this machine, read from the weights on disk without contacting the server, and warns when the model is trained for more than the machine can hold. The size itself is set in Ollama, and the modal says so rather than offering a slider AKA can't honor.

### 🛟 Fixed: switching models could crash your machine
The context size carried over when you switched models, but its cost doesn't: every model pays a different number of bytes per token. A 262k window that is comfortable on a small model is 32 GB of KV cache on a 9B one, and on a 16 GB machine that took the whole machine down with no warning.

- **Every model switch is re-checked.** Whenever a model loads, whether picked explicitly or loaded on the first message, the runtime prices the current window against that model and clamps it to what fits.
- **Warnings follow the model you picked.** The modal prices the selected model from its file header, so its figures and warnings are right even before the model loads.

### 📈 Live CPU and GPU readings
The Context Window modal now shows live CPU use for the whole machine, with AKA's and the runtime's share, and on macOS, GPU use and GPU memory. Each comes with a short sparkline of the last few minutes.

- Read once a second on this machine, shown, then discarded. Nothing is written to disk, nothing leaves the machine, and there is nothing to opt into.
- GPU readings are macOS-only; elsewhere the GPU row shows a dash.

### 💭 Reasoning on/off
For models whose chat template has a thinking switch, a **Reasoning** toggle turns thinking on or off on AKA's built-in runtime. Turning it off produces exactly what the template's own thinking-disabled form does. Models without that switch, and runtimes that can't flip it, show no toggle rather than one that does nothing.

### 🤗 A redesigned HuggingFace picker
Models → "Add Model (via Huggingface)" is now search-first.

- **Results are repos.** Each row leads with a representative quant; "View & Download Variants" opens the repo's files, headed with how many quants it offers.
- **Exact sizes, on the button.** Every Download button shows the file's real size from HuggingFace's file listing. Nothing is estimated.
- **Filter by Sort By, Created By, and Quantizations.** Quant labels keep their IQ, TQ, and UD markers, so no two variants ever look alike.
- **Offline-first.** Rows use local initials avatars and the HuggingFace mark is bundled, so no images are fetched from HuggingFace's CDN.

**Manage Models** now lists only what is actually on disk, plus downloads in flight, with a storage panel (model count, total size, folder path, Reveal) and a "Fits this device" badge from a RAM figure that is labeled as an estimate. The built-in list of suggested models is gone.

### 🗂️ Filetree: open and search files in place
The Files pane is now the **Filetree**: the tree on the left, the open file on the right.

- **Split view** with a draggable, keyboard-operable divider. On a narrow pane it collapses to one column with a back control, and nothing you had expanded, searched, or left unsaved is lost.
- **Search lives here now.** The top-bar search box is gone. Typing in the Filetree filters the tree in place, showing matches plus the folders that hold them; ↑/↓ and Enter open a hit, and a pasted path still jumps straight to its file.
- **One place to read files.** Path chips in the conversation for files the agent only read open in the Filetree; chips with a diff still open the Diff pane.
- The pane can expand to full width from its header.

### 🔧 Also in this release
- **The built-in runtime is picked automatically at launch.** A fresh start no longer sits pointed at an external port you may not have installed; AKA's runtime takes over as soon as it is ready, unless you or the project chose a different runtime.
- **History tells the truth in non-git projects.** Opening History now checks whether the project can be checkpointed, instead of promising checkpoints a non-git project can never produce.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.5.5_aarch64.dmg`
- **Windows** → `AKA_1.5.5_x64-setup.exe`
- **Linux** → `AKA_1.5.5_amd64.AppImage` (portable) · `AKA_1.5.5_amd64.deb` (Debian/Ubuntu) · `AKA-1.5.5-1.x86_64.rpm` (Fedora/RHEL)
