import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Observatory — Agent Workspace",
  description: "Multi-agent collaboration workspace",
};

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delay={500}>
      <SidebarProvider>
        <AppShell>{children}</AppShell>
      </SidebarProvider>
    </TooltipProvider>
  );
}
