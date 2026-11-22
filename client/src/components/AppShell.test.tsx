import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import AppShell from "./AppShell";

beforeEach(() => localStorage.setItem("docp_user", JSON.stringify({ _id: "u1", firstName: "Pat", email: "pat@city.gov", permissions: [] })));
afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

test("the ☰ button opens the menu with every page (small screens)", async () => {
  jest.spyOn(axios, "get").mockResolvedValue({ data: { userInfo: { _id: "u1", permissions: [] } } });
  render(
    <MemoryRouter>
      <AppShell>content</AppShell>
    </MemoryRouter>
  );
  const menu = screen.getByRole("complementary", { name: "Main menu" });
  expect(menu).not.toHaveClass("open");
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  expect(menu).toHaveClass("open");
  for (const label of ["Documents", "Scan with camera", "Batches", "Review queue", "Settings"]) expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
  await waitFor(() => expect(axios.get).toHaveBeenCalled());
});

test("rights granted after sign-in show up without signing in again", async () => {
  jest.spyOn(axios, "get").mockResolvedValue({ data: { userInfo: { _id: "u1", permissions: ["admin", "restricted"] } } });
  render(
    <MemoryRouter>
      <AppShell>content</AppShell>
    </MemoryRouter>
  );
  expect(screen.queryByRole("link", { name: /Document types/ })).not.toBeInTheDocument();
  expect(await screen.findByRole("link", { name: /Document types/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Migrations/ })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("docp_user")!).permissions).toEqual(["admin", "restricted"]);
});
