import { strict as assert } from "node:assert";
import { layoutStage, overlapsPrevious, planStage, type StageItem, type StageMetrics, stageEnterTimes } from "./stage";

const line = (start: number, end: number): StageItem => ({ kind: "line", start, end });
const instrumental = (start: number, end: number): StageItem => ({ kind: "instrumental", start, end });
const credits = (start: number): StageItem => ({ kind: "credits", start, end: Number.POSITIVE_INFINITY });
const blank = (start: number, end: number): StageItem => ({ kind: "blank", start, end });

// -- Enter times --------------------------------------------

{
  const items = [line(10, 12), line(12, 14)];
  const [first, second] = stageEnterTimes(items);
  assert.equal(first, 9.5, "the first item enters half a second early");
  assert.equal(second, 11.88, "a back-to-back subtitle line hands off just before it starts, not half a second early");
}

{
  const items = [line(10, 11), line(14, 16)];
  assert.equal(stageEnterTimes(items)[1], 13.5, "after a real gap the next line enters half a second early");
}

{
  const items = [line(10, 11.8), line(12, 14)];
  assert.ok(
    Math.abs(stageEnterTimes(items)[1] - 11.68) < 1e-9,
    "a gap shorter than the lead hands off just after the previous line ends"
  );
}

{
  assert.deepEqual(stageEnterTimes([line(10, 12)]), [9.5], "a single line enters half a second early");
  assert.deepEqual(planStage([line(10, 12)], 11), ["current"], "a single line holds the stage");
  assert.deepEqual(planStage([line(10, 12)], 20), ["current"], "and keeps it after it ends");
}

{
  const items = [line(10, 12), instrumental(12, 14)];
  assert.equal(stageEnterTimes(items)[1], 11.88, "a note after a sung line is handed off to like a line");
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
  assert.deepEqual(planStage(items, 5), ["queued", "queued"], "nothing is on stage before the lead");
  assert.deepEqual(planStage(items, 10.5), ["current", "queued"], "subtitle shows no next line");
  assert.deepEqual(planStage(items, 11.9), ["gone", "current"], "a back-to-back handoff never shows both lines");
}

{
  const items = [line(0, 2.6), line(2.1, 4.5), line(4.7, 7)];
  assert.deepEqual(
    planStage(items, 2.3),
    ["previous", "current", "queued"],
    "during a real overlap the old line stays while it is still sung"
  );
  assert.deepEqual(planStage(items, 2.7), ["gone", "current", "queued"], "and leaves once it ends");
}

// -- Instrumentals and credits --------------------------------------------

{
  const items = [instrumental(0, 3), line(3, 5), credits(5)];
  assert.deepEqual(planStage(items, 1), ["current", "queued", "queued"], "the intro note takes the stage");
  assert.deepEqual(planStage(items, 6), ["gone", "gone", "current"], "the credits end the song");
  assert.deepEqual(planStage(items, 2.8), ["gone", "current", "queued"], "a note is never kept as the previous item");
}

{
  const items = [line(0, 2), credits(2)];
  assert.deepEqual(planStage(items, 1), ["current", "queued"], "credits wait while the last line is sung");
  assert.deepEqual(planStage(items, 3), ["gone", "current"], "credits are current after the last line, alone");
}

{
  const items = [line(0, 2), instrumental(2, 12), credits(12)];
  assert.deepEqual(planStage(items, 6.9), ["gone", "current", "queued"], "an outro note holds its first half");
  assert.deepEqual(
    planStage(items, 7),
    ["gone", "gone", "current"],
    "regression: the credits take over halfway through an outro note, not as the song ends"
  );
}

// -- Invariants --------------------------------------------

{
  const items = [line(0, 5), line(1, 2)];
  const roles = planStage(items, 1);
  assert.equal(roles.filter(role => role === "current").length, 1, "exactly one current item once anything entered");
}

{
  assert.deepEqual(planStage([], 3), [], "an empty song has an empty stage");
}

// -- Geometry --------------------------------------------

const metric = (height: number, left = 100, width = 300, originX = 0.5): StageMetrics => ({
  height,
  left,
  width,
  originX,
});
const GEOMETRY = { stageHeight: 500, gap: 10, activeScale: 1 };

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
  assert.deepEqual(
    box,
    { x: 50, y: 410, width: 400, height: 90 },
    "regression: the overlapping line is still being sung, so the box holds it at its active size"
  );
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
  assert.equal(placements[0].y, 460, "a leaving line fades where it was, inside the backdrop behind it");
}

{
  const items = [line(0, 2), blank(2, 4)];
  assert.deepEqual(planStage(items, 3), ["gone", "current"], "a blank line clears the line before it");
  const { box } = layoutStage(["gone", "current"], items, [metric(40), metric(40)], [460, null], GEOMETRY);
  assert.equal(box, null, "regression: a blank line gets no box, so no empty backdrop shows");
  assert.equal(
    overlapsPrevious([blank(0, 3), line(2, 4)], 1),
    false,
    "a blank line is never held as the previous line"
  );
}

console.log("stage scheduler self-check passed");
