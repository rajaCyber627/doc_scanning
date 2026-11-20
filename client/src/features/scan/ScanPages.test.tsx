import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import CameraScanPage from "./CameraScanPage";
import ScannerFoldersCard from "./ScannerFoldersCard";

jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("../../components/AppShell", () => ({ children }: any) => <div>{children}</div>);
jest.mock("../../auth", () => ({ getUser: () => ({ _id: "u1", role: "user" }) }));

afterEach(() => jest.restoreAllMocks());

test("without camera access the page falls back to the device's photo picker", async () => {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: jest.fn().mockRejectedValue(new Error("NotAllowedError")) }, configurable: true });
  render(
    <MemoryRouter>
      <CameraScanPage />
    </MemoryRouter>
  );
  expect(await screen.findByText("Camera access was not allowed.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Take / choose photos" })).toBeInTheDocument();
  const input = screen.getByLabelText("Take or choose photos") as HTMLInputElement;
  expect(input).toHaveAttribute("capture", "environment");
  expect(input).toHaveAttribute("accept", "image/*");
  // scanner guidance is always shown
  expect(screen.getByText("300 dpi")).toBeInTheDocument();
});

test("admin adds a scanner folder, saves, and checks it now", async () => {
  const status = { profiles: [], root: "/mnt/scans", intervalSec: 30, enabled: true, lastRun: null };
  jest.spyOn(axios, "get").mockImplementation(async (url: string) => ({ data: url.endsWith("/imports") ? [] : status }));
  const put = jest.spyOn(axios, "put").mockResolvedValue({ data: [] });
  render(<ScannerFoldersCard userId="admin1" />);
  fireEvent.click(await screen.findByRole("button", { name: "＋ Add folder" }));
  fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "HR copier" } });
  fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "hr" } });
  fireEvent.change(screen.getByLabelText("Owner email"), { target: { value: "clerk@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/api/hotfolders", {
      userId: "admin1",
      profiles: [{ name: "HR copier", kind: "local", path: "hr", ownerEmail: "clerk@example.com", batchMode: "subfolder", enabled: true }],
    })
  );
  expect(screen.getByText(/inside \/mnt\/scans/)).toBeInTheDocument();
});
