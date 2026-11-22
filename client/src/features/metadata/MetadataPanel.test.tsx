import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MetadataPanel from "./MetadataPanel";
import * as api from "./metadataApi";

jest.mock("antd", () => ({ message: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const TAX: api.Taxonomy = {
  categories: [{ key: "personnel", name: "Personnel", hrFunctionalArea: "Personnel", defaultConfidentiality: "Confidential", defaultRetentionCategory: "", order: 1 }],
  documentTypes: [
    { key: "personnel.offer-letters", name: "Offer letters", categoryKey: "personnel", defaultConfidentiality: "Confidential", defaultRetentionCategory: "", active: true, order: 1, fields: [{ key: "startDate", label: "Start date", type: "date", required: true }] },
  ],
  baseFields: [
    { key: "documentType", label: "Document type", type: "doctype", required: true },
    { key: "person", label: "Employee / applicant", type: "person", required: true },
    { key: "confidentialityLevel", label: "Confidentiality", type: "select", options: ["General", "Confidential", "Restricted"], required: true },
  ],
  personFields: [],
  confidentialityLevels: ["General", "Confidential", "Restricted"],
  fiscalYearStartMonth: 7,
};

beforeEach(() => {
  jest.spyOn(api, "getTaxonomy").mockResolvedValue(TAX);
  jest.spyOn(api, "lookupPeople").mockResolvedValue([
    { personId: "emp-1045", type: "employee", name: "John Smith", employeeId: "1045", applicantNumber: null, positionTitle: "Operator", department: "Public Works", division: "Streets", status: "active" },
  ]);
});
afterEach(() => jest.restoreAllMocks());

const renderPanel = (onSaved = jest.fn()) =>
  render(
    <MemoryRouter>
      <MetadataPanel fileId="f1" userId="u1" initial={{}} status="missing" serverErrors={[]} onSaved={onSaved} />
    </MemoryRouter>
  );

test("choosing a type shows its fields; picking a person by keyboard; Ctrl+S saves the form", async () => {
  const save = jest.spyOn(api, "saveMetadata").mockResolvedValue({ metadata: { documentType: "personnel.offer-letters" }, metadataStatus: "incomplete", errors: [{ field: "startDate", message: "Start date is required" }] });
  const onSaved = jest.fn();
  renderPanel(onSaved);
  const typeSelect = await screen.findByLabelText(/Document type/);
  expect(screen.queryByLabelText(/Start date/)).toBeNull();
  fireEvent.change(typeSelect, { target: { value: "personnel.offer-letters" } });
  expect(screen.getByLabelText(/Start date/)).toBeInTheDocument();

  const search = screen.getByLabelText(/Employee \/ applicant/); // labelled for screen readers
  fireEvent.change(search, { target: { value: "smi" } });
  await screen.findByRole("option", { name: /John Smith/ });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(screen.getByText("John Smith · ID 1045")).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][2]).toMatchObject({ documentType: "personnel.offer-letters", personId: "emp-1045" });
  expect(await screen.findByText("Start date is required")).toBeInTheDocument();
  expect(onSaved).toHaveBeenCalled();
});

test("server validation errors are shown next to the right field", async () => {
  render(
    <MemoryRouter>
      <MetadataPanel fileId="f1" userId="u1" initial={{ documentType: "personnel.offer-letters" }} status="incomplete" serverErrors={[{ field: "person", message: "Choose the employee or applicant" }]} onSaved={jest.fn()} />
    </MemoryRouter>
  );
  expect(await screen.findByText("Choose the employee or applicant")).toBeInTheDocument();
  expect(screen.getByText("Missing required details")).toBeInTheDocument();
});
