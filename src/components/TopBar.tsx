import { AddPaneButton } from "./AddPaneButton";
import { Omnibox } from "./Omnibox";
import { RuntimeButton } from "../features/01-llm-provider/RuntimeButton";

// macOS traffic-light cluster sits at ~(20, center) and spans ~68px wide.
// Reserve a bit more so the search input never collides with hover targets.
const TRAFFIC_LIGHT_RESERVE = 84;

export function TopBar() {
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-14 shrink-0 items-center pr-4"
      style={{ paddingLeft: TRAFFIC_LIGHT_RESERVE }}
    >
      <div className="shrink-0">
        <RuntimeButton />
      </div>
      <div className="ml-auto shrink-0">
        <AddPaneButton />
      </div>
      {/* Centered on the WINDOW, independent of the side clusters' widths so it
          never looks lop-sided. Same width as before (up to 640px); the clamp
          only reserves room for the clusters on narrow windows so it can't
          collide with them. The clusters above stay in normal flow. */}
      <div className="pointer-events-none absolute left-1/2 top-0 flex h-14 -translate-x-1/2 items-center">
        <div className="pointer-events-auto w-[min(640px,calc(100vw-37rem))]">
          <Omnibox />
        </div>
      </div>
    </header>
  );
}
