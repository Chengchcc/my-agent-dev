"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ActivityIcon,
  ArchiveIcon,
  BotIcon,
  FolderKanbanIcon,
  LibraryIcon,
  LogOutIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  Package,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAgentList } from "@/features/agents/hooks";
import {
  conversationKeys,
  useAllConversations,
  useCreateConversation,
  useDeleteConversation,
} from "@/features/conversations/hooks";
import { useCurrentUser } from "@/features/identity/hooks";
import { waitingGatesQuery } from "@/features/workflow/queries";
import type { AgentRow } from "@/lib/api";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";

function NavContent() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Quick-create agent resolution: default → first enabled (never a dead id).
  const { data: agents } = useAgentList() as { data?: AgentRow[] };
  const { data: conversations } = useAllConversations();
  // Loop/Cron conversations belong in Work, not Chat — exclude them from the rail.
  const chatConversations = (conversations ?? []).filter(
    (c) => "origin" in c && c.origin !== "loop" && c.origin !== "cron" && c.origin !== "workflow",
  );
  const deleteConversation = useDeleteConversation();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // U4: badge the Workflows nav when any execution waits for a human.
  const { data: waitingGates } = useQuery(waitingGatesQuery());
  const createConversation = useCreateConversation();
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: chatConversations.length,
    getScrollElement: () => chatScrollRef.current,
    estimateSize: () => 36,
    overscan: 5,
  });

  function closeMobile() {
    setOpenMobile(false);
  }

  function makeConversation() {
    // Quick-create targets the default agent, falling back to the first
    // enabled one — never a hardcoded dead agent id.
    const agent =
      agents?.find((a) => a.id === "default" && a.enabled !== false) ??
      agents?.find((a) => a.enabled !== false) ??
      agents?.[agents.length - 1];
    const agentId = agent?.id ?? "default";
    createConversation.mutate(
      {
        agentId,
      },
      {
        onSuccess: (conv) => {
          queryClient.invalidateQueries({ queryKey: conversationKeys.all });
          closeMobile();
          router.push(`/chat/${conv.conversationId}`);
        },
        onError: (err) => {
          toast.error("Failed to create conversation", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  }

  return (
    <SidebarContent>
      {/* Work */}
      <SidebarGroup>
        <SidebarGroupLabel>Work</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/today"}
                tooltip={t("Today")}
                onClick={() => {
                  closeMobile();
                  router.push("/today");
                }}
              >
                <RefreshCwIcon />
                <span className="truncate">{t("Today")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/workflows")}
                tooltip={t("Workflows")}
                onClick={() => {
                  closeMobile();
                  router.push("/workflows");
                }}
              >
                <NetworkIcon />
                <span className="truncate">{t("Workflows")}</span>
                {(waitingGates ?? 0) > 0 && (
                  <span
                    data-testid="waiting-gates-badge"
                    className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[9px] font-semibold text-black"
                    title={`${waitingGates ?? 0} workflow${(waitingGates ?? 0) > 1 ? "s" : ""} waiting for your decision`}
                  >
                    {waitingGates ?? 0}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/artifacts")}
                tooltip={t("Artifacts")}
                onClick={() => {
                  closeMobile();
                  router.push("/artifacts");
                }}
              >
                <ArchiveIcon />
                <span className="truncate">{t("Artifacts")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Chat */}
      <SidebarGroup>
        <SidebarGroupLabel>
          Chat
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={createConversation.isPending}
            onClick={makeConversation}
            className="ml-auto text-primary hover:text-primary/80"
            aria-label="New conversation"
          >
            <PlusIcon />
          </Button>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          {chatConversations.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2">No conversations yet</p>
          ) : (
            <div ref={chatScrollRef} className="max-h-[min(44vh,600px)] overflow-y-auto">
              <div
                style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const conv = chatConversations[virtualRow.index]!;
                  const title = conversationDisplayName(conv);
                  return (
                    <div
                      key={conv.conversationId}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="h-9"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={pathname === `/chat/${conv.conversationId}`}
                          tooltip={title}
                          onClick={() => {
                            closeMobile();
                            router.push(`/chat/${conv.conversationId}`);
                          }}
                        >
                          <MessageSquareIcon />
                          <span className="truncate">{title}</span>
                        </SidebarMenuButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <SidebarMenuAction showOnHover aria-label="Conversation actions" />
                            }
                          >
                            <MoreHorizontalIcon />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="w-44">
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={deleteConversation.isPending}
                              onClick={() => {
                                void (async () => {
                                  const ok = await confirm({
                                    title: `Delete "${title}"?`,
                                    description: "This cannot be undone.",
                                    confirmText: "Delete",
                                    destructive: true,
                                  });
                                  if (!ok) return;
                                  deleteConversation.mutate(conv.conversationId, {
                                    onSuccess: () => {
                                      queryClient.invalidateQueries({
                                        queryKey: conversationKeys.all,
                                      });
                                      if (pathname === `/chat/${conv.conversationId}`) {
                                        router.push("/today");
                                      }
                                    },
                                    onError: (err) => {
                                      toast.error("Failed to delete conversation", {
                                        description:
                                          err instanceof Error ? err.message : "Unknown error",
                                      });
                                    },
                                  });
                                })();
                              }}
                            >
                              <Trash2Icon />
                              Delete conversation
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Team */}
      <SidebarGroup>
        <SidebarGroupLabel>Team</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  pathname === "/team" ||
                  (pathname.startsWith("/team/") &&
                    !["skills", "mcp", "knowledge", "projects"].some((r) =>
                      pathname.startsWith(`/team/${r}`),
                    ))
                }
                tooltip={t("Agents")}
                onClick={() => {
                  closeMobile();
                  router.push("/team");
                }}
              >
                <BotIcon />
                <span className="truncate">{t("Agents")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-(--mute)">
              Resources
            </div>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/team/skills")}
                tooltip={t("Skill Packs")}
                onClick={() => {
                  closeMobile();
                  router.push("/team/skills");
                }}
              >
                <Package />
                <span className="truncate">{t("Skill Packs")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/team/mcp")}
                tooltip="MCP Servers"
                onClick={() => {
                  closeMobile();
                  router.push("/team/mcp");
                }}
              >
                <PlugIcon />
                <span className="truncate">{t("MCP")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/team/knowledge")}
                tooltip={t("Knowledge")}
                onClick={() => {
                  closeMobile();
                  router.push("/team/knowledge");
                }}
              >
                <LibraryIcon />
                <span className="truncate">{t("Knowledge")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/team/projects")}
                tooltip={t("Projects")}
                onClick={() => {
                  closeMobile();
                  router.push("/team/projects");
                }}
              >
                <FolderKanbanIcon />
                <span className="truncate">{t("Projects")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* System */}
      <SidebarGroup>
        <SidebarGroupLabel>System</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  pathname === "/system" ||
                  (pathname.startsWith("/system") && !pathname.startsWith("/system/settings"))
                }
                tooltip="System"
                onClick={() => {
                  closeMobile();
                  router.push("/system");
                }}
              >
                <ActivityIcon />
                <span className="truncate">System</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/system/settings")}
                tooltip={t("Settings")}
                onClick={() => {
                  closeMobile();
                  router.push("/system/settings");
                }}
              >
                <SettingsIcon />
                <span className="truncate">{t("Settings")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {confirmDialog}
    </SidebarContent>
  );
}

function NavFooter() {
  const router = useRouter();
  const { data: user } = useCurrentUser();

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <SidebarFooter className="shrink-0 border-t border-(--hairline) bg-(--panel) p-1.5">
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton className="min-w-0 w-full" />}>
              <LogOutIcon />
              <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
                {user?.userId ?? "Account"}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-48">
              <DropdownMenuLabel>Signed in as {user?.userId ?? "unknown"}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={signOut}>
                <LogOutIcon />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

export function NavRail() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Observatory
          </span>
          <SidebarTrigger className="hidden md:flex" />
        </div>
      </SidebarHeader>
      <NavContent />
      <NavFooter />
    </Sidebar>
  );
}
