"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

/** Promise-based confirmation dialog. Call `const ok = await confirm({...})`
 *  from a handler; it renders a single AlertDialog and resolves true/false.
 *  Replaces the scattered native `confirm()`/`alert()` calls with one
 *  consistent destructive-action confirmation grammar. */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOptions(opts);
    });
  }, []);

  function close(result: boolean) {
    resolver.current?.(result);
    resolver.current = null;
    setOptions(null);
  }

  const dialog = options ? (
    <AlertDialog open={!!options} onOpenChange={(open) => !open && close(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options.title}</AlertDialogTitle>
          {options.description && (
            <AlertDialogDescription>{options.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>
            {options.cancelText ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            className={options.destructive ? "bg-red-600 text-white hover:bg-red-500" : undefined}
            onClick={() => close(true)}
          >
            {options.confirmText ?? "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  return { confirm, dialog };
}
