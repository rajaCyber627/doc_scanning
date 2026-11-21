import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import EmailIntakeCard from "./EmailIntakeCard";

jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));
afterEach(() => jest.restoreAllMocks());

test("admin sets allowed senders and owner, sees the intake log", async () => {
  const status = { source: "graph", mailbox: "hr-intake@portsmouthva.gov", pollSec: 60, settings: { enabled: true, allowList: ["portsmouthva.gov"], ownerEmail: "", importBody: "auto", minBodyChars: 80 }, lastRun: null };
  const log = [{ _id: "1", from: "winner@lottery.example", messageId: "<x>", status: "rejected", reason: "Sender is not on the allow-list", fileId: null, attachments: 0, createdAt: "2026-11-21T10:00:00Z" }];
  jest.spyOn(axios, "get").mockImplementation(async (url: string) => ({ data: url.endsWith("/log") ? log : status }));
  const put = jest.spyOn(axios, "put").mockResolvedValue({ data: {} });
  render(<EmailIntakeCard userId="admin1" />);
  expect(await screen.findByText(/Reading the shared mailbox hr-intake@portsmouthva.gov every 60 seconds/)).toBeInTheDocument();
  expect(screen.getByText("Rejected: Sender is not on the allow-list")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Allowed senders"), { target: { value: "portsmouthva.gov\npartner@benefits.example" } });
  fireEvent.change(screen.getByLabelText("Owner of e-mailed documents"), { target: { value: "intake@example.com" } });
  fireEvent.change(screen.getByLabelText("Message body"), { target: { value: "never" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/api/email-intake", { userId: "admin1", settings: { allowList: "portsmouthva.gov\npartner@benefits.example", ownerEmail: "intake@example.com", importBody: "never", enabled: true } })
  );
});
