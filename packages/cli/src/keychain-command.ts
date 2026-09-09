/**
 * `claudish keychain …` — manage the macOS Keychain credential backend.
 *
 *   claudish keychain                 status (default)
 *   claudish keychain status          backend state + what is stored
 *   claudish keychain list            stored variables, with identification tails
 *   claudish keychain import [...]    copy secrets from env / 1Password into the keychain
 *   claudish keychain set  <VAR>      store one secret (value never echoed, never in argv)
 *   claudish keychain rm   <VAR>      remove one secret
 *   claudish keychain enable|disable  turn the backend on/off (moves no secrets)
 *
 * SECURITY POSTURE OF THIS FILE
 *
 * No command here ever prints a secret. `list` and the `import` plan show an
 * identification TAIL only (`••••1234`), which is the same affordance the
 * 1Password tab uses so a user can tell WHICH credential is wired up. `set`
 * reads its value from a hidden prompt or from stdin — never from argv, which
 * `ps` exposes to every other user on the machine.
 *
 * WHY `import` NEEDS A CONFIRMATION
 *
 * Copying into the keychain can overwrite an item that is already there, and
 * the overwritten value is not recoverable. The plan therefore names every
 * variable and marks each `new` or `overwrite` BEFORE anything is written, and
 * requires an explicit yes. `--dry-run` prints the same plan and stops.
 */

import { cliAnsi } from "./theme/ansi.js";

import { hasOpSources, resolveOpKeyForEnvVars } from "./auth/credentials/op-source.js";
import { isKeychainEnabled, setKeychainEnabled } from "./profile-config.js";
import {
  KEYCHAIN_SERVICE,
  KeychainError,
  deleteKeychainSecret,
  describeUnstorableValue,
  enumerateKeychainVars,
  invalidateKeychainCache,
  isKeychainSupported,
  isValidKeychainVarName,
  keychainUnavailableReason,
  readKeychainSecret,
  valueTail,
  writeKeychainSecret,
} from "./providers/keychain.js";
import { getAllProviders } from "./providers/provider-definitions.js";

// ---------------------------------------------------------------------------
// Small output helpers
// ---------------------------------------------------------------------------

/**
 * Colors are resolved at RENDER time, never captured in a module-level const:
 * theme detection runs after module load, so a snapshot would pin the dark
 * palette and render invisible text on a light terminal.
 */
function ok(text: string): string {
  const c = cliAnsi();
  return `${c.GREEN}${text}${c.RESET}`;
}
function warn(text: string): string {
  const c = cliAnsi();
  return `${c.YELLOW}${text}${c.RESET}`;
}
function bad(text: string): string {
  const c = cliAnsi();
  return `${c.RED}${text}${c.RESET}`;
}
function dim(text: string): string {
  const c = cliAnsi();
  return `${c.GRAY}${text}${c.RESET}`;
}
function strong(text: string): string {
  const c = cliAnsi();
  return `${c.BOLD}${text}${c.RESET}`;
}

/** Print the "this platform has no keychain" message and return false. */
function requireKeychain(): boolean {
  const reason = keychainUnavailableReason();
  if (!reason) return true;
  console.error(bad(`Keychain unavailable: ${reason}`));
  console.error(
    dim("claudish's keychain backend uses the macOS Security framework via /usr/bin/security.")
  );
  return false;
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

/**
 * Every API-key env var claudish knows about, primary names and aliases alike.
 *
 * Built LIVE from the provider catalog rather than a hand-written list —
 * a second roster would drift the moment a provider was added, and this repo
 * has already paid for that once (the config TUI's own provider array went
 * stale and made two working providers invisible).
 */
function catalogEnvVars(): string[] {
  const names = new Set<string>();
  for (const p of getAllProviders()) {
    if (p.apiKeyEnvVar) names.add(p.apiKeyEnvVar);
    for (const alias of p.apiKeyAliases ?? []) names.add(alias);
  }
  return Array.from(names).sort();
}

/** One planned keychain write. */
interface ImportEntry {
  envVar: string;
  value: string;
  origin: "environment" | "1Password";
  action: "new" | "overwrite" | "unchanged";
  /** Set when the value cannot be stored; the entry is reported and skipped. */
  problem?: string;
}

// ---------------------------------------------------------------------------
// status / list
// ---------------------------------------------------------------------------

function keychainStatus(): void {
  const supported = isKeychainSupported();
  const enabled = isKeychainEnabled();

  console.log(strong("macOS Keychain backend"));
  console.log(
    `  platform    ${supported ? ok("supported") : bad(`unsupported (${process.platform})`)}`
  );
  console.log(`  backend     ${enabled ? ok("enabled") : dim("disabled")}`);
  console.log(`  service     ${dim(KEYCHAIN_SERVICE)}`);

  if (!supported) return;

  const listed = enumerateKeychainVars();
  if (listed.failed) {
    // "0 keys" would be a lie that reads as a working, empty store. Say what
    // actually happened, and say it in red.
    console.log(`  stored keys ${bad("could not read the keychain")}`);
    console.log();
    console.log(bad(listed.error ?? "unknown error"));
    console.log(dim("The keychain may be locked, or access may have been denied."));
    process.exitCode = 1;
    return;
  }
  const stored = listed.names;
  console.log(`  stored keys ${stored.length > 0 ? ok(String(stored.length)) : dim("0")}`);

  if (!enabled && stored.length > 0) {
    console.log();
    console.log(
      warn(
        `${stored.length} key(s) are in the keychain but the backend is disabled, so claudish will not read them.`
      )
    );
    console.log(dim("  Enable with: claudish keychain enable"));
  }
  if (enabled && stored.length === 0) {
    console.log();
    console.log(dim("Nothing stored yet. Copy your existing keys in with:"));
    console.log(dim("  claudish keychain import"));
  }
  console.log();
  console.log(dim("Resolution order: env var → alias → config.json → macOS Keychain → 1Password"));
}

/**
 * List stored variables with an identification tail.
 *
 * The tail costs one ~17ms value read per variable, which is why it is done
 * HERE and nowhere on a hot path: `list` is a deliberate user request for
 * exactly this information.
 */
function keychainList(): void {
  if (!requireKeychain()) return;
  const listed = enumerateKeychainVars();
  if (listed.failed) {
    console.error(bad(`Could not read the keychain: ${listed.error ?? "unknown error"}`));
    console.error(dim("The keychain may be locked, or access may have been denied."));
    process.exitCode = 1;
    return;
  }
  const stored = listed.names;
  if (stored.length === 0) {
    console.log(dim("No keys stored in the keychain."));
    console.log(dim("Copy your existing keys in with: claudish keychain import"));
    return;
  }
  const width = Math.max(...stored.map((n) => n.length));
  for (const name of stored) {
    let tail: string;
    try {
      const value = readKeychainSecret(name);
      tail = value ? dim(valueTail(value)) : bad("unreadable");
    } catch (err) {
      tail = bad(err instanceof KeychainError ? "denied" : "error");
    }
    const shadowed = process.env[name] ? warn("  (shadowed by an env var)") : "";
    console.log(`  ${name.padEnd(width)}  ${tail}${shadowed}`);
  }
  if (!isKeychainEnabled()) {
    console.log();
    console.log(warn("The keychain backend is disabled — claudish will not read these."));
    console.log(dim("  Enable with: claudish keychain enable"));
  }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

interface ImportOptions {
  from: "env" | "1password" | "all";
  only?: string[];
  dryRun: boolean;
  yes: boolean;
}

/**
 * Collect what WOULD be written, from the requested sources.
 *
 * Environment is gathered first and 1Password only fills the gaps, matching the
 * runtime precedence — if a variable is live in the shell, that is the value
 * claudish is actually using today, and copying a DIFFERENT one out of a vault
 * would silently change which credential the tool signs with.
 */
async function collectImportPlan(opts: ImportOptions): Promise<ImportEntry[]> {
  const wanted = opts.only ?? catalogEnvVars();
  // HARD FAIL on an enumeration failure rather than planning against an empty
  // set. The plan's `new` vs `overwrite` marking is the ONLY thing standing
  // between the user and an unrecoverable replacement, and a locked or denied
  // keychain reports zero stored keys — so every existing item would be
  // labelled `new`, the overwrite warning would never print, and `-U` would
  // replace them all on a confirmation the user gave for something else.
  const listed = enumerateKeychainVars();
  if (listed.failed) {
    throw new KeychainError(
      `Cannot read the keychain to plan this import: ${listed.error ?? "unknown error"}. ` +
        "Refusing to continue — without knowing what is already stored, an import could " +
        "silently replace existing keys."
    );
  }
  const stored = new Set(listed.names);
  const plan = new Map<string, ImportEntry>();

  const classify = (envVar: string, value: string, origin: ImportEntry["origin"]) => {
    const problem = describeUnstorableValue(value) ?? undefined;
    let action: ImportEntry["action"] = stored.has(envVar) ? "overwrite" : "new";
    if (action === "overwrite") {
      // Reading the existing value tells us whether this is a real change. An
      // "overwrite" that writes back an identical value is noise in the plan
      // and, worse, invites the user to approve a destructive-sounding action
      // that destroys nothing.
      try {
        if (readKeychainSecret(envVar) === value) action = "unchanged";
      } catch {
        // Unreadable existing item — keep it marked as an overwrite.
      }
    }
    plan.set(envVar, { envVar, value, origin, action, problem });
  };

  if (opts.from === "env" || opts.from === "all") {
    for (const envVar of wanted) {
      const value = process.env[envVar];
      if (value) classify(envVar, value, "environment");
    }
  }

  if ((opts.from === "1password" || opts.from === "all") && hasOpSources()) {
    const missing = wanted.filter((n) => !plan.has(n));
    if (missing.length > 0) {
      // "throw" because this is an EXPLICIT request to read 1Password: a user
      // who typed `--from 1password` needs to see an auth failure, not have it
      // silently swallowed into an empty import.
      const resolved = await resolveOpKeyForEnvVars(new Set(missing), {
        onAuthFailure: "throw",
        allowPrompt: true,
      });
      for (const [envVar, value] of Object.entries(resolved)) {
        if (value) classify(envVar, value, "1Password");
      }
    }
  }

  return Array.from(plan.values()).sort((a, b) => a.envVar.localeCompare(b.envVar));
}

function renderPlan(plan: ImportEntry[]): void {
  const width = Math.max(...plan.map((e) => e.envVar.length));
  for (const e of plan) {
    if (e.problem) {
      console.log(`  ${bad("skip")}       ${e.envVar.padEnd(width)}  ${bad(e.problem)}`);
      continue;
    }
    const label =
      e.action === "new"
        ? ok("new")
        : e.action === "overwrite"
          ? warn("overwrite")
          : dim("unchanged");
    const pad = " ".repeat(Math.max(0, 10 - (e.action === "new" ? 3 : e.action.length)));
    console.log(
      `  ${label}${pad} ${e.envVar.padEnd(width)}  ${dim(valueTail(e.value))} ${dim(`from ${e.origin}`)}`
    );
  }
}

/**
 * Perform the writes. One failure does NOT abort the batch: a user importing
 * twelve keys should not lose eleven of them because the third hit a problem,
 * so every failure is collected and reported together at the end.
 */
function writeImportEntries(entries: ImportEntry[]): { written: number; failures: string[] } {
  let written = 0;
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      writeKeychainSecret(entry.envVar, entry.value);
      written++;
    } catch (err) {
      failures.push(`${entry.envVar}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { written, failures };
}

function reportImportResult(written: number, failures: string[]): void {
  // Enabling only after at least one successful write means a failed import
  // never leaves the backend switched on with nothing behind it.
  if (written > 0 && !isKeychainEnabled()) {
    setKeychainEnabled(true);
    console.log(ok("Keychain backend enabled."));
  }
  console.log(ok(`Stored ${written} key(s) in the keychain.`));
  if (failures.length > 0) {
    console.error(bad(`${failures.length} key(s) failed:`));
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }
}

async function keychainImport(opts: ImportOptions): Promise<void> {
  if (!requireKeychain()) return;

  let plan: ImportEntry[];
  try {
    plan = await collectImportPlan(opts);
  } catch (err) {
    console.error(
      bad(`Could not build the import plan: ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exitCode = 1;
    return;
  }

  if (plan.length === 0) {
    console.log(dim("Nothing to import — no matching keys found in the requested sources."));
    if (opts.from === "1password" && !hasOpSources()) {
      console.log(dim("No 1Password source is configured. See: claudish config → 1Password tab"));
    }
    return;
  }

  const writable = plan.filter((e) => !e.problem && e.action !== "unchanged");
  const overwrites = writable.filter((e) => e.action === "overwrite");

  console.log(strong(`Import plan — ${plan.length} key(s) considered`));
  renderPlan(plan);
  console.log();

  if (writable.length === 0) {
    console.log(dim("Everything is already stored with the same value. Nothing to do."));
    return;
  }
  if (overwrites.length > 0) {
    console.log(
      warn(
        `${overwrites.length} existing keychain item(s) will be REPLACED. The previous values cannot be recovered.`
      )
    );
  }

  if (opts.dryRun) {
    console.log(dim("--dry-run: nothing was written."));
    return;
  }

  if (!opts.yes) {
    const { confirm } = await import("@inquirer/prompts");
    const proceed = await confirm({
      message: `Store ${writable.length} key(s) in the macOS Keychain?`,
      default: overwrites.length === 0,
    });
    if (!proceed) {
      console.log(dim("Cancelled — nothing was written."));
      return;
    }
  }

  const { written, failures } = writeImportEntries(writable);
  reportImportResult(written, failures);
  const skipped = plan.filter((e) => e.problem);
  if (skipped.length > 0) {
    console.log(warn(`${skipped.length} key(s) skipped — see the plan above.`));
  }
}

// ---------------------------------------------------------------------------
// set / rm / enable / disable
// ---------------------------------------------------------------------------

/**
 * Read a secret without it ever reaching argv.
 *
 * Piped stdin wins so the command is scriptable (`echo $KEY | claudish keychain
 * set FOO`); otherwise a hidden prompt. There is deliberately no `--value`
 * flag: it would put the secret on the command line, where `ps` and the shell
 * history both expose it.
 */
async function readSecretInteractively(envVar: string): Promise<string | null> {
  if (!process.stdin.isTTY) {
    const piped = await new Response(Bun.stdin.stream()).text();
    const value = piped.replace(/\r?\n$/, "");
    return value.length > 0 ? value : null;
  }
  const { password } = await import("@inquirer/prompts");
  const value = await password({ message: `Value for ${envVar}:`, mask: "•" });
  return value.length > 0 ? value : null;
}

async function keychainSet(envVar: string | undefined): Promise<void> {
  if (!requireKeychain()) return;
  if (!envVar) {
    console.error(bad("Usage: claudish keychain set <ENV_VAR>"));
    process.exitCode = 1;
    return;
  }
  if (!isValidKeychainVarName(envVar)) {
    console.error(bad(`"${envVar}" is not a valid environment variable name.`));
    process.exitCode = 1;
    return;
  }

  const value = await readSecretInteractively(envVar);
  if (!value) {
    console.log(dim("Aborted — no value given."));
    return;
  }

  try {
    writeKeychainSecret(envVar, value);
  } catch (err) {
    console.error(bad(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    return;
  }

  if (!isKeychainEnabled()) setKeychainEnabled(true);
  console.log(ok(`Stored ${envVar} ${dim(valueTail(value))} in the macOS Keychain.`));
  if (process.env[envVar]) {
    console.log(
      warn(`Note: ${envVar} is also set in this shell, and an env var takes precedence at runtime.`)
    );
  }
}

function keychainRemove(envVar: string | undefined): void {
  if (!requireKeychain()) return;
  if (!envVar) {
    console.error(bad("Usage: claudish keychain rm <ENV_VAR>"));
    process.exitCode = 1;
    return;
  }
  try {
    const removed = deleteKeychainSecret(envVar);
    console.log(
      removed
        ? ok(`Removed ${envVar} from the macOS Keychain.`)
        : dim(`${envVar} was not in the keychain — nothing to remove.`)
    );
  } catch (err) {
    console.error(bad(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

function keychainToggle(enabled: boolean): void {
  if (enabled && !requireKeychain()) return;
  setKeychainEnabled(enabled);
  invalidateKeychainCache();
  console.log(
    enabled
      ? ok("Keychain backend enabled — claudish will now read keys from the macOS Keychain.")
      : ok("Keychain backend disabled. Stored items were left untouched.")
  );
  if (!enabled) {
    console.log(dim("Remove the items themselves with: claudish keychain rm <ENV_VAR>"));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`${strong("claudish keychain")} — macOS Keychain credential backend

  ${strong("status")}                  Backend state and how many keys are stored (default)
  ${strong("list")}                    Stored variables, with ${dim("••••1234")} identification tails
  ${strong("import")} [options]        Copy secrets from env vars / 1Password into the keychain
  ${strong("set")} <ENV_VAR>           Store one secret (prompted, or piped on stdin)
  ${strong("rm")} <ENV_VAR>            Remove one secret
  ${strong("enable")} | ${strong("disable")}        Turn the backend on/off (moves no secrets)

${strong("import options")}
  --from env|1password|all   Source to copy from (default: all)
  --only VAR,VAR             Restrict to these variables
  --dry-run                  Show the plan and stop
  --yes                      Skip the confirmation

Resolution order: ${dim("env var → alias → config.json → macOS Keychain → 1Password")}
`);
}

/** Parse `--only A,B` / `--only=A,B` into a name list. */
function parseOnly(args: string[]): string[] | undefined {
  const idx = args.findIndex((a) => a === "--only" || a.startsWith("--only="));
  if (idx === -1) return undefined;
  const raw = args[idx].includes("=") ? args[idx].split("=").slice(1).join("=") : args[idx + 1];
  if (!raw) return undefined;
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

function parseFrom(args: string[]): ImportOptions["from"] {
  const idx = args.findIndex((a) => a === "--from" || a.startsWith("--from="));
  if (idx === -1) return "all";
  const raw = (args[idx].includes("=") ? args[idx].split("=").slice(1).join("=") : args[idx + 1])
    ?.trim()
    .toLowerCase();
  if (raw === "env" || raw === "1password" || raw === "all") return raw;
  if (raw === "op") return "1password";
  return "all";
}

/**
 * Flags that consume the NEXT argument as their value.
 *
 * Without this, a naive "anything not starting with -" positional scan mistakes
 * a flag's VALUE for the subcommand: `claudish keychain list --config /tmp/x.json`
 * would dispatch on "/tmp/x.json". `--config` is a global claudish flag, so it
 * can appear on any subcommand and this is not a hypothetical.
 */
const VALUE_FLAGS = new Set(["--config", "--from", "--only"]);

/** Positional arguments, with flag values excluded. */
function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      // `--flag=value` carries its value inline; only the separated form eats
      // the next argument.
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * @param args everything AFTER the `keychain` token.
 */
export async function keychainCommand(args: string[]): Promise<void> {
  const positional = positionalArgs(args);
  const sub = positional[0] ?? "status";

  switch (sub) {
    case "status":
      keychainStatus();
      return;
    case "list":
    case "ls":
      keychainList();
      return;
    case "import":
      await keychainImport({
        from: parseFrom(args),
        only: parseOnly(args),
        dryRun: args.includes("--dry-run"),
        yes: args.includes("--yes") || args.includes("-y"),
      });
      return;
    case "set":
      await keychainSet(positional[1]);
      return;
    case "rm":
    case "remove":
    case "delete":
      keychainRemove(positional[1]);
      return;
    case "enable":
      keychainToggle(true);
      return;
    case "disable":
      keychainToggle(false);
      return;
    case "help":
      usage();
      return;
    default:
      console.error(bad(`Unknown subcommand: ${sub}`));
      usage();
      process.exitCode = 1;
  }
}
