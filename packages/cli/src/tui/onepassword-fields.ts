/**
 * onepassword-fields.ts — the 1Password add-wizard's pure logic, with no JSX.
 *
 * WHY THIS FILE EXISTS: it breaks an import edge before that edge is created.
 * `buildFieldOptions`, `fuzzyFilterByTitle`, `fuzzyMatch` and `isOpModalMode`
 * lived inside `components/OnepasswordModal.tsx` and are called from `App.tsx`'s
 * state layer — so the moment that state moves into `hooks/useOnepasswordTab.ts`
 * (the largest extraction planned for this TUI), `hooks/` would import from
 * `components/`. That is the one direction the directory contract forbids: views
 * may read logic, logic may not reach back into views, or the two stop being
 * separable and the next split has nowhere to put anything.
 *
 * These four are already independent of the component — plain functions over
 * plain data, no JSX, no hooks, no renderer. Only their ADDRESS was wrong. The
 * modal and the hook now both import them from here.
 *
 * The types travel with them: `OpModalMode` is the mode subset the modal renders
 * and is what `isOpModalMode` narrows to, and `FieldPickerOption`/`FieldRowRole`
 * are what `buildFieldOptions` returns.
 */

import type { DiscoveredField } from "../providers/onepassword.js";
import type { Mode } from "./types.js";

/** The modal modes this dialog renders for. */
export type OpModalMode =
  | "input_op_account"
  | "input_op_env"
  | "pick_op_scope"
  | "pick_op_account"
  | "pick_op_kind"
  | "pick_op_vault"
  | "pick_op_item"
  | "pick_op_field";

/** True when the given Mode is one the 1Password modal should render. */
export function isOpModalMode(mode: Mode): mode is OpModalMode {
  return (
    mode === "input_op_account" ||
    mode === "input_op_env" ||
    mode === "pick_op_scope" ||
    mode === "pick_op_account" ||
    mode === "pick_op_kind" ||
    mode === "pick_op_vault" ||
    mode === "pick_op_item" ||
    mode === "pick_op_field"
  );
}

/**
 * Case-insensitive subsequence fuzzy match: every char of `query` must appear in
 * `text` in order (not necessarily adjacent). Empty query matches everything.
 * e.g. "dhg" matches "Docker Hub Github credentials".
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Filter a list of {title}-bearing rows by fuzzy-matching `filter` against title. */
export function fuzzyFilterByTitle<T extends { title: string }>(rows: T[], filter: string): T[] {
  if (filter.trim() === "") return rows;
  return rows.filter((r) => fuzzyMatch(filter, r.title));
}

/**
 * The visual role of a field-picker row, driving color + layout in
 * renderFieldPicker. `everything`/`section-glob` are the dynamic globs;
 * `field` is a concrete ref; `collapsed` is a single-field section shown as
 * "Section → ENVNAME"; `header` is a non-selectable group anchor; `blank` is a
 * spacer line between groups.
 */
export type FieldRowRole =
  | "everything-all" // whole-item `**` glob (★ All keys in this item)
  | "everything" // sectionless `*` glob (★ All top-level keys)
  | "section-glob"
  | "field"
  | "collapsed"
  | "header"
  | "blank";

/**
 * A field-picker row. Selectable options build an op:// path (`value`); headers
 * and blanks are visual-only. `left`/`right` carry the two-column display parts
 * (e.g. left="OpenAI", right="OPENAI_API_KEY") so renderFieldPicker can align
 * the env-var-name column.
 */
export interface FieldPickerOption {
  /** Display label (full, single-column fallback). */
  name: string;
  /** The op:// path (selectable rows) or "" (headers/blanks). Shown in footer. */
  description: string;
  /** The op:// path this option builds (single ref or glob); "" for non-rows. */
  value: string;
  /** False → header/blank: the cursor skips it and Enter ignores it. */
  selectable: boolean;
  /** Visual role for coloring/layout. */
  role: FieldRowRole;
  /** Left column text (the field/section label or glob caption). */
  left: string;
  /** Right column text (the resulting env-var name), or "" when N/A. */
  right: string;
  /** Indent depth (0 = top/header, 1 = nested under a section). */
  indent: number;
}

/** A valid POSIX-ish env var name (matches the resolver's ENV_VAR_NAME_RE). */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * A field is IMPORTABLE only if it's a concealed (secret) field whose label is a
 * valid env-var name — i.e. something that actually becomes an env var at import.
 * Non-concealed fields (notes/username/url) and badly-named fields ("credential")
 * are hidden so the picker shows only real keys. (The SDK's fieldType enum value
 * is "Concealed"; match case-insensitively to be safe.)
 */
function isImportableField(f: DiscoveredField): boolean {
  const name = f.label.trim();
  if (!ENV_NAME_RE.test(name)) return false;
  return String(f.type).toLowerCase() === "concealed";
}

/**
 * Build the field-picker option list from discovered fields.
 *
 * Only IMPORTABLE fields (concealed + valid env-var name) are shown; everything
 * else is hidden. Layout:
 *  - `★ Import everything (N keys)` glob at top (N = importable count).
 * FLAT LIST (uniform — no headers/gaps): one selectable "key" row per importable
 * field, shown as `ENVNAME  ·  section` (the section is dim context). After a
 * MULTI-key section's keys, one "↳ all of <section>" glob row (dynamic). Plus a
 * trailing "★ All top-level keys" glob ONLY when there are importable sectionless
 * keys (an item-level `op://Item/*` glob matches sectionless fields only — the
 * grammar can't span sections). Order: by section (first-seen), keys then the
 * section's "all of" glob; sectionless keys last; ★ at the very end.
 */
export function buildFieldOptions(
  vaultTitle: string,
  itemTitle: string,
  fields: DiscoveredField[]
): FieldPickerOption[] {
  const opts: FieldPickerOption[] = [];

  // Keep only importable fields, preserving order.
  const importable = fields.filter(isImportableField);

  // Group by section (first-seen order); sectionless → topLevel.
  const sectionOrder: string[] = [];
  const bySection = new Map<string, DiscoveredField[]>();
  const topLevel: DiscoveredField[] = [];
  for (const f of importable) {
    if (f.section) {
      if (!bySection.has(f.section)) {
        bySection.set(f.section, []);
        sectionOrder.push(f.section);
      }
      bySection.get(f.section)!.push(f);
    } else {
      topLevel.push(f);
    }
  }

  const hasSections = sectionOrder.length > 0;

  // A single "key" row: ENVNAME (left, green) + section tag (right, dim context).
  const keyRow = (f: DiscoveredField, section: string | null): FieldPickerOption => {
    const env = f.label.trim() || f.label;
    return {
      name: `${env}  ·  ${section ?? ""}`,
      description: f.reference,
      value: f.reference,
      selectable: true,
      role: "field",
      left: env,
      right: section ?? "",
      indent: 0,
    };
  };

  // ★ All keys in this item — the WHOLE-item glob (`**`): every importable field
  // regardless of section. Shown FIRST whenever the item has any importable key.
  // One config entry covers every shape (no-sections / all-sectioned / mixed).
  if (importable.length > 0) {
    opts.push({
      name: `★ All keys in this item (${importable.length}, auto-updates)`,
      description: `op://${vaultTitle}/${itemTitle}/**`,
      value: `op://${vaultTitle}/${itemTitle}/**`,
      selectable: true,
      role: "everything-all",
      left: "★ All keys in this item",
      right: `${importable.length}, auto-updates`,
      indent: 0,
    });
  }

  // Section keys, then (for multi-key sections) one "↳ all of <section>" glob.
  for (const section of sectionOrder) {
    const inSection = bySection.get(section)!;
    for (const f of inSection) opts.push(keyRow(f, section));
    if (inSection.length >= 2) {
      opts.push({
        name: `↳ all of ${section} (${inSection.length}, auto-updates)`,
        description: `op://${vaultTitle}/${itemTitle}/${section}/*`,
        value: `op://${vaultTitle}/${itemTitle}/${section}/*`,
        selectable: true,
        role: "section-glob",
        left: `↳ all of ${section}`,
        right: `${inSection.length}, auto-updates`,
        indent: 0,
      });
    }
  }

  // Sectionless keys (no tag).
  for (const f of topLevel) opts.push(keyRow(f, null));

  // ★ All top-level keys — the sectionless-only glob (`*`). Shown ONLY for a
  // MIXED item (has sections AND top-level keys), as a narrower pick distinct
  // from "All keys in this item". For a no-sections item, `**` already equals
  // `*`, so this would be a redundant second star — suppress it there.
  if (topLevel.length > 0 && hasSections) {
    opts.push({
      name: `★ All top-level keys (${topLevel.length}, auto-updates)`,
      description: `op://${vaultTitle}/${itemTitle}/*`,
      value: `op://${vaultTitle}/${itemTitle}/*`,
      selectable: true,
      role: "everything",
      left: "★ All top-level keys",
      right: `${topLevel.length}, auto-updates`,
      indent: 0,
    });
  }

  return opts;
}
