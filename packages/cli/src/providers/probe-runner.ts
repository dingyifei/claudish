import { type ProbeLinkInput, type ProbeResult, probeLink } from "./probe-live.js";

// Interactive probes must outlive the slowest legitimate credential path.
// Antigravity may spend up to 40s refreshing the shared token, and its own
// bounded 429 retries can take ~27s. The old 15s UI deadline cut either path
// off and reported a timeout before the provider returned an attributable
// result. CLI --probe remains independently configurable via --probe-timeout.
export const INTERACTIVE_PROBE_TIMEOUT_MS = 60_000;

export function pinProbeModelSpec(link: Pick<ProbeLinkInput, "provider" | "modelSpec">): string {
  // native-anthropic is the ONE provider the proxy resolves by the ABSENCE of a
  // provider@ prefix (isNative = no "/" and no "@" → nativeHandler). Prefixing
  // it would set hasExplicitProvider=true and route it AWAY from the passthrough
  // (→ "not a valid model ID"). So keep its model spec BARE.
  if (link.provider === "native-anthropic") return link.modelSpec;
  return link.modelSpec.includes("@") ? link.modelSpec : `${link.provider}@${link.modelSpec}`;
}

export function probeProviderRoute(
  proxyUrl: string,
  link: ProbeLinkInput,
  timeoutMs: number
): Promise<ProbeResult> {
  return probeLink(
    proxyUrl,
    {
      ...link,
      modelSpec: pinProbeModelSpec(link),
    },
    timeoutMs
  );
}
