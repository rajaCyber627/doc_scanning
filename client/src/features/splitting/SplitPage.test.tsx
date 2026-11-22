import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import axios from "axios";
import SplitPage from "./SplitPage";
import * as api from "./splitApi";
import * as metaApi from "../metadata/metadataApi";

jest.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({ children }: any) => <div>{children}</div>,
  Page: ({ pageNumber, rotate }: any) => <div data-testid={`page-${pageNumber}`} data-rotate={rotate} />,
}));
jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("../../components/AppShell", () => ({ children }: any) => <div>{children}</div>);
jest.mock("../../auth", () => ({ getUser: () => ({ _id: "u1", role: "user" }) }));

const page = (n: number, over = {}) => ({ page: n, wordCount: 40, blank: false, snippet: `page ${n}`, separator: null, ...over });
const info: api.PagesInfo = {
  fileId: "f1",
  pageCount: 5,
  source: "original",
  splittable: true,
  reason: null,
  pages: [page(1), page(2), page(3, { wordCount: 0, blank: true }), page(4), page(5)],
  separatorParts: [],
  suggestion: null,
  splitInto: [],
  splitFrom: null,
};

beforeEach(() => {
  (global as any).URL.createObjectURL = jest.fn(() => "blob:x");
  (global as any).URL.revokeObjectURL = jest.fn();
  jest.spyOn(api, "getPages").mockResolvedValue(info);
  jest.spyOn(api, "getPagesPdf").mockResolvedValue(new Blob(["%PDF"]));
  jest.spyOn(metaApi, "getTaxonomy").mockResolvedValue({ categories: [{ key: "benefits", name: "Benefits" }], documentTypes: [{ key: "benefits.benefit-elections", name: "Benefit elections", categoryKey: "benefits" }] } as any);
});
afterEach(() => jest.restoreAllMocks());

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/files/f1/pages"]}>
      <Routes>
        <Route path="/files/:id/pages" element={<SplitPage />} />
        <Route path="/files/:id" element={<div>file page</div>} />
      </Routes>
    </MemoryRouter>
  );

test("AI cuts with reasons, rotate, remove the blank page, preview and confirm", async () => {
  jest.spyOn(api, "suggestSplit").mockResolvedValue({
    cuts: [{ page: 4, reason: "Page 4 starts a new form: 'BENEFIT ELECTION FORM'", confidence: 0.92 }],
    parts: [
      { from: 1, to: 3, documentType: null, reason: "Start", confidence: 1 },
      { from: 4, to: 5, documentType: "benefits.benefit-elections", reason: "Page 4 starts a new form: 'BENEFIT ELECTION FORM'", confidence: 0.92 },
    ],
  });
  const post = jest.spyOn(axios, "post").mockResolvedValue({ data: { splitId: "s", parts: [{}, {}] } });
  renderPage();
  expect(await screen.findByText(/5 pages/)).toBeInTheDocument();
  expect(screen.getByText("Result: 1 document")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Suggest cuts with AI" }));
  expect(await screen.findByText("Result: 2 documents")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove the cut before page 4" })).toHaveAttribute("title", "Page 4 starts a new form: 'BENEFIT ELECTION FORM' (92% sure)");
  expect(screen.getByLabelText("Document type of part 2")).toHaveValue("benefits.benefit-elections");

  fireEvent.click(screen.getByRole("button", { name: "Rotate page 2" }));
  expect(screen.getAllByTestId("page-2")[0]).toHaveAttribute("data-rotate", "90");
  fireEvent.click(screen.getByRole("button", { name: "Remove 1 blank page" }));
  expect(screen.getByText("(2 kept)")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Name of part 1"), { target: { value: "Patel offer" } });

  fireEvent.click(screen.getByRole("button", { name: "Preview split…" }));
  expect(screen.getByText(/2 documents will be created · 1 page left out/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm split" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/api/files/f1/split", {
      userId: "u1",
      parts: [
        { from: 1, to: 3, name: "Patel offer" },
        { from: 4, to: 5, documentType: "benefits.benefit-elections" },
      ],
      removed: [3],
      rotations: { 2: 90 },
      via: "ai",
    })
  );
  expect(await screen.findByText("file page")).toBeInTheDocument();
});

test("manual cut by clicking between pages; separator sheets pre-fill the parts", async () => {
  (api.getPages as jest.Mock).mockResolvedValue({
    ...info,
    pages: [page(1, { separator: { via: "qr", prefill: { employeeId: "1045" } } }), page(2), page(3), page(4, { separator: { via: "text", prefill: {} } }), page(5)],
    separatorParts: [
      { from: 2, to: 3, prefill: { employeeId: "1045" } },
      { from: 5, to: 5, prefill: {} },
    ],
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Cut before page 3" }));
  expect(screen.getByText("Result: 2 documents")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cut at 2 separator sheets" }));
  expect(screen.getByText("Result: 2 documents")).toBeInTheDocument();
  expect(screen.getByLabelText("Employee ID of part 1")).toHaveValue("1045");
});
