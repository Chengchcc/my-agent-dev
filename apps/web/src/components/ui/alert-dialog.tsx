"use client";

import {
  Action,
  Cancel,
  Content,
  Description,
  Overlay,
  Portal,
  Root,
  Title,
  Trigger,
} from "@radix-ui/react-alert-dialog";
import type * as React from "react";
import { cn } from "@/lib/utils";

export function AlertDialog(props: React.ComponentProps<typeof Root>) {
  return <Root data-slot="alert-dialog" {...props} />;
}

export function AlertDialogTrigger(props: React.ComponentProps<typeof Trigger>) {
  return <Trigger data-slot="alert-dialog-trigger" {...props} />;
}

export function AlertDialogPortal(props: React.ComponentProps<typeof Portal>) {
  return <Portal data-slot="alert-dialog-portal" {...props} />;
}

export function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof Overlay>) {
  return <Overlay className={cn("fixed inset-0 z-50 bg-black/50", className)} {...props} />;
}

export function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 max-w-lg -translate-1/2  rounded-xl border border-(--hairline) bg-(--panel) p-6 shadow-2xl",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

export function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mb-2 flex flex-col gap-1", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}

export function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof Title>) {
  return <Title className={cn("text-sm font-semibold text-(--ink)", className)} {...props} />;
}

export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Description>) {
  return <Description className={cn("text-xs text-(--mute)", className)} {...props} />;
}

export function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof Action>) {
  return (
    <Action
      className={cn(
        "inline-flex h-7 items-center rounded-md bg-(--err) px-3 text-xs font-medium text-(--ink) hover:bg-(--err)/80",
        className,
      )}
      {...props}
    />
  );
}

export function AlertDialogCancel({ className, ...props }: React.ComponentProps<typeof Cancel>) {
  return (
    <Cancel
      className={cn(
        "inline-flex h-7 items-center rounded-md border border-(--hairline) px-3 text-xs text-(--mute) hover:bg-(--panel2)",
        className,
      )}
      {...props}
    />
  );
}
