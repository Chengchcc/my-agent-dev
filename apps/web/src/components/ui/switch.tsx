"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

// ── Switch root — same class set as before, split by concern ────────────────

const rootBase =
  "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none";
const rootRing =
  "after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const rootInvalid =
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";
const rootSize =
  "data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px]";
const rootDarkInvalid =
  "dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";
const rootState =
  "data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50";

// ── Switch thumb ─────────────────────────────────────────────────────────────

const thumbBase =
  "pointer-events-none block rounded-full bg-background ring-0 transition-transform";
const thumbSize = "group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3";
const thumbChecked =
  "group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)]";
const thumbDarkChecked = "dark:data-checked:bg-primary-foreground";
const thumbUnchecked =
  "group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0";
const thumbDarkUnchecked = "dark:data-unchecked:bg-foreground";

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        rootBase,
        rootRing,
        rootInvalid,
        rootSize,
        rootDarkInvalid,
        rootState,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          thumbBase,
          thumbSize,
          thumbChecked,
          thumbDarkChecked,
          thumbUnchecked,
          thumbDarkUnchecked,
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
