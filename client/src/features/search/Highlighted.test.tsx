import { render, screen } from "@testing-library/react";
import Highlighted from "./Highlighted";

test("marks the given ranges", () => {
  const { container } = render(<Highlighted text="John Smith was promoted" ranges={[[5, 10], [15, 23]]} />);
  expect(Array.from(container.querySelectorAll("mark")).map((m) => m.textContent)).toEqual(["Smith", "promoted"]); // eslint-disable-line testing-library/no-node-access, testing-library/no-container
});

test("document text that looks like HTML is shown as text, never run", () => {
  render(<Highlighted text={'<img src=x onerror="alert(1)"> Smith'} ranges={[[30, 35]]} />);
  expect(screen.getByText(/<img src=x onerror/)).toBeInTheDocument();
  expect(screen.queryByRole("img")).toBeNull();
});

test("bad or overlapping ranges are ignored safely", () => {
  render(<Highlighted text="abc" ranges={[[0, 2], [1, 3], [5, 9]]} />);
  expect(screen.getByText("ab")).toBeInTheDocument();
});
