"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { GlobalSearch } from "@/components/GlobalSearch";
import { NetworkStatus } from "@/components/NetworkStatus";
import { Toaster } from "@/components/ui/sonner";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";

/** Single search instance: one Cmd+K handler, one modal, one visible
 *  trigger (TopBar). No global floating pill. */
export function AppShell({ children }: { children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <NetworkStatus />
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NavRail />
      <main className="relative flex flex-1 min-w-0 flex-col overflow-y-auto h-svh bg-background">
        <TopBar onSearch={() => setSearchOpen(true)} />
        {children}
      </main>
      <Toaster />
    </>
  );
}
