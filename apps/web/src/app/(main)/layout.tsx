import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Observatory — Agent Workspace",
  description: "Multi-agent collaboration workspace",
};

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  // Real HMAC/exp validation here (not just the middleware cookie-existence
  // check): SSR pages fetch data with the SERVER-side backend token and never
  // pass through the BFF's session verification — a forged cookie used to
  // read every workflow/conversation page (proven bypass, 2026-09-07).
  const jar = await cookies();
  const session = await readSession(jar.toString());
  if (!session) redirect("/login");
  return (
    <TooltipProvider delay={500}>
      <SidebarProvider>
        <AppShell>{children}</AppShell>
      </SidebarProvider>
    </TooltipProvider>
  );
}
