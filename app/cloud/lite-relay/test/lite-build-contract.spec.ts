import { describe, expect, it } from "vitest";

import { canSendWithSchema, createLiteBuildDescriptor } from "../src/lite-build-contract";

describe("Lite build separation contract", () => {
  it("homeとtravelでcache・storage namespaceを共有しない", () => {
    const home = createLiteBuildDescriptor({ mode: "home", buildId: "b1", apiSchemaVersion: 1, origin: "https://home.test" });
    const travel = createLiteBuildDescriptor({
      mode: "travel",
      buildId: "b1",
      apiSchemaVersion: 1,
      origin: "https://travel.test",
    });
    expect(home.cache_name).not.toBe(travel.cache_name);
    expect(home.storage_namespace).not.toBe(travel.storage_namespace);
    expect(home.origin).not.toBe(travel.origin);
  });

  it("API schema不一致時は送信を許可しない", () => {
    expect(canSendWithSchema(1, 1)).toBe(true);
    expect(canSendWithSchema(1, 2)).toBe(false);
  });
});
