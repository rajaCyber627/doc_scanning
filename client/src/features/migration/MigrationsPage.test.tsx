import { fireEvent, render, screen } from "@testing-library/react";
import axios from "axios";
import MigrationsPage from "./MigrationsPage";

jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("../../components/AppShell", () => ({ children }: any) => <div>{children}</div>);
jest.mock("../../auth", () => ({ getUser: () => ({ _id: "a1", role: "admin" }) }));
afterEach(() => jest.restoreAllMocks());

test("lists runs and shows each step's figures", async () => {
  const run = {
    _id: "r1",
    name: "HR share",
    status: "reconciled",
    source: { kind: "local", label: "/mnt/hr" },
    createdAt: "2026-11-21T10:00:00Z",
    summary: {
      inventory: { files: 44, bytes: 4096, importable: 38, likelyDuplicates: 2, issues: { unsupported: 2 }, byAge: { "under 1 year": 44 } },
      mapping: { mapped: 39, unmapped: 1, withProblems: 4, byRule: { "Employee folders": 39 } },
      migration: [{ mode: "test", imported: 3, skipped: 1, failed: 0, at: "2026-11-21T10:05:00Z" }],
      reconciliation: { source: 44, imported: 38, skipped: 6, failed: 0, pending: 0, accountedFor: true, skippedBy: { "Duplicate within the source": 2 }, failedBy: {}, verified: { match: 38, mismatch: 0, missing: 0 }, at: "x" },
    },
  };
  jest.spyOn(axios, "get").mockImplementation(async (url: string) => (url === "/api/migrations" ? { data: [run] } : { data: { run, items: { imported: 38, skipped: 6 }, unmapped: ["Scans/misc/scan-001.txt"], failed: [] } }));
  render(<MigrationsPage />);
  fireEvent.click(await screen.findByText("HR share"));
  expect(await screen.findByText("Every file accounted for")).toBeInTheDocument();
  expect(screen.getByText(/44 in source = 38 imported \+ 6 skipped/)).toBeInTheDocument();
  expect(screen.getByText(/Unmapped: Scans\/misc\/scan-001.txt/)).toBeInTheDocument();
  expect(screen.getByText(/Test pass/)).toBeInTheDocument();
});
