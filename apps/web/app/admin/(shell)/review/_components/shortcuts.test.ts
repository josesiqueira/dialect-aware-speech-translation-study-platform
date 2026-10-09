import { describe, expect, it } from "vitest";
import { resolveShortcut, type ShortcutEvent } from "./shortcuts";

function keyEvent(overrides: Partial<ShortcutEvent> & { key: string }): ShortcutEvent {
  return {
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    target: document.body,
    ...overrides,
  };
}

function element(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild!;
}

describe("resolveShortcut", () => {
  it("saves with Ctrl+S and Cmd+S, also from a text area", () => {
    const textarea = element("<textarea></textarea>");
    expect(resolveShortcut(keyEvent({ key: "s", ctrlKey: true, target: textarea }))).toBe("save");
    expect(resolveShortcut(keyEvent({ key: "S", metaKey: true }))).toBe("save");
    expect(resolveShortcut(keyEvent({ key: "s" }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: "s", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: "s", ctrlKey: true, repeat: true }))).toBeNull();
  });

  it("plays and pauses with Alt+P while typing, by physical key", () => {
    const textarea = element("<textarea></textarea>");
    // macOS reports the character "π" for Option+P.
    expect(resolveShortcut(keyEvent({ key: "π", code: "KeyP", altKey: true, target: textarea }))).toBe("toggle-play");
    expect(resolveShortcut(keyEvent({ key: "p", code: "KeyP", altKey: true }))).toBe("toggle-play");
    expect(resolveShortcut(keyEvent({ key: "p", code: "KeyP" }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: "p", code: "KeyP", altKey: true, ctrlKey: true }))).toBeNull();
  });

  it("jumps back with Alt+J and allows key repeat for it", () => {
    expect(resolveShortcut(keyEvent({ key: "j", code: "KeyJ", altKey: true }))).toBe("rewind");
    expect(resolveShortcut(keyEvent({ key: "j", code: "KeyJ", altKey: true, repeat: true }))).toBe("rewind");
  });

  it("uses plain Space for play and pause only when the focus is not on a control", () => {
    expect(resolveShortcut(keyEvent({ key: " ", code: "Space" }))).toBe("toggle-play");
    expect(resolveShortcut(keyEvent({ key: " ", code: "Space", target: element("<p>text</p>") }))).toBe("toggle-play");
    for (const html of [
      "<textarea></textarea>",
      "<input type='text' />",
      "<input type='checkbox' />",
      "<select><option>a</option></select>",
      "<button type='button'>Save</button>",
      "<a href='/admin'>link</a>",
      "<audio controls></audio>",
      "<details><summary>History</summary></details>",
      "<div contenteditable='true'></div>",
    ]) {
      const root = element(html);
      const target = root.tagName === "DETAILS" ? root.querySelector("summary") : root;
      expect(resolveShortcut(keyEvent({ key: " ", code: "Space", target }))).toBeNull();
    }
    // A span inside a button is still the button.
    const inner = element("<button type='button'><span>Save</span></button>").querySelector("span");
    expect(resolveShortcut(keyEvent({ key: " ", code: "Space", target: inner }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: " ", code: "Space", shiftKey: true }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: " ", code: "Space", repeat: true }))).toBeNull();
  });

  it("moves to the next and previous utterance with Alt+Down and Alt+Up, except in a select", () => {
    const textarea = element("<textarea></textarea>");
    expect(resolveShortcut(keyEvent({ key: "ArrowDown", altKey: true, target: textarea }))).toBe("next");
    expect(resolveShortcut(keyEvent({ key: "ArrowUp", altKey: true }))).toBe("previous");
    const select = element("<select><option>a</option></select>");
    expect(resolveShortcut(keyEvent({ key: "ArrowDown", altKey: true, target: select }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: "ArrowDown" }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: "ArrowDown", altKey: true, repeat: true }))).toBeNull();
  });

  it("never claims Tab, Escape, Enter or plain letters, and ignores input method composition", () => {
    const textarea = element("<textarea></textarea>");
    for (const key of ["Tab", "Escape", "Enter", "a", "p", "j", "ArrowDown"]) {
      expect(resolveShortcut(keyEvent({ key, target: textarea }))).toBeNull();
      expect(resolveShortcut(keyEvent({ key }))).toBeNull();
    }
    expect(resolveShortcut(keyEvent({ key: "Tab", shiftKey: true }))).toBeNull();
    expect(resolveShortcut(keyEvent({ key: "s", ctrlKey: true, isComposing: true }))).toBeNull();
  });
});
