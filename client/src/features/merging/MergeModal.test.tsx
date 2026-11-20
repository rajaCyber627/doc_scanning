import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import axios from "axios";
import MergeModal from "./MergeModal";
import * as splitApi from "../splitting/splitApi";
import { move } from "./mergeApi";

jest.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {}, getDocument: (url: string) => ({ promise: Promise.resolve({ numPages: url === "blob:a" ? 2 : 1 }) }) },
  Page: ({ pageNumber, rotate }: any) => <div data-testid="thumb" data-page={pageNumber} data-rotate={rotate} />,
}));
jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const preview = (over = {}) => ({
  sources: [
    { fileId: "a", fileName: "a.pdf", pageCount: 2, confidentiality: "restricted", documentType: null, employeeName: null },
    { fileId: "b", fileName: "b.png", pageCount: 1, confidentiality: "general", documentType: null, employeeName: null },
  ],
  conflicts: [{ field: "person", values: [{ value: "id:emp-1045", label: "John Smith", fileIds: ["a"] }, { value: "id:emp-2087", label: "Priya Patel", fileIds: ["b"] }] }],
  agreed: { person: null, documentType: null },
  confidentiality: "restricted",
  mixedRestricted: true,
  ...over,
});

beforeEach(() => {
  let n = 0;
  (global as any).URL.createObjectURL = jest.fn(() => (n++ === 0 ? "blob:a" : "blob:b"));
  (global as any).URL.revokeObjectURL = jest.fn();
  jest.spyOn(splitApi, "getPagesPdf").mockResolvedValue(new Blob(["%PDF"]));
});
afterEach(() => jest.restoreAllMocks());

test("move() reorders", () => {
  expect(move([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  expect(move([1, 2, 3], 0, 5)).toEqual([1, 2, 3]);
});

test("reorder, rotate, leave out; conflicts and restricted must be resolved before merging", async () => {
  const post = jest.spyOn(axios, "post").mockImplementation(async (url: string) =>
    url === "/api/merge/preview" ? { data: preview() } : { data: { fileId: "m1", fileName: "x.pdf", pageCount: 2, confidentiality: "restricted" } }
  );
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<MergeModal userId="u1" fileIds={["a", "b"]} onClose={jest.fn()} />} />
        <Route path="/files/:id" element={<div>merged file</div>} />
      </Routes>
    </MemoryRouter>
  );
  const list = await screen.findByRole("list", { name: "Pages of the merged document" });
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
  const merge = screen.getByRole("button", { name: "Merge" });
  expect(merge).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Move page 3 earlier" })); // b p1 before a p2
  fireEvent.click(screen.getByRole("button", { name: "Rotate page 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Leave out page 3" })); // a p2
  expect(screen.getByRole("button", { name: "Put back a.pdf page 2" })).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText(/Priya Patel/));
  expect(merge).toBeDisabled(); // restricted not acknowledged yet
  fireEvent.click(screen.getByLabelText(/will be Restricted/));
  expect(merge).toBeEnabled();
  fireEvent.click(merge);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/api/merge", {
      userId: "u1",
      pages: [
        { fileId: "a", page: 1, rotate: 90 },
        { fileId: "b", page: 1, rotate: 0 },
      ],
      name: undefined,
      supersede: false,
      resolution: { person: "id:emp-2087" },
      acknowledgeRestricted: true,
    })
  );
  expect(await screen.findByText("merged file")).toBeInTheDocument();
});
