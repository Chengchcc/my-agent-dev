"use client";

import type { Control } from "react-hook-form";
import QRCode from "react-qr-code";
import type { AgentFormValues } from "@/components/agent-form-types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { AgentRow, LarkSetupSession } from "@/lib/api";
import { api } from "@/lib/api";
import { fieldClass, overlineClass } from "@/lib/form-styles";

interface AgentFormLarkSectionProps {
  control: Control<AgentFormValues>;
  isEdit: boolean;
  editAgent?: AgentRow;
  enableLark: boolean;
  setupSession: LarkSetupSession | null;
  setupLoading: boolean;
  setSetupSession: (session: LarkSetupSession | null) => void;
  setSetupLoading: (loading: boolean) => void;
  getBotDisplayName: () => string;
}

const hintClass = "text-[10px] text-[var(--mute)] mt-1";

export function AgentFormLarkSection({
  control,
  isEdit,
  editAgent,
  enableLark,
  setupSession,
  setupLoading,
  setSetupSession,
  setSetupLoading,
  getBotDisplayName,
}: AgentFormLarkSectionProps) {
  return (
    <div className="border-t border-(--hairline) pt-5">
      <FormField
        control={control}
        name="enableLark"
        render={({ field }) => (
          <FormItem>
            <label className="flex items-center gap-2 cursor-pointer mb-4">
              <Checkbox
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked)}
              />
              <span className={`${overlineClass} mb-0`}>Enable Lark Bot</span>
              {editAgent?.lark?.status && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                    editAgent.lark.status === "running"
                      ? "text-primary border-primary/30 bg-primary/10"
                      : editAgent.lark.status === "error"
                        ? "text-destructive border-destructive/30 bg-destructive/10"
                        : editAgent.lark.status === "degraded"
                          ? "text-(--chart-4) border-(--chart-4)/30 bg-(--chart-4)/10"
                          : "text-muted-foreground border-border bg-muted/20"
                  }`}
                >
                  {editAgent.lark.status}
                </span>
              )}
            </label>
            <FormMessage />
          </FormItem>
        )}
      />

      {enableLark && (
        <div className="space-y-4 pl-6 border-l-2 border-(--hairline)">
          <FormField
            control={control}
            name="botDisplayName"
            render={({ field }) => (
              <FormItem>
                <FormLabel className={`${overlineClass} mb-1.5 block`}>Bot Display Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder="Must match Lark app settings"
                    className={fieldClass}
                  />
                </FormControl>
                <FormDescription className={hintClass}>
                  Required for group @mention detection
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Setup flow - only available after agent is created */}
          {!isEdit ? (
            <p className="text-xs text-(--mute)">
              Save the agent first, then return to this form to set up the Lark bot.
            </p>
          ) : editAgent?.lark?.status === "not_configured" || !editAgent?.lark?.profileRef ? (
            <div>
              {setupSession?.status === "pending" ? (
                <div className="space-y-2">
                  <p className="text-xs text-(--body)">
                    Setup in progress - open this link to complete:
                  </p>
                  {setupSession.url ? (
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 rounded-md border border-(--hairline) bg-white p-1">
                        <QRCode value={setupSession.url} size={96} />
                      </div>
                      <a
                        href={setupSession.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-(--chart-2) underline break-all"
                      >
                        {setupSession.url}
                      </a>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600">Waiting for setup URL…</p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      onClick={() => {
                        if (editAgent?.id && setupSession.setupId) {
                          api.larkSetupCancel(editAgent.id, setupSession.setupId).catch(() => {});
                          setSetupSession(null);
                        }
                      }}
                      className="text-xs text-destructive hover:underline"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  disabled={setupLoading}
                  onClick={async () => {
                    if (!editAgent?.id) return;
                    setSetupLoading(true);
                    try {
                      const session = await api.larkSetup(editAgent.id, {
                        botDisplayName: getBotDisplayName() || undefined,
                      });
                      setSetupSession(session);
                    } catch {
                      // error displayed via error state
                    } finally {
                      setSetupLoading(false);
                    }
                  }}
                  size="sm"
                >
                  {setupLoading ? "Starting…" : "Set up Lark"}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
