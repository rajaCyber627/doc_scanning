import { buildRequest, keptPages, partsFromCuts } from "./splitPlan";

test("cuts become page ranges", () => {
  expect(partsFromCuts(10, [7, 4, 4, 1, 12])).toEqual([
    { from: 1, to: 3 },
    { from: 4, to: 6 },
    { from: 7, to: 10 },
  ]);
  expect(partsFromCuts(3, [])).toEqual([{ from: 1, to: 3 }]);
});

test("the request drops parts that are fully removed and keeps only real rotations", () => {
  const removed = new Set([4, 5]);
  expect(keptPages({ from: 3, to: 6 }, removed)).toEqual([3, 6]);
  const req = buildRequest(7, [4, 6], removed, { 2: 90, 3: 360, 4: 180 }, { 1: { name: " Offer ", documentType: "personnel.offer-letters" }, 6: { employeeId: "1045" } }, "ai");
  expect(req).toEqual({
    parts: [
      { from: 1, to: 3, name: "Offer", documentType: "personnel.offer-letters" },
      { from: 6, to: 7, employeeId: "1045" },
    ],
    removed: [4, 5],
    rotations: { 2: 90 },
    via: "ai",
  });
});
