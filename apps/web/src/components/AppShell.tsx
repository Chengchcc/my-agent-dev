"use client";

import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { GlobalSearch } from "@/components/GlobalSearch";
import { NetworkStatus } from "@/components/NetworkStatus";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { NavRail } from "./NavRail";

/** Single search instance: one Cmd+K handler, one modal, one visible
 *  trigger (mobile top bar). No global floating pill. */
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
      <main className="relative flex-1 min-w-0 overflow-y-auto h-svh bg-background">
        <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur md:hidden">
          <SidebarTrigger />
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="ml-auto flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Search conversations"
          >
            <Search className="size-4 " />
          </button>
        </div>
        {children}
      </main>
      <Toaster />
    </>
  );
}
