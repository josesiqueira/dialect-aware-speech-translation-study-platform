// Keyboard shortcuts of the Review & Transcription page (spec 46).
//
// Every shortcut that works while typing uses a modifier key, so it cannot be
// triggered by ordinary text input. The only shortcut without a modifier is
// Space for play and pause, and it is active only when the focus is not on a
// control. All shortcuts can be switched off on the page (WCAG 2.1.4), and
// none of them uses Tab or Escape, so keyboard navigation is never trapped.

export type ShortcutAction = "save" | "toggle-play" | "rewind" | "next" | "previous";

export const REWIND_SECONDS = 3;

export const SHORTCUT_LEGEND: { keys: string; description: string }[] = [
  { keys: "Ctrl+S or Cmd+S", description: "Save draft" },
  { keys: "Alt+P", description: "Play or pause, also while typing" },
  { keys: "Alt+J", description: `Jump back ${REWIND_SECONDS} seconds` },
  { keys: "Space", description: "Play or pause when the focus is not on a field or button" },
  { keys: "Alt+Down", description: "Next utterance" },
  { keys: "Alt+Up", description: "Previous utterance" },
];

// The part of a KeyboardEvent the resolver needs. `target` is the focused element.
export type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing"
> & { target: EventTarget | null };

const TEXT_ENTRY = "input, textarea, select, [contenteditable='true'], [contenteditable='']";
// Elements where Space already has a meaning of its own.
const SPACE_OWNERS = `${TEXT_ENTRY}, button, a[href], summary, audio, video, [role='button'], [role='checkbox']`;

function closest(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

// Returns the action for a keydown event, or null when the event is not a shortcut.
export function resolveShortcut(event: ShortcutEvent): ShortcutAction | null {
  // Text being composed with an input method belongs to the input method.
  if (event.isComposing) return null;

  const commandKey = event.ctrlKey || event.metaKey;
  if (commandKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
    return event.repeat ? null : "save";
  }

  if (event.altKey && !commandKey && !event.shiftKey) {
    // `code` names the physical key: with Alt held, macOS reports another character in `key`.
    if (event.code === "KeyP") return event.repeat ? null : "toggle-play";
    if (event.code === "KeyJ") return "rewind";
    // In a native select, Alt+Down and Alt+Up open the list.
    if (closest(event.target, "select")) return null;
    if (event.key === "ArrowDown") return event.repeat ? null : "next";
    if (event.key === "ArrowUp") return event.repeat ? null : "previous";
    return null;
  }

  const plainSpace = (event.key === " " || event.code === "Space") && !commandKey && !event.altKey && !event.shiftKey;
  if (plainSpace && !closest(event.target, SPACE_OWNERS)) {
    return event.repeat ? null : "toggle-play";
  }
  return null;
}
