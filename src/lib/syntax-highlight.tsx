/**
 * Dependency-free token highlighting for the run timeline — so a user can read
 * at a glance what the model/agent is doing in a shell command or a code edit.
 *
 * Two small, PURE tokenizers (unit-tested) plus thin render components:
 *   - `tokenizeShell` / `CommandLine` — colors a shell command by the rules the
 *     product asks for: the leading command is BLUE, a delete/remove command is
 *     RED, file paths are YELLOW, and the rest of the line is opaque white.
 *   - `tokenizeCode` / `CodeText` — a language-agnostic lexer (strings,
 *     comments, numbers, keywords, function/tag names) so added/edited code
 *     reads as code, not a flat wall of text.
 *
 * The palette is shared between the two so the surface reads as one system:
 * blue = something callable (command / function / tag), yellow = a location or
 * string literal (path / quoted value), red = destructive.
 */

// ---------- shared palette ----------

const SHELL_CLASS: Record<ShellKind, string> = {
  cmd: "text-sky-300 font-medium",
  danger: "text-red-400 font-semibold",
  path: "text-amber-300",
  flag: "text-white",
  op: "text-ink/40",
  text: "text-white",
  ws: "",
};

// Every hue clears WCAG 2.1 AA (4.5:1) on the accordion's darkest panel bg —
// most reach AAA — including on the diff-tinted rows. `comment` is deliberately
// the dimmest, but held at ink/60 (≈6.5:1) rather than the app's usual ink/40
// chrome tint (≈3.6:1, sub-AA) because a comment is content, not decoration.
const CODE_CLASS: Record<CodeKind, string> = {
  str: "text-amber-300",
  comment: "text-ink/60 italic",
  num: "text-purple-300",
  keyword: "text-fuchsia-300",
  fn: "text-sky-300",
  text: "text-ink/90",
};

// ---------- shell ----------

export type ShellKind = "cmd" | "danger" | "path" | "flag" | "op" | "text" | "ws";
export interface ShellToken {
  text: string;
  kind: ShellKind;
}

/** Commands whose whole purpose is to delete/remove — the leading word goes red. */
const DESTRUCTIVE = new Set([
  "rm", "rmdir", "unlink", "shred", "del", "delete", "trash", "truncate",
]);
/** Destructive SUBcommands after a known wrapper (e.g. `git rm`, `npm uninstall`). */
const DESTRUCTIVE_SUBCOMMAND = new Set([
  "rm", "remove", "uninstall", "delete", "del", "prune", "drop",
]);
/** Wrappers whose first argument is a subcommand we should inspect for "delete". */
const WRAPPERS = new Set([
  "git", "npm", "yarn", "pnpm", "cargo", "pip", "pip3", "brew", "apt",
  "apt-get", "docker", "kubectl", "gh",
]);

/** Does a bare token look like a filesystem location? Quotes are stripped first. */
function looksLikePath(token: string): boolean {
  const unq = token.replace(/^['"]/, "").replace(/['"]$/, "");
  if (!unq) return false;
  if (/^(\/|~|\.\/|\.\.\/)/.test(unq)) return true; // absolute / home / relative
  if (unq.includes("/")) return true; // any nested path
  // A bare filename with an extension: index.html, styles.css, Foo (2025).zip
  if (/[^\s/]\.[A-Za-z0-9]{1,8}$/.test(unq)) return true;
  return false;
}

const OP_TWO = new Set(["&&", "||", ">>"]);
const OP_ONE = new Set(["|", ";", "<", ">", "&"]);

/**
 * Split a shell command into colored tokens, preserving the exact text
 * (whitespace and quotes included) so the rendered line matches the original.
 * The "command" slot is re-armed after every pipe/`&&`/`;` so a chained command
 * (`git add -A && rm foo`) colors each segment's verb correctly.
 */
export function tokenizeShell(line: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const n = line.length;
  let i = 0;
  let commandWord: string | null = null; // the segment's verb, once seen
  let subcommandChecked = false; // only the first non-flag arg is a subcommand

  const resetSegment = () => {
    commandWord = null;
    subcommandChecked = false;
  };

  while (i < n) {
    const ch = line[i];

    // Whitespace run — kept verbatim.
    if (/\s/.test(ch)) {
      let j = i;
      while (j < n && /\s/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), kind: "ws" });
      i = j;
      continue;
    }

    // Operators separate command segments.
    const two = line.slice(i, i + 2);
    if (OP_TWO.has(two)) {
      tokens.push({ text: two, kind: "op" });
      i += 2;
      resetSegment();
      continue;
    }
    if (OP_ONE.has(ch)) {
      tokens.push({ text: ch, kind: "op" });
      i += 1;
      resetSegment();
      continue;
    }

    // A word — may contain a quoted span that groups spaces into one token.
    let j = i;
    let word = "";
    while (j < n) {
      const c = line[j];
      if (/\s/.test(c) || OP_ONE.has(c) || OP_TWO.has(line.slice(j, j + 2))) break;
      if (c === "'" || c === '"') {
        const q = c;
        word += c;
        j++;
        while (j < n && line[j] !== q) {
          word += line[j];
          j++;
        }
        if (j < n) {
          word += line[j];
          j++;
        }
      } else {
        word += c;
        j++;
      }
    }

    let kind: ShellKind;
    if (commandWord === null) {
      kind = DESTRUCTIVE.has(word) ? "danger" : "cmd";
      commandWord = word;
    } else if (word.startsWith("-")) {
      kind = "flag";
    } else if (
      !subcommandChecked &&
      WRAPPERS.has(commandWord) &&
      DESTRUCTIVE_SUBCOMMAND.has(word)
    ) {
      kind = "danger";
      subcommandChecked = true;
    } else {
      subcommandChecked = true;
      kind = looksLikePath(word) ? "path" : "text";
    }
    tokens.push({ text: word, kind });
    i = j;
  }

  return tokens;
}

/** Render a shell command with per-token color. Whitespace/newlines preserved. */
export function CommandLine({ text }: { text: string }) {
  const tokens = tokenizeShell(text);
  return (
    <code className="block whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">
      {tokens.map((t, i) => (
        <span key={i} className={SHELL_CLASS[t.kind]}>
          {t.text}
        </span>
      ))}
    </code>
  );
}

/**
 * The commands worth recognizing as the *verb* of a line inside captured
 * terminal output — so a run tool that echoes `ls -la …` / `rm …` as the first
 * line of its output gets that line colorized, while a directory listing or a
 * program's stdout stays neutral (we never guess a listing row like
 * `drwxr-xr-x` is a command). Union with the destructive set below.
 */
const KNOWN_COMMANDS = new Set([
  "ls", "cat", "cd", "pwd", "mkdir", "touch", "mv", "cp", "ln", "echo",
  "printf", "grep", "egrep", "rg", "ag", "find", "head", "tail", "sed",
  "awk", "sort", "uniq", "wc", "chmod", "chown", "diff", "which", "env",
  "export", "source", "tar", "zip", "unzip", "curl", "wget", "ps", "kill",
  "df", "du", "tree", "open", "code", "make", "sh", "bash", "zsh", "node",
  "deno", "bun", "python", "python3", "pip", "pip3", "ruby", "go", "rustc",
  "test", "true", "false", "sleep",
  ...WRAPPERS,
  ...DESTRUCTIVE,
]);

/** Is this line an actual command invocation (its first word is a known verb)? */
export function isCommandLine(line: string): boolean {
  const first = line.trim().split(/[\s]+/)[0] ?? "";
  return KNOWN_COMMANDS.has(first);
}

/**
 * Render captured terminal OUTPUT with command lines colorized in place. Only
 * lines whose first word is a real command get the shell treatment (verb blue
 * or red, paths yellow, body white); every other line — listings, stdout,
 * `(no output)` — stays the neutral output color. Newlines are preserved so the
 * block lays out exactly as captured.
 */
export function CommandOutput({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const nl = i < lines.length - 1 ? "\n" : "";
        if (isCommandLine(line)) {
          return (
            <span key={i}>
              {tokenizeShell(line).map((t, j) => (
                <span key={j} className={SHELL_CLASS[t.kind]}>
                  {t.text}
                </span>
              ))}
              {nl}
            </span>
          );
        }
        return (
          <span key={i} className="text-ink/70">
            {line}
            {nl}
          </span>
        );
      })}
    </>
  );
}

// ---------- code ----------

export type CodeKind = "str" | "comment" | "num" | "keyword" | "fn" | "text";
export interface CodeToken {
  text: string;
  kind: CodeKind;
}

/** Common keywords across the languages these panels actually show (JS/TS/Rust/
 *  Python/HTML/CSS-ish). A miss just falls back to plain text — never wrong,
 *  only less colored. */
const KEYWORDS = new Set([
  // JS / TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "class", "extends",
  "import", "export", "from", "default", "async", "await", "try", "catch",
  "finally", "throw", "typeof", "instanceof", "in", "of", "this", "super",
  "yield", "static", "get", "set", "void", "null", "undefined", "true", "false",
  "interface", "type", "enum", "as", "keyof", "readonly",
  // Rust
  "fn", "pub", "use", "struct", "impl", "match", "mut", "mod", "crate", "trait",
  "where", "Some", "None", "Ok", "Err", "self", "Self",
  // Python
  "def", "elif", "lambda", "and", "or", "not", "None", "True", "False", "with",
  "pass", "raise", "global", "nonlocal",
]);

/**
 * Lex a code snippet into colored tokens. Language-agnostic and conservative:
 * only unambiguous constructs are colored — quoted strings, line/block/HTML
 * comments, numbers, keywords, `name(` function calls, and `<tag>` names — and
 * everything else stays default text. Handles multi-line input; the caller
 * renders inside a `whitespace-pre` container so layout is preserved.
 */
export function tokenizeCode(src: string): CodeToken[] {
  const out: CodeToken[] = [];
  const push = (text: string, kind: CodeKind) => {
    if (text) out.push({ text, kind });
  };
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);

    // Line comment: // … to EOL.
    if (two === "//") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      push(src.slice(i, j), "comment");
      i = j;
      continue;
    }
    // Block comment: /* … */.
    if (two === "/*") {
      let j = i + 2;
      while (j < n && src.slice(j, j + 2) !== "*/") j++;
      j = Math.min(n, j + 2);
      push(src.slice(i, j), "comment");
      i = j;
      continue;
    }
    // HTML comment: <!-- … -->.
    if (src.slice(i, i + 4) === "<!--") {
      let j = i + 4;
      while (j < n && src.slice(j, j + 3) !== "-->") j++;
      j = Math.min(n, j + 3);
      push(src.slice(i, j), "comment");
      i = j;
      continue;
    }
    // String literal: ' " or ` with escape handling.
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        j++;
      }
      push(src.slice(i, j), "str");
      i = j;
      continue;
    }
    // HTML tag name: <tag or </tag → the '<'/'</' is text, the name is a fn.
    const tag = /^<\/?([A-Za-z][\w-]*)/.exec(src.slice(i, i + 40));
    if (tag) {
      const lead = tag[0].startsWith("</") ? "</" : "<";
      push(lead, "text");
      push(tag[1], "fn");
      i += lead.length + tag[1].length;
      continue;
    }
    // Number.
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._]/.test(src[j])) j++;
      push(src.slice(i, j), "num");
      i = j;
      continue;
    }
    // Identifier → keyword / function call / plain.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      const kind: CodeKind = KEYWORDS.has(word)
        ? "keyword"
        : src[k] === "("
          ? "fn"
          : "text";
      push(word, kind);
      i = j;
      continue;
    }
    // Anything else: a run of punctuation/whitespace up to the next interesting char.
    let j = i;
    while (j < n) {
      const cc = src[j];
      if (/[A-Za-z_$0-9'"`]/.test(cc)) break;
      if (src.slice(j, j + 2) === "//" || src.slice(j, j + 2) === "/*") break;
      if (src.slice(j, j + 4) === "<!--") break;
      if (/^<\/?[A-Za-z]/.test(src.slice(j, j + 2))) break;
      j++;
    }
    if (j === i) j++; // guarantee forward progress
    push(src.slice(i, j), "text");
    i = j;
  }

  return out;
}

/** Render a code snippet with token coloring. Parent controls whitespace/layout. */
export function CodeText({ text }: { text: string }) {
  const tokens = tokenizeCode(text);
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={CODE_CLASS[t.kind]}>
          {t.text}
        </span>
      ))}
    </>
  );
}
