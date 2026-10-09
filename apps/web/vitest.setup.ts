import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

// Register the DOM matchers on the same vitest instance the tests import.
// (The "@testing-library/jest-dom/vitest" entry point resolves its own copy
// of vitest in this workspace; the types are declared in vitest-dom.d.ts.)
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

/*
 * jsdom does not implement the modal methods of <dialog>. This stand-in only
 * toggles the `open` attribute, which is enough to test the content and the
 * gating logic of ConfirmDialog. The focus trap itself is browser behavior.
 */
if (typeof HTMLDialogElement !== "undefined") {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
}
