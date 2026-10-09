import Link from "next/link";
import type { ComponentProps } from "react";
import { buttonClasses, type ButtonStyleOptions } from "./Button";

export type LinkButtonProps = ComponentProps<typeof Link> & ButtonStyleOptions;

/** A navigation link that looks like a Button. Use it for navigation, never for actions. */
export function LinkButton({ variant, size, fullWidth, className, ...rest }: LinkButtonProps) {
  return <Link className={buttonClasses({ variant, size, fullWidth, className })} {...rest} />;
}
