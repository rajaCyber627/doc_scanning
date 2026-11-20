import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DropZone, { BrowseButtons, useDropTarget } from "./DropZone";

jest.mock("./uploadApi", () => ({
  getUploadConfig: () =>
    Promise.resolve({
      maxBytes: 100 * 1024 * 1024,
      multipartThresholdBytes: 10 * 1024 * 1024,
      partSizeBytes: 8 * 1024 * 1024,
      transport: "auto",
      acceptedTypes: [
        { ext: "pdf", mime: "application/pdf", kind: "pdf", label: "PDF" },
        { ext: "txt", mime: "text/plain", kind: "text", label: "Text" },
      ],
      accept: ".pdf,.txt",
    }),
  errorMessage: (e: any) => e?.message,
}));

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
const dt = (files: File[]) => ({ files, types: ["Files"], dropEffect: "none" });

function Row() {
  const { active, props } = useDropTarget({ folderId: "f1", label: "Onboarding" });
  return (
    <div data-testid="row" data-active={active} {...props}>
      Onboarding
    </div>
  );
}

async function setup() {
  const onFiles = jest.fn();
  render(
    <DropZone onFiles={onFiles} defaultTarget={{ label: "your documents" }}>
      <BrowseButtons />
      <Row />
    </DropZone>
  );
  // wait for the upload rules to load (browse hint shows the limit)
  await screen.findByText(/up to 100 MB each/);
  return onFiles;
}

test("a page-level drop sends valid files to the default target and rejects others with a reason", async () => {
  const onFiles = await setup();
  fireEvent.drop(window, { dataTransfer: dt([file("a.pdf"), file("virus.exe"), file(".DS_Store")]) });
  await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
  expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(["a.pdf"]);
  expect(onFiles.mock.calls[0][1]).toEqual({ label: "your documents" });
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("1 file can't be uploaded");
  expect(alert).toHaveTextContent(/virus\.exe" is not a supported file type/);
  expect(alert).not.toHaveTextContent(".DS_Store"); // OS clutter silently skipped
});

test("dropping on a set row targets that set (not the page)", async () => {
  const onFiles = await setup();
  const row = screen.getByTestId("row");
  fireEvent.dragEnter(row, { dataTransfer: dt([file("b.txt")]) });
  expect(row).toHaveAttribute("data-active", "true");
  fireEvent.drop(row, { dataTransfer: dt([file("b.txt")]) });
  await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
  expect(onFiles.mock.calls[0][1]).toEqual({ folderId: "f1", label: "Onboarding" });
  expect(row).toHaveAttribute("data-active", "false");
});

test("the overlay appears while dragging files over the window and clears afterwards", async () => {
  await setup();
  fireEvent.dragEnter(window, { dataTransfer: dt([file("c.pdf")]) });
  expect(screen.getByRole("status")).toHaveTextContent("Drop files or a folder to upload to your documents");
  fireEvent.dragLeave(window, { dataTransfer: dt([file("c.pdf")]) });
  // hidden from assistive tech once the drag ends
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("");
});

test("a drop right after page load (before the rules arrive) is still checked", async () => {
  const onFiles = jest.fn();
  render(
    <DropZone onFiles={onFiles}>
      <p>page</p>
    </DropZone>
  );
  fireEvent.drop(window, { dataTransfer: dt([file("ok.txt"), file("bad.exe")]) });
  await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
  expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(["ok.txt"]);
});

test("browse buttons are real, keyboard-focusable buttons", async () => {
  await setup();
  const files = screen.getByRole("button", { name: /Upload files/ });
  const folder = screen.getByRole("button", { name: /Upload folder/ });
  files.focus();
  expect(files).toHaveFocus();
  folder.focus();
  expect(folder).toHaveFocus();
});

test("picking files with the browse button goes through the same checks", async () => {
  const onFiles = await setup();
  const input = screen.getByTestId("dropzone-file-input");
  fireEvent.change(input, { target: { files: [file("d.pdf"), file("big.pdf", 0)] } });
  await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
  expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(["d.pdf"]);
  expect(screen.getByRole("alert")).toHaveTextContent('"big.pdf" is empty');
});
