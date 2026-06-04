/**
 * Mock working-tree data used by the omnibox dropdown until a Tauri
 * `read_dir` command is wired up. The real backend will replace `MOCK_PATHS`
 * with a streamed directory listing.
 */
export const MOCK_PATHS: string[] = [
  "src-tauri/src/commands/mod.rs",
  "src-tauri/src/lib.rs",
  "src-tauri/src/main.rs",
  "src/AppShell.tsx",
  "src/components/AddPaneButton.tsx",
  "src/components/BottomBar.tsx",
  "src/components/ChatPane.tsx",
  "src/components/FileTreeDropdown.tsx",
  "src/components/Omnibox.tsx",
  "src/components/Pane.tsx",
  "src/components/Pill.tsx",
  "src/components/Popover.tsx",
  "src/components/ProjectPill.tsx",
  "src/components/Resizer.tsx",
  "src/components/TopBar.tsx",
  "src/components/Workspace.tsx",
  "src/components/chat-history/ChatHistory.tsx",
  "src/components/chat-history/MessageItem.tsx",
  "src/components/chatbox/AgentPicker.tsx",
  "src/components/chatbox/AttachButton.tsx",
  "src/components/chatbox/AttachmentChips.tsx",
  "src/components/chatbox/ChatBoxFooter.tsx",
  "src/components/chatbox/ModePicker.tsx",
  "src/components/chatbox/ModelPicker.tsx",
  "src/components/chatbox/PickerPill.tsx",
  "src/components/chatbox/UsageMeter.tsx",
  "src/components/project-displays/BottomSheet.tsx",
  "src/components/project-displays/InlineTower.tsx",
  "src/components/project-displays/PillMorph.tsx",
  "src/components/project-displays/ProjectModeTakeover.tsx",
  "src/components/project-displays/SessionList.tsx",
  "src/components/project-displays/SpotlightOverlay.tsx",
  "src/features/01-llm-provider/Context.md",
  "src/features/02-agent-runner/Context.md",
  "src/features/03-task-workspace/Context.md",
  "src/features/04-diff-viewer/Context.md",
  "src/features/05-file-explorer/Context.md",
  "src/features/06-output-console/Context.md",
  "src/features/07-history/Context.md",
  "src/features/08-context-engine/Context.md",
  "src/features/09-settings/Context.md",
  "src/features/10-plugin-system/Context.md",
  "src/lib/mock-file-tree.ts",
  "src/lib/tauri/commands.ts",
  "src/lib/use-dismiss.ts",
  "src/main.tsx",
  "src/stores/use-agents-store.ts",
  "src/stores/use-attachments-store.ts",
  "src/stores/use-chat-store.ts",
  "src/stores/use-messages-store.ts",
  "src/stores/use-models-store.ts",
  "src/stores/use-projects-store.ts",
  "src/stores/use-workspace-store.ts",
  "src/styles.css",
  "CLAUDE.md",
  "References.md",
  "index.html",
  "package.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
];

export type TreeNode = {
  name: string;
  path: string;
  /** Undefined for files; an array (possibly empty) for folders. */
  children?: TreeNode[];
};

export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const path of paths) {
    const parts = path.split("/");
    let level = root;
    let acc = "";

    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      let node = level.find((n) => n.name === part);

      if (!node) {
        node = isLeaf
          ? { name: part, path: acc }
          : { name: part, path: acc, children: [] };
        level.push(node);
      }
      if (!isLeaf) level = node.children!;
    });
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aFolder = !!a.children;
      const bFolder = !!b.children;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(root);

  return root;
}

/** Collect the paths of every folder that contains at least one file matching `query` (case-insensitive). */
export function ancestorsMatching(paths: string[], query: string): Set<string> {
  const q = query.toLowerCase();
  const set = new Set<string>();
  for (const p of paths) {
    if (!p.toLowerCase().includes(q)) continue;
    const parts = p.split("/");
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      set.add(acc);
    }
  }
  return set;
}

export function filterPaths(paths: string[], query: string): string[] {
  if (!query) return paths;
  const q = query.toLowerCase();
  return paths.filter((p) => p.toLowerCase().includes(q));
}
