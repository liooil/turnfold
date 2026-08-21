import {describe, expect, test} from "bun:test";
import {repositoryPushBatches} from "./repository-push-batches.ts";

describe("repository push batches", () => {
  test("keeps requests within server limits", () => {
    const objects = Array.from({length: 2001}, (_, index) => ({id: `sha256:${index}`}));
    const refs = Array.from({length: 201}, (_, index) => ({conversationId: String(index)}));
    const batches = repositoryPushBatches({repositoryId: "local:test", objects, refs});
    expect(batches.map((batch) => [batch.objects.length, batch.refs.length])).toEqual([
      [1000, 0], [1000, 0], [1, 0], [0, 100], [0, 100], [0, 1]
    ]);
  });

  test("deduplicates shared message objects", () => {
    const object = {id: "sha256:shared"};
    const batches = repositoryPushBatches({repositoryId: "local:test", objects: [object, object], refs: []});
    expect(batches).toHaveLength(1);
    expect(batches[0].objects).toHaveLength(1);
  });

  test("splits object batches by their encoded request size", () => {
    const object = {id: "sha256:first", padding: "x".repeat(90)};
    const oneObjectBytes = new TextEncoder().encode(JSON.stringify({
      repositoryId: "local:test",
      objects: [object],
      refs: []
    })).byteLength;
    const batches = repositoryPushBatches({
      repositoryId: "local:test",
      objects: [object, {...object, id: "sha256:second"}],
      refs: []
    }, oneObjectBytes + 5);
    expect(batches.map((batch) => batch.objects.length)).toEqual([1, 1]);
  });

  test("rejects a single item larger than the transport budget", () => {
    const object = {id: "sha256:large", padding: "x".repeat(90)};
    const oneObjectBytes = new TextEncoder().encode(JSON.stringify({
      repositoryId: "local:test",
      objects: [object],
      refs: []
    })).byteLength;
    expect(() => repositoryPushBatches({repositoryId: "local:test", objects: [object], refs: []}, oneObjectBytes - 1))
      .toThrow("object exceeds");
  });

  test("includes object provenance in the encoded body budget", () => {
    const object = {id: "sha256:first", padding: "x".repeat(30)};
    const sourceRepositoryId = `local:${"source".repeat(12)}`;
    const oneObjectBytes = new TextEncoder().encode(JSON.stringify({
      repositoryId: "local:test",
      objects: [object],
      objectRepositoryIds: {[object.id]: sourceRepositoryId},
      refs: []
    })).byteLength;
    const second = {...object, id: "sha256:other"};
    const batches = repositoryPushBatches({
      repositoryId: "local:test",
      objectRepositoryIds: {
        [object.id]: sourceRepositoryId,
        [second.id]: sourceRepositoryId
      },
      objects: [object, second],
      refs: []
    }, oneObjectBytes);
    expect(batches.map((batch) => batch.objects.length)).toEqual([1, 1]);
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(oneObjectBytes);
    }
  });
});
