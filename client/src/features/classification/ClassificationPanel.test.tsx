import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import ClassificationPanel from "./ClassificationPanel";
import * as metaApi from "../metadata/metadataApi";

jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const file: any = {
  _id: "f1",
  fileName: "offer.docx",
  status: "needs_review",
  createdAt: "2026-11-21",
  classification: {
    status: "suggested",
    queue: "general",
    confidence: { documentType: 0.94, person: 0.55, confidentiality: 0.9 },
    suggestion: {
      documentType: "personnel.offer-letters",
      documentTypeName: "Offer letters",
      confidentialityLevel: "Confidential",
      person: { name: "Priya Patel", quote: "Dear Priya Patel", page: 1, match: { kind: "id", name: "Priya Patel", personId: "emp-2087" } },
      fields: [{ key: "startDate", value: "2026-03-03", quote: "starting March 3, 2026", page: 1, confidence: 0.93 }],
    },
  },
};

beforeEach(() => {
  jest.spyOn(metaApi, "getTaxonomy").mockResolvedValue({ categories: [], documentTypes: [{ key: "personnel.offer-letters", name: "Offer letters", categoryKey: "personnel" }] } as any);
});
afterEach(() => jest.restoreAllMocks());

test("shows suggestions with confidence, quotes jump to the page, accept all posts the decision", async () => {
  const post = jest.spyOn(axios, "post").mockResolvedValue({ data: { status: "ready", errors: [] } });
  const onShowQuote = jest.fn();
  const onChanged = jest.fn();
  render(
    <MemoryRouter>
      <ClassificationPanel file={file} userId="u1" canSeeRestricted={false} onChanged={onChanged} onShowQuote={onShowQuote} />
    </MemoryRouter>
  );
  expect(await screen.findByText("Offer letters")).toBeInTheDocument();
  expect(screen.getByText("94%")).toHaveClass("ready");
  expect(screen.getByText("55%")).toHaveClass("failed"); // low confidence stands out
  expect(screen.getByText(/ID matched/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /starting March 3, 2026/ }));
  expect(onShowQuote).toHaveBeenCalledWith("starting March 3, 2026");

  fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/files/f1/classification/accept", { userId: "u1", metadata: {} }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

test("nothing is shown once the document no longer needs review", () => {
  const { container } = render(
    <MemoryRouter>
      <ClassificationPanel file={{ ...file, status: "ready" }} userId="u1" canSeeRestricted={false} onChanged={jest.fn()} onShowQuote={jest.fn()} />
    </MemoryRouter>
  );
  expect(container).toBeEmptyDOMElement();
});
