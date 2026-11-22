import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import axios from "axios";
import ScanBatchView from "./ScanBatchView";
import BatchesPage from "./BatchesPage";

jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("../../components/AppShell", () => ({ children }: any) => <div>{children}</div>);
jest.mock("../../auth", () => ({ getUser: () => ({ _id: "u1", role: "user" }) }));

const doc = (i: number, tags: string[], status = "needs_review") => ({
  fileId: `f${i}`,
  fileName: `box - part ${i}.pdf`,
  status,
  stage: "done",
  pages: 3,
  fromPages: [i * 3 - 2, i * 3 - 1, i * 3],
  documentType: "personnel.offer-letters",
  documentTypeName: "Offer letters",
  person: "Priya Patel",
  confirmed: false,
  tags: [status, ...tags],
  reasons: tags.includes("rescan") ? ["Failed the quality check: blurry — rescan the paper original"] : [],
  error: "",
});
const summary = (qc: any = null) => ({
  batch: { _id: "b1", name: "HR box 12", boxId: "BOX-12", expectedPages: 30, splitMode: "suggest", status: "processing", closedAt: null, completedAt: null, createdAt: "2026-11-21T10:00:00Z" },
  pages: { expected: 30, received: 30, inDocuments: 25, removed: 5, unknown: 0, missing: 0 },
  counts: { received: 1, documents: 3, processing: 0, ready: 1, needs_review: 2, failed: 0, restricted: 1, duplicate: 0, split_suggested: 0, rescan: 1 },
  pending: false,
  documents: [doc(1, [], "ready"), doc(2, ["restricted"]), doc(3, ["rescan"])],
  byType: [{ label: "Offer letters", documents: 3 }],
  byPerson: [{ label: "Priya Patel", documents: 3 }],
  qc,
});

afterEach(() => jest.restoreAllMocks());

test("reconciliation figures, drill-down by state, QC sample and results", async () => {
  let qc: any = null;
  jest.spyOn(axios, "get").mockImplementation(async (url: string) => (url === "/api/settings/qc" ? { data: { percent: 10 } } : { data: summary(qc) }));
  const post = jest.spyOn(axios, "post").mockImplementation(async (url: string, body: any) => {
    if (url.endsWith("/qc/sample")) {
      qc = { percent: body.percent, eligible: 3, sampledAt: "x", items: [{ fileId: "f1", fileName: "box - part 1.pdf", result: null, note: "", by: null, at: null }], passed: 0, failed: 0, pending: 1 };
      return { data: qc };
    }
    qc = { ...qc, items: [{ ...qc.items[0], result: body.result, note: body.note }], failed: 1, pending: 0 };
    return { data: qc };
  });
  render(
    <MemoryRouter>
      <ScanBatchView batchId="b1" userId="u1" />
    </MemoryRouter>
  );
  expect(await screen.findByText("pages received of 30 expected")).toBeInTheDocument();
  expect(screen.getByText("missing")).toBeInTheDocument();
  expect(screen.getByText("3 documents")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /Restricted/ }));
  expect(screen.getByText("1 document · restricted")).toBeInTheDocument();
  expect(screen.getByText("box - part 2.pdf")).toBeInTheDocument();
  expect(screen.queryByText("box - part 1.pdf")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Pick sample" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/batches/b1/qc/sample", { userId: "u1", percent: 10, replace: false }));
  const note = await screen.findByLabelText("What is wrong with box - part 1.pdf");
  const fail = screen.getByRole("button", { name: "✕ Fail" });
  expect(fail).toBeDisabled(); // a fail needs a reason
  fireEvent.change(note, { target: { value: "page 2 cut off" } });
  fireEvent.click(fail);
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/batches/b1/qc/f1", { userId: "u1", result: "fail", note: "page 2 cut off" }));
});

test("start a scan batch from the batches page", async () => {
  jest.spyOn(axios, "get").mockResolvedValue({ data: [] });
  const post = jest.spyOn(axios, "post").mockResolvedValue({ data: { _id: "b9" } });
  render(
    <MemoryRouter initialEntries={["/batches"]}>
      <Routes>
        <Route path="/batches" element={<BatchesPage />} />
        <Route path="/batches/:id" element={<div>batch page</div>} />
      </Routes>
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole("button", { name: "＋ Start scan batch" }));
  fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "HR box 12" } });
  fireEvent.change(screen.getByLabelText("Box or folder ID"), { target: { value: "BOX-12" } });
  fireEvent.change(screen.getByLabelText("Expected pages"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/batches/scan", { userId: "u1", name: "HR box 12", boxId: "BOX-12", expectedPages: 30, splitMode: "suggest" }));
  expect(await screen.findByText("batch page")).toBeInTheDocument();
});
