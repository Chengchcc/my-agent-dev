"use client";

import type { ReactNode } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile } from "@/components/patterns";
import { InfoBanner, ListToolbar } from "@/components/ui/polish";

/** Shared skeleton for the CAPABILITIES list pages (skills / mcp / knowledge):
 *  Page → header + body → InfoBanner, a 4-tile KPI grid, filter chips, a search
 *  ListToolbar, then the page's list. Each page supplies its own header/banner/
 *  KPIs/filters/search and list; the framing stays identical so the pages read
 *  as one family. */
export function CapabilityListPage({
  breadcrumb,
  title,
  description,
  pill,
  actions,
  banner,
  kpis,
  filters,
  search,
  children,
}: {
  breadcrumb: string;
  title: string;
  description?: string;
  pill?: ReactNode;
  actions?: ReactNode;
  banner: { id: string; title: string; body: string };
  /** The 4-tile KPI grid (grid grid-cols-2 gap-3 xl:grid-cols-4). */
  kpis: ReactNode;
  /** Filter chip group(s). */
  filters?: ReactNode;
  /** Search field props for the shared ListToolbar. */
  search: { value: string; onChange: (v: string) => void; placeholder: string };
  /** The list content. */
  children: ReactNode;
}) {
  return (
    <Page>
      <PageHeader
        breadcrumb={breadcrumb}
        title={title}
        description={description}
        pill={pill}
        actions={actions}
      />
      <PageBody>
        <div className="space-y-6">
          <InfoBanner id={banner.id} title={banner.title} body={banner.body} />
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{kpis}</div>
          {filters}
          <ListToolbar
            searchValue={search.value}
            onSearch={search.onChange}
            placeholder={search.placeholder}
          />
          {children}
        </div>
      </PageBody>
    </Page>
  );
}

export { KpiTile };
