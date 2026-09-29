import { strict as assert } from "node:assert";
import { layoutStage, overlapsPrevious, planStage, type StageItem, type StageMetrics, stageEnterTimes } from "./stage";

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

// -- Geometry --------------------------------------------

const metric = (height: number, left = 100, width = 300, originX = 0.5): StageMetrics => ({
  height,
  left,
  width,
  originX,
});
const GEOMETRY = { stageHeight: 500, gap: 10, activeScale: 1, inactiveScale: 0.95, preview: false };

{
  const items = [line(0, 2), line(2, 4)];
  const { placements, box } = layoutStage(
    ["current", "queued"],
    items,
    [metric(40), metric(60)],
    [null, null],
    GEOMETRY
  );
  assert.equal(placements[0].y, 460, "a lone current line sits on the stage floor");
  assert.equal(placements[0].visible, true);
  assert.equal(placements[1].y, 450, "a queued subtitle line waits just below its own spot");
  assert.equal(placements[1].visible, false);
  assert.deepEqual(box, { x: 100, y: 460, width: 300, height: 40 }, "the box hugs the one sung line");
}

{
  const items = [line(0, 2), line(2, 4)];
  const { placements, box } = layoutStage(["current", "next"], items, [metric(40), metric(50)], [null, null], {
    ...GEOMETRY,
    preview: true,
  });
  assert.equal(placements[1].y, 450, "the next line sits on the floor");
  assert.equal(placements[0].y, 400, "the current line sits a gap above it");
  assert.deepEqual(box, { x: 100, y: 400, width: 300, height: 40 }, "the next line is not plated");
}

{
  const items = [line(0, 2.6), line(2.1, 4.5)];
  const { placements, box } = layoutStage(
    ["previous", "current"],
    items,
    [metric(40, 50, 400), metric(40)],
    [null, null],
    GEOMETRY
  );
  assert.equal(placements[1].y, 460);
  assert.equal(placements[0].y, 410, "the overlapping line sits a gap above the current one");
  assert.ok(box !== null && box.y < 460 && box.y + box.height === 500, "an overlap grows the box upward");
  assert.ok(box !== null && box.x < 100, "and widens it to the wider line");
}

{
  const items = [instrumental(0, 3), line(3, 5)];
  const { box } = layoutStage(["current", "queued"], items, [metric(40), metric(40)], [null, null], GEOMETRY);
  assert.equal(box, null, "a note on its own gets no box");
}

{
  const items = [line(0, 2), credits(2)];
  const { box } = layoutStage(["gone", "current"], items, [metric(40), metric(60)], [300, null], GEOMETRY);
  assert.deepEqual(box, { x: 100, y: 440, width: 300, height: 60 }, "focused credits are plated");
}

{
  const items = [line(0, 2), line(2, 4)];
  const { placements } = layoutStage(["gone", "current"], items, [metric(40), metric(40)], [460, null], GEOMETRY);
  assert.equal(placements[0].y, 450, "a leaving line drifts up from where it was");
}

console.log("stage scheduler self-check passed");
