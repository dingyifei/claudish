/**
 * update-prompt.ts — the interactive launcher's update step.
 *
 * `checkForUpdates` (update-checker.ts) only tells the user a newer version
 * exists. At an interactive prompt there is a human right there, so this asks
 * whether to install it, runs the install, and then stops: the running process
 * still has the OLD build loaded in memory, so continuing into a session after
 * an upgrade would silently run the version the user just replaced.
 *
 * Lives in its own module because `update-command.ts` already imports
 * `update-checker.ts`; putting this in either one would close an import cycle.
 */

import { cliAnsi } from "./theme/ansi.js";
import { formatUpdateNotice, getLatestVersionCached, isUpgrade } from "./update-checker.js";
import { performUpdate } from "./update-command.js";

/**
 * What the caller must do next.
 * - `continue` — no update, declined, or the install failed. Carry on.
 * - `restart-required` — a new version is installed. Exit; this process is stale.
 */
export type UpdateStepResult = "continue" | "restart-required";

export interface InteractiveUpdateOptions {
  /** Suppress all output and skip the prompt entirely. */
  quiet?: boolean;
  /**
   * May we ask? False falls back to the notification-only line. Callers pass
   * false when nothing can answer: `--stdin`, a piped session, no TTY.
   */
  canPrompt?: boolean;
}

/** Ask a yes/no question on stderr, defaulting to yes on a bare Enter. */
async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let answered = false;

    rl.question(question, (value) => {
      answered = true;
      rl.close();
      const normalized = value.trim().toLowerCase();
      resolve(!(normalized === "n" || normalized === "no"));
    });

    // Ctrl-D closes the interface WITHOUT running the question callback, so a
    // promise that only resolves there would hang startup forever. Decline on
    // EOF: with nobody at the keyboard, never begin an install.
    rl.on("close", () => {
      if (!answered) resolve(false);
    });
  });
}

/**
 * Check for a newer claudish and, when a human can answer, offer to install it.
 *
 * @param currentVersion - The running version.
 * @returns Whether the caller should continue or exit for a restart.
 */
export async function checkForUpdatesInteractive(
  currentVersion: string,
  options: InteractiveUpdateOptions = {}
): Promise<UpdateStepResult> {
  const { quiet = false, canPrompt = true } = options;

  const latestVersion = await getLatestVersionCached();
  if (!latestVersion || !isUpgrade(latestVersion, currentVersion)) {
    return "continue";
  }

  if (quiet) {
    return "continue";
  }

  const { RESET, BOLD, GREEN, CYAN, DIM, YELLOW } = cliAnsi();

  // Nothing can answer a prompt here — degrade to the notification-only line.
  if (!canPrompt || !process.stdin.isTTY) {
    console.error("");
    console.error(formatUpdateNotice(currentVersion, latestVersion));
    console.error("");
    return "continue";
  }

  console.error("");
  console.error(formatUpdateNotice(currentVersion, latestVersion, { hint: false }));
  console.error("");

  const accepted = await confirm(`  ${BOLD}Update now?${RESET} ${DIM}[Y/n]${RESET} `);

  if (!accepted) {
    console.error(
      `  ${DIM}Skipped. Run${RESET} ${BOLD}${CYAN}claudish update${RESET} ${DIM}when you are ready.${RESET}\n`
    );
    return "continue";
  }

  const outcome = await performUpdate();

  if (outcome.status === "updated") {
    console.error("");
    console.error(
      `  ${GREEN}✓${RESET} ${BOLD}Updated to ${latestVersion}.${RESET} ${DIM}This process is still running ${currentVersion}.${RESET}`
    );
    console.error(
      `  ${DIM}Run${RESET} ${BOLD}${CYAN}claudish${RESET} ${DIM}again to start.${RESET}`
    );
    console.error("");
    return "restart-required";
  }

  // `performUpdate` already printed the failure and the manual command.
  console.error(`  ${YELLOW}Continuing on ${currentVersion}.${RESET}\n`);
  return "continue";
}
