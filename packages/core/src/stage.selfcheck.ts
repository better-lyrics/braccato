import { strict as assert } from "node:assert";
import { overlapsPrevious, planStage, type StageItem, stageEnterTimes } from "./stage";

const line = (start: number, end: number): StageItem => ({ kind: "line", start, end });
const instrumental = (start: number, end: number): StageItem => ({ kind: "instrumental", start, end });
const credits = (start: number): StageItem => ({ kind: "credits", start, end: Number.POSITIVE_INFINITY });

const SUBTITLE = { preview: false };
const ROLLING = { preview: true };

// -- Enter times --------------------------------------------

{
  const items = [line(10, 12), line(12, 14)];
  const [first, second] = stageEnterTimes(items, SUBTITLE);
  assert.equal(first, 9.5, "the first item enters half a second early");
  assert.equal(second, 11.88, "a back-to-back subtitle line hands off just before it starts, not half a second early");
}

{
  const items = [line(10, 11), line(14, 16)];
  assert.equal(stageEnterTimes(items, SUBTITLE)[1], 13.5, "after a real gap the next line enters half a second early");
}

{
  const items = [line(10, 12), line(12, 14)];
  assert.equal(stageEnterTimes(items, ROLLING)[1], 11.5, "rolling always enters half a second early");
}

// -- Overlap --------------------------------------------

{
  const items = [line(0, 2.6), line(2.1, 4.5)];
  assert.equal(overlapsPrevious(items, 1), true, "starting 0.5 s before the previous line ends is an overlap");
  assert.equal(overlapsPrevious([line(0, 2), line(1.9, 3)], 1), false, "a 0.1 s touch is not an overlap");
  assert.equal(overlapsPrevious([instrumental(0, 3), line(2, 4)], 1), false, "only sung lines overlap");
}

// -- Subtitle roles --------------------------------------------

{
  const items = [line(10, 12), line(12, 14)];
  assert.deepEqual(planStage(items, 5, SUBTITLE), ["queued", "queued"], "nothing is on stage before the lead");
  assert.deepEqual(planStage(items, 10.5, SUBTITLE), ["current", "queued"], "subtitle shows no next line");
  assert.deepEqual(
    planStage(items, 11.9, SUBTITLE),
    ["gone", "current"],
    "a back-to-back handoff never shows both lines"
  );
}

{
  const items = [line(0, 2.6), line(2.1, 4.5), line(4.7, 7)];
  assert.deepEqual(
    planStage(items, 2.3, SUBTITLE),
    ["previous", "current", "queued"],
    "during a real overlap the old line stays while it is still sung"
  );
  assert.deepEqual(planStage(items, 2.7, SUBTITLE), ["gone", "current", "queued"], "and leaves once it ends");
}

// -- Rolling roles --------------------------------------------

{
  const items = [line(10, 12), line(12, 14), line(14, 16)];
  assert.deepEqual(planStage(items, 10.5, ROLLING), ["current", "next", "queued"], "rolling previews the next item");
  assert.deepEqual(
    planStage(items, 11.6, ROLLING),
    ["previous", "current", "next"],
    "rolling keeps the finished line for a moment"
  );
  assert.deepEqual(planStage(items, 12.4, ROLLING), ["gone", "current", "next"], "then lets it go");
}

// -- Instrumentals and credits --------------------------------------------

{
  const items = [instrumental(0, 3), line(3, 5), credits(5)];
  assert.deepEqual(planStage(items, 1, SUBTITLE), ["current", "queued", "queued"], "the intro note takes the stage");
  assert.deepEqual(planStage(items, 6, SUBTITLE), ["gone", "gone", "current"], "the credits end the song");
  assert.deepEqual(
    planStage(items, 2.8, SUBTITLE),
    ["gone", "current", "queued"],
    "a note is never kept as the previous item"
  );
}

// -- Invariants --------------------------------------------

{
  const items = [line(0, 5), line(1, 2)];
  const roles = planStage(items, 1, SUBTITLE);
  assert.equal(roles.filter(role => role === "current").length, 1, "exactly one current item once anything entered");
}

{
  assert.deepEqual(planStage([], 3, SUBTITLE), [], "an empty song has an empty stage");
}

console.log("stage scheduler self-check passed");
