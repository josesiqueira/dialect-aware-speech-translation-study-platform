import { Fragment } from "react";
import { REFERENCE_BY_KEY } from "../references";

/** The anchor id of a reference in the list at the end of the page. */
export function referenceAnchor(key: string): string {
  return `ref-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

/**
 * An author-year citation, for example "(Toury 1995; Rosa 2012)", each name
 * linked to its entry in the reference list. A key without a reference is a
 * programming error and fails the render, so an unchecked source cannot be
 * cited by accident.
 */
export function Cite({ refs }: { refs: string[] }) {
  for (const key of refs) {
    if (!REFERENCE_BY_KEY.has(key)) throw new Error(`Unknown reference "${key}" on the Scientific Relevance page.`);
  }
  return (
    <span className="text-slate-500">
      (
      {refs.map((key, index) => (
        <Fragment key={key}>
          {index > 0 && "; "}
          <a href={`#${referenceAnchor(key)}`} className="underline decoration-slate-300 underline-offset-2 hover:text-slate-700">
            {key}
          </a>
        </Fragment>
      ))}
      )
    </span>
  );
}
