import { AddPaneButton } from "./AddPaneButton";
import { RuntimeButton } from "../features/01-llm-provider/RuntimeButton";
import { PluginsButton } from "../features/10-plugin-system/PluginsButton";

// macOS traffic-light cluster sits at ~(20, center) and spans ~68px wide.
// Reserve a bit more so the left cluster never collides with hover targets.
const TRAFFIC_LIGHT_RESERVE = 84;

export function TopBar() {
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-14 shrink-0 items-center pr-4"
      style={{ paddingLeft: TRAFFIC_LIGHT_RESERVE }}
    >
      <div data-tauri-drag-region className="flex shrink-0 items-center gap-2">
        <RuntimeButton />
        <PluginsButton />
      </div>
      {/* File search lives entirely inside the Filetree pane now. The middle of
          the bar is bare chrome, which makes the whole span a window-drag
          region. */}
      <div className="ml-auto shrink-0">
        <AddPaneButton />
      </div>
    </header>
  );
}
