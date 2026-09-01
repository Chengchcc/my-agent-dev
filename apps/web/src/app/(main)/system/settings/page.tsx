"use client";

import { useState } from "react";
import { ProviderSettingsSection } from "@/components/ProviderSettingsSection";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSystemInfo } from "@/features/settings/hooks";
import type { SystemInfo } from "@/lib/api";

function SystemInfoSection({ info }: { info: SystemInfo | undefined }) {
  const [open, setOpen] = useState(false);
  if (!info) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>System Info</CardTitle>
          <CardDescription>Environment variables and paths (read-only).</CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">Environment</h4>
            <dl className="space-y-1">
              {Object.entries(info.env).map(([k, v]) => (
                <div
                  key={k}
                  className="grid gap-0.5 sm:grid-cols-[240px_1fr] sm:gap-2 font-mono text-xs"
                >
                  <dt className="text-muted-foreground break-all">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">Paths</h4>
            <dl className="space-y-1">
              {Object.entries(info.paths).map(([k, v]) => (
                <div
                  key={k}
                  className="grid gap-0.5 sm:grid-cols-[240px_1fr] sm:gap-2 font-mono text-xs"
                >
                  <dt className="text-muted-foreground break-all">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const systemQuery = useSystemInfo();

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "System", href: "/system" }, { label: "Settings" }]}
        title="Settings"
        description="Provider credentials and deployment information."
      />
      <PageBody size="reading" className="space-y-6">
        <ProviderSettingsSection />
        <SystemInfoSection info={systemQuery.data} />
      </PageBody>
    </Page>
  );
}
