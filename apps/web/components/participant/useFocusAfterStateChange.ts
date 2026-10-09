"use client";

import { useEffect, useRef, type FocusEvent, type RefObject } from "react";

/**
 * Marks the control that receives keyboard focus when a recording control
 * shows a new state. The first marked control that is not disabled is used.
 */
export const STATE_FOCUS_PROPS = { "data-state-focus": "" } as const;

export interface FocusAfterStateChange<Container extends HTMLElement> {
  ref: RefObject<Container | null>;
  onFocus: () => void;
  onBlur: (event: FocusEvent<Container>) => void;
  onClickCapture: () => void;
}

/**
 * Keeps keyboard focus inside a control whose buttons are replaced when its
 * state changes (Start becomes Stop, Stop becomes the player). Without this,
 * the pressed button is removed and focus falls back to the document body
 * (WCAG 2.4.3).
 *
 * Focus moves only when the participant was using the control: a control in
 * it was activated, or focus was inside it when the state changed (a recording
 * that stops by itself). It never moves on the first render, and never when
 * focus is on something outside the control.
 *
 * Spread the result on the element that contains the controls, and put
 * STATE_FOCUS_PROPS on the control to focus in each state.
 *
 * @param stateKey changes when the control shows a different state
 * @param settled  false for a passing state without a usable control ("waiting
 *                 for permission", "uploading"): focus moves at the next settled state
 */
export function useFocusAfterStateChange<Container extends HTMLElement = HTMLDivElement>(
  stateKey: string,
  settled: boolean,
): FocusAfterStateChange<Container> {
  const containerRef = useRef<Container | null>(null);
  /** Focus is inside the control. Stays true when the focused button is removed. */
  const focusInside = useRef(false);
  /** A control inside was activated (pointer, Enter or Space) since the last move of focus. */
  const acted = useRef(false);
  const previousKey = useRef(stateKey);

  useEffect(() => {
    if (previousKey.current === stateKey) return;
    previousKey.current = stateKey;
    const container = containerRef.current;
    if (!container || !settled || !(focusInside.current || acted.current)) return;
    acted.current = false;

    // Focus is somewhere else on the page: the participant moved on, leave it there.
    const active = document.activeElement;
    if (active && active !== document.body && !container.contains(active)) {
      focusInside.current = false;
      return;
    }
    const target = [...container.querySelectorAll<HTMLElement>("[data-state-focus]")].find(
      (element) => !(element as HTMLButtonElement).disabled,
    );
    target?.focus();
  }, [stateKey, settled]);

  return {
    ref: containerRef,
    onFocus: () => {
      focusInside.current = true;
    },
    onBlur: (event) => {
      const next = event.relatedTarget;
      focusInside.current = next instanceof Node && event.currentTarget.contains(next);
    },
    onClickCapture: () => {
      acted.current = true;
    },
  };
}
