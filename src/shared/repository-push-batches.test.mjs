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
});
