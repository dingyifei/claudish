import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resetVertexProjectDiscovery,
  resolveVertexConfig,
  selectVertexAuthMode,
} from "./vertex-auth.js";

const ENV_KEYS = ["VERTEX_PROJECT", "VERTEX_LOCATION", "GOOGLE_CLOUD_PROJECT"] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetVertexProjectDiscovery();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetVertexProjectDiscovery();
});

describe("Vertex account selection", () => {
  test("a selected project uses project authentication", () => {
    expect(selectVertexAuthMode({ project: "chosen-project" })).toBe("project");
  });

  // The Express API-key path was removed; there is no alternate auth mode to restore here.

  test("neither mode is available without configuration", () => {
    expect(selectVertexAuthMode({})).toBeNull();
  });
});

describe("Vertex project and location resolution", () => {
  test("VERTEX_PROJECT and VERTEX_LOCATION take precedence", async () => {
    process.env.VERTEX_PROJECT = "vertex-project";
    process.env.VERTEX_LOCATION = "australia-southeast1";
    process.env.GOOGLE_CLOUD_PROJECT = "lower-precedence-project";

    await expect(resolveVertexConfig()).resolves.toEqual({
      projectId: "vertex-project",
      location: "australia-southeast1",
    });
  });

  test("defaults the location when VERTEX_LOCATION is absent", async () => {
    process.env.VERTEX_PROJECT = "vertex-project";

    await expect(resolveVertexConfig()).resolves.toEqual({
      projectId: "vertex-project",
      location: "us-central1",
    });
  });

  test("a reset keeps sequential environment changes isolated", async () => {
    process.env.VERTEX_PROJECT = "first-project";
    await expect(resolveVertexConfig()).resolves.toEqual({
      projectId: "first-project",
      location: "us-central1",
    });

    resetVertexProjectDiscovery();
    process.env.VERTEX_PROJECT = "second-project";

    await expect(resolveVertexConfig()).resolves.toEqual({
      projectId: "second-project",
      location: "us-central1",
    });
  });
});
