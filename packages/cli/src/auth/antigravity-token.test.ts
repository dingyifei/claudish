import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AgyRefreshOutcome,
  type AntigravityToken,
  type AntigravityTokenDeps,
  _resetAntigravityTokenState,
  deleteSharedAntigravityToken,
  forceRefreshAntigravityToken,
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
  writeSharedAntigravityToken,
} from "./antigravity-token.js";

const PREFIX = "go-keyring-base64:";
const NOW = Date.parse("2026-08-04T00:00:00.000Z");

interface StoreRecord {
  token: AntigravityToken;
  id_token?: string;
  auth_method?: string;
  [key: string]: unknown;
}

function makeToken(overrides: Partial<AntigravityToken> = {}): AntigravityToken {
  return {
    access_token: "expired-access-token",
    token_type: "Bearer",
    refresh_token: "refresh-token",
    expiry: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function encodeStore(record: StoreRecord): string {
  return PREFIX + Buffer.from(JSON.stringify(record), "utf8").toString("base64");
}

function decodeStore(raw: string): StoreRecord {
  expect(raw.startsWith(PREFIX)).toBe(true);
  return JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8"));
}

function makeFakeDeps(
  initialStore: string | null,
  onRefresh: (
    setStore: (raw: string | null) => void,
    getStore: () => string | null
  ) => void = () => {},
  refreshOutcome: AgyRefreshOutcome = { kind: "ran" }
) {
  let store = initialStore;
  let refreshCallCount = 0;
  let deleteCallCount = 0;
  const writes: string[] = [];
  const setStore = (raw: string | null): void => {
    store = raw;
  };

  const deps: AntigravityTokenDeps = {
    readStore: () => store,
    writeStore: (raw) => {
      writes.push(raw);
      store = raw;
    },
    deleteStore: () => {
      deleteCallCount += 1;
      store = null;
    },
    runAgyRefresh: () => {
      refreshCallCount += 1;
      onRefresh(setStore, () => store);
      return refreshOutcome;
    },
    now: () => NOW,
  };

  return {
    deps,
    writes,
    getStore: () => store,
    getRefreshCallCount: () => refreshCallCount,
    getDeleteCallCount: () => deleteCallCount,
  };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected promise to reject");
}

beforeEach(() => {
  _resetAntigravityTokenState();
});

describe("readSharedAntigravityToken", () => {
  test("parses a valid go-keyring-base64 value", () => {
    const token = makeToken({
      access_token: "stored-access-token",
      expiry: new Date(NOW + 10 * 60_000).toISOString(),
    });
    const fake = makeFakeDeps(
      encodeStore({ token, id_token: "stored-id-token", auth_method: "oauth" })
    );

    expect(readSharedAntigravityToken(fake.deps)).toEqual(token);
  });

  test("returns null for an unsupported keyring prefix", () => {
    const fake = makeFakeDeps("go-keyring-chunked:opaque-value");

    expect(readSharedAntigravityToken(fake.deps)).toBeNull();
  });

  test("returns null for an empty store", () => {
    const fake = makeFakeDeps(null);

    expect(readSharedAntigravityToken(fake.deps)).toBeNull();
  });
});

describe("writeSharedAntigravityToken", () => {
  test("preserves record metadata and round-trips the replacement token", () => {
    const replacement = makeToken({
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      expiry: new Date(NOW + 60 * 60_000).toISOString(),
    });
    const fake = makeFakeDeps(
      encodeStore({
        token: makeToken(),
        id_token: "preserved-id-token",
        auth_method: "antigravity-oauth",
      })
    );

    writeSharedAntigravityToken(replacement, fake.deps);

    expect(fake.writes).toHaveLength(1);
    expect(decodeStore(fake.writes[0])).toEqual({
      token: replacement,
      id_token: "preserved-id-token",
      auth_method: "antigravity-oauth",
    });
    expect(readSharedAntigravityToken(fake.deps)).toEqual(replacement);
  });
});

describe("deleteSharedAntigravityToken", () => {
  test("uses the injected delete path", () => {
    const fake = makeFakeDeps(encodeStore({ token: makeToken() }));

    deleteSharedAntigravityToken(fake.deps);

    expect(fake.getDeleteCallCount()).toBe(1);
    expect(fake.getStore()).toBeNull();
  });
});

describe("getValidAntigravityAccessToken", () => {
  test.skipIf(process.platform !== "darwin")(
    "returns a valid token without asking agy to refresh",
    async () => {
      const token = makeToken({
        access_token: "valid-access-token",
        expiry: new Date(NOW + 10 * 60_000).toISOString(),
      });
      const fake = makeFakeDeps(encodeStore({ token }));

      await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("valid-access-token");
      expect(fake.getRefreshCallCount()).toBe(0);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "re-reads and returns the token refreshed by agy",
    async () => {
      const freshToken = makeToken({
        access_token: "fresh-access-token",
        refresh_token: "rotated-refresh-token",
        expiry: new Date(NOW + 60 * 60_000).toISOString(),
      });
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }), (setStore) => {
        setStore(encodeStore({ token: freshToken }));
      });

      await expect(getValidAntigravityAccessToken(fake.deps)).resolves.toBe("fresh-access-token");
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "explains when the Antigravity CLI is not installed",
    async () => {
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }), () => {}, {
        kind: "not-installed",
      });

      const message = await rejectionMessage(getValidAntigravityAccessToken(fake.deps));

      expect(message).toContain("not installed");
      expect(message).toContain("claudish login antigravity");
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "reports a timed-out auto-update without claiming the session was revoked",
    async () => {
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }), () => {}, { kind: "timeout" });

      const message = await rejectionMessage(getValidAntigravityAccessToken(fake.deps));

      expect(message).toMatch(/did not finish within \d+s/);
      expect(message).toContain("auto-updates");
      expect(message).toContain("Try again");
      expect(message).not.toContain("revoked");
      expect(message).not.toContain("claudish login antigravity");
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "includes the Antigravity CLI failure detail",
    async () => {
      const detail = "refresh command failed: upstream account unavailable";
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }), () => {}, {
        kind: "failed",
        detail,
      });

      const message = await rejectionMessage(getValidAntigravityAccessToken(fake.deps));

      expect(message).toContain(detail);
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "reports a revoked session when agy runs but leaves the expired store unchanged",
    async () => {
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }));

      const message = await rejectionMessage(getValidAntigravityAccessToken(fake.deps));

      expect(message).toContain("revoked");
      expect(message).toContain("claudish login antigravity");
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "throws an actionable error when no shared session exists",
    async () => {
      const fake = makeFakeDeps(null);

      await expect(getValidAntigravityAccessToken(fake.deps)).rejects.toThrow(
        /claudish login antigravity/
      );
      expect(fake.getRefreshCallCount()).toBe(0);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "shares one agy refresh across concurrent callers",
    async () => {
      const freshToken = makeToken({
        access_token: "single-flight-access-token",
        expiry: new Date(NOW + 60 * 60_000).toISOString(),
      });
      const fake = makeFakeDeps(encodeStore({ token: makeToken() }), (setStore) => {
        setStore(encodeStore({ token: freshToken }));
      });

      const first = getValidAntigravityAccessToken(fake.deps);
      const second = getValidAntigravityAccessToken(fake.deps);

      await expect(Promise.all([first, second])).resolves.toEqual([
        "single-flight-access-token",
        "single-flight-access-token",
      ]);
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );
});

describe("forceRefreshAntigravityToken", () => {
  test.skipIf(process.platform !== "darwin")(
    "forces agy to re-mint a locally valid token rejected upstream",
    async () => {
      const original = makeToken({
        access_token: "server-rejected-token",
        expiry: new Date(NOW + 30 * 60_000).toISOString(),
      });
      let agyCalls = 0;
      const fake = makeFakeDeps(
        encodeStore({ token: original, id_token: "preserved-id-token" }),
        (setStore, getStore) => {
          const raw = getStore();
          if (!raw) return;
          const rec = decodeStore(raw);
          if (Date.parse(rec.token.expiry) > NOW) return;

          setStore(
            encodeStore({
              ...rec,
              token: {
                ...rec.token,
                access_token: "fresh-token",
                expiry: new Date(NOW + 60 * 60_000).toISOString(),
              },
            })
          );
          agyCalls += 1;
        }
      );

      await expect(forceRefreshAntigravityToken(fake.deps)).resolves.toBe("fresh-token");
      expect(agyCalls).toBe(1);
      expect(fake.getRefreshCallCount()).toBe(1);
      expect(decodeStore(fake.getStore()!).token.access_token).toBe("fresh-token");
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "restores the original store byte-for-byte when agy does not write",
    async () => {
      const originalStore = encodeStore({
        token: makeToken({
          access_token: "original-token",
          expiry: new Date(NOW + 30 * 60_000).toISOString(),
        }),
        id_token: "original-id-token",
        auth_method: "oauth",
        preserved_field: "preserved-value",
      });
      const fake = makeFakeDeps(originalStore);

      await expect(forceRefreshAntigravityToken(fake.deps)).rejects.toThrow(
        /could not be re-minted/
      );
      expect(fake.getStore()).toBe(originalStore);
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "keeps agy's unusable replacement instead of restoring the original",
    async () => {
      const agyToken = makeToken({
        access_token: "agy-stale-token",
        expiry: new Date(NOW + 60_000).toISOString(),
      });
      const fake = makeFakeDeps(
        encodeStore({
          token: makeToken({
            access_token: "original-token",
            expiry: new Date(NOW + 30 * 60_000).toISOString(),
          }),
        }),
        (setStore) => setStore(encodeStore({ token: agyToken, id_token: "agy-id-token" }))
      );

      await expect(forceRefreshAntigravityToken(fake.deps)).rejects.toThrow(
        /could not be re-minted/
      );
      expect(decodeStore(fake.getStore()!)).toEqual({
        token: agyToken,
        id_token: "agy-id-token",
      });
      expect(decodeStore(fake.getStore()!).token.access_token).not.toBe("original-token");
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "rejects when no Antigravity session exists",
    async () => {
      const fake = makeFakeDeps(null);

      await expect(forceRefreshAntigravityToken(fake.deps)).rejects.toThrow(
        /No Antigravity session found/
      );
      expect(fake.getRefreshCallCount()).toBe(0);
      expect(fake.writes).toHaveLength(0);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "makes the refreshed token visible to the next valid-token lookup",
    async () => {
      const fake = makeFakeDeps(
        encodeStore({
          token: makeToken({
            access_token: "original-token",
            expiry: new Date(NOW + 30 * 60_000).toISOString(),
          }),
        }),
        (setStore, getStore) => {
          const raw = getStore();
          if (!raw) return;
          const rec = decodeStore(raw);
          if (Date.parse(rec.token.expiry) > NOW) return;
          setStore(
            encodeStore({
              ...rec,
              token: {
                ...rec.token,
                access_token: "fresh-token",
                expiry: new Date(NOW + 60 * 60_000).toISOString(),
              },
            })
          );
        }
      );

      // Leave the original-token lookup pending in the single-flight slot, then
      // force the refresh and ask again before any promise continuation runs.
      // Without forceRefreshAntigravityToken() dropping cached state up front,
      // the final lookup aliases the stale promise and returns original-token.
      const staleLookup = getValidAntigravityAccessToken(fake.deps);
      const forcedRefresh = forceRefreshAntigravityToken(fake.deps);
      const postRefreshLookup = getValidAntigravityAccessToken(fake.deps);

      await expect(staleLookup).resolves.toBe("original-token");
      await expect(forcedRefresh).resolves.toBe("fresh-token");
      await expect(postRefreshLookup).resolves.toBe("fresh-token");
      expect(fake.getRefreshCallCount()).toBe(1);
    }
  );
});
