import { useState } from "react";
import { GlobeSimple, SlidersHorizontal } from "@phosphor-icons/react";
import { Disclosure } from "../../components/Disclosure";
import { TuningSection } from "./TuningSection";
import { AllowlistSection } from "./AllowlistSection";

/**
 * The Runtime modal's "Advanced Settings" accordion. Collapsed by default so
 * the panel stays approachable — beginners never trip over sampling knobs or
 * the egress allowlist, while advanced users get them one click away.
 *
 * Uses the flat `row` Disclosure variant so expanding reads exactly like the
 * "Add custom endpoint" row: same header size, content flowing directly in the
 * panel — no nested boxes. Sampling sliders come first, then a sibling
 * "Network Allowlist" accordion. Both write to the active project's
 * `.äkä/config.json`; there is no global config (see ConnectionPanel /
 * features/09-settings/Context.md — runtime/BYOK settings belong here, not in
 * a general Settings surface).
 */
export function AdvancedSettings() {
  const [open, setOpen] = useState(false);
  const [allowlistOpen, setAllowlistOpen] = useState(false);

  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((v) => !v)}
      label="Advanced Settings"
      icon={<SlidersHorizontal size={12} className="shrink-0" />}
    >
      <TuningSection />

      <div className="h-px bg-white/10" />

      <Disclosure
        open={allowlistOpen}
        onToggle={() => setAllowlistOpen((v) => !v)}
        label="Network Allowlist"
        icon={<GlobeSimple size={12} className="shrink-0" />}
      >
        <AllowlistSection />
      </Disclosure>
    </Disclosure>
  );
}
