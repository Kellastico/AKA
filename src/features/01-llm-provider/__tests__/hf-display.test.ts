import { describe, expect, it } from "vitest";
import {
  formatParameters,
  prettyQuant,
  representativeQuant,
} from "../hf-display";

describe("prettyQuant", () => {
  it("turns K-quant labels into the picker's spaced form", () => {
    expect(prettyQuant("Q4_K_M")).toBe("Q4 M");
    expect(prettyQuant("Q3_K_XL")).toBe("Q3 XL");
    expect(prettyQuant("Q2_K_S")).toBe("Q2 S");
    expect(prettyQuant("Q6_K")).toBe("Q6");
  });

  it("keeps the I-quant family marker", () => {
    expect(prettyQuant("IQ4_XXS")).toBe("IQ4 XXS");
    expect(prettyQuant("IQ2_S")).toBe("IQ2 S");
    expect(prettyQuant("IQ4_NL")).toBe("IQ4 NL");
  });

  it("keeps the ternary-quant family marker", () => {
    expect(prettyQuant("TQ1_0")).toBe("TQ1");
    expect(prettyQuant("TQ2_0")).toBe("TQ2");
    expect(prettyQuant("UD-TQ1_0")).toBe("UD TQ1");
  });

  it("keeps I-quants distinct from the K-quant of the same size", () => {
    // These are different quants; rendering both as "Q2 S" made the
    // Quantizations facet show two identical rows that filtered differently.
    expect(prettyQuant("IQ2_S")).not.toBe(prettyQuant("Q2_K_S"));
    expect(prettyQuant("IQ3_M")).not.toBe(prettyQuant("Q3_K_M"));
  });

  it("drops a legacy format's trailing 0 but keeps a real variant digit", () => {
    expect(prettyQuant("Q8_0")).toBe("Q8");
    expect(prettyQuant("Q4_0")).toBe("Q4");
    expect(prettyQuant("Q4_1")).toBe("Q4 1");
    expect(prettyQuant("Q5_1")).toBe("Q5 1");
  });

  it("keeps unsloth's dynamic-quant marker", () => {
    expect(prettyQuant("UD-IQ2_XXS")).toBe("UD IQ2 XXS");
    expect(prettyQuant("UD-Q4_K_XL")).toBe("UD Q4 XL");
    // The float shortcut must not skip the marker on its way out.
    expect(prettyQuant("UD-BF16")).toBe("UD BF16");
  });

  it("leaves float dumps alone", () => {
    expect(prettyQuant("BF16")).toBe("BF16");
    expect(prettyQuant("F16")).toBe("F16");
    expect(prettyQuant("F32")).toBe("F32");
  });
});

describe("quant labels are distinct", () => {
  // Every quant llama.cpp emits, plus unsloth's dynamic variants. The display
  // label drops `K` and a trailing `_0`, so this is the guard that neither of
  // those drops can ever collapse two different quants onto one label.
  const ALL_QUANTS = [
    "IQ1_S", "IQ1_M",
    "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ2_M",
    "Q2_K", "Q2_K_S", "Q2_K_L", "Q2_K_XL",
    "IQ3_XXS", "IQ3_XS", "IQ3_S", "IQ3_M",
    "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q3_K_XL",
    "IQ4_XS", "IQ4_NL",
    "Q4_0", "Q4_1", "Q4_K_S", "Q4_K_M", "Q4_K_L", "Q4_K_XL",
    "Q5_0", "Q5_1", "Q5_K_S", "Q5_K_M", "Q5_K_L", "Q5_K_XL",
    "Q6_K", "Q6_K_L", "Q6_K_XL",
    "Q8_0",
    "TQ1_0", "TQ2_0",
    "BF16", "F16", "F32",
  ];
  const ALL = [...ALL_QUANTS, ...ALL_QUANTS.map((q) => `UD-${q}`)];

  it("renders every known quant to its own label", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const q of ALL) {
      const label = prettyQuant(q);
      const prev = seen.get(label);
      if (prev) collisions.push(`${prev} and ${q} both render "${label}"`);
      else seen.set(label, q);
    }
    expect(collisions).toEqual([]);
    expect(seen.size).toBe(ALL.length);
  });

  it("never renders an empty label", () => {
    for (const q of ALL) expect(prettyQuant(q)).not.toBe("");
  });
});

describe("representativeQuant", () => {
  it("leads with a quant the user filtered on", () => {
    expect(representativeQuant(["Q4_K_M", "Q8_0"], ["Q8_0"])).toBe("Q8_0");
  });

  it("falls back to the quant most people download", () => {
    expect(representativeQuant(["Q2_K", "Q4_K_M", "Q8_0"], [])).toBe("Q4_K_M");
    expect(representativeQuant(["Q2_K", "Q6_K"], [])).toBe("Q6_K");
  });

  it("takes whatever the repo has when none is preferred", () => {
    expect(representativeQuant(["IQ1_S"], [])).toBe("IQ1_S");
    expect(representativeQuant([], [])).toBeNull();
  });

  it("ignores a selection the repo does not carry", () => {
    expect(representativeQuant(["Q4_K_M"], ["Q2_K"])).toBe("Q4_K_M");
  });
});

describe("formatParameters", () => {
  it("names a large model by the floor of its billions", () => {
    // A 30.5B MoE is the repo's "30B", not "31B".
    expect(formatParameters(30_532_122_624)).toBe("30B Parameters");
    expect(formatParameters(27_320_697_856)).toBe("27B Parameters");
  });

  it("keeps a decimal under 10B, and drops a trailing .0", () => {
    expect(formatParameters(7_615_616_512)).toBe("7.6B Parameters");
    expect(formatParameters(2_000_000_000)).toBe("2B Parameters");
  });

  it("falls back to millions, and to nothing when unknown", () => {
    expect(formatParameters(494_000_000)).toBe("494M Parameters");
    expect(formatParameters(null)).toBeNull();
    expect(formatParameters(0)).toBeNull();
  });
});
