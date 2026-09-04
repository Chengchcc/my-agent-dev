import type { CSSProperties, ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type TextProps = {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
};

/** Minimal shadcn-style text primitive: `Text as="span"` over raw markup. */
export function Text({ as: Tag = "p", className, children, onClick, style }: TextProps) {
  return (
    <Tag className={cn(className)} onClick={onClick} style={style}>
      {children}
    </Tag>
  );
}
