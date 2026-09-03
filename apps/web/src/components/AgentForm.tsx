"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { AgentFormLarkSection } from "@/components/AgentFormLarkSection";
import { AgentFormSkillPacks } from "@/components/AgentFormSkillPacks";
import type { AgentFormValues } from "@/components/agent-form-types";
import { agentFormSchema } from "@/components/agent-form-types";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentKeys, useCreateAgent, useUpdateAgent } from "@/features/agents/hooks";
import { useModelList } from "@/features/models/hooks";
import {
  useAgentSkillPacks,
  useSetAgentPacks,
  useSkillPackList,
} from "@/features/skill-packs/hooks";
import { type AgentRow, api, type LarkSetupSession } from "@/lib/api";
import { fieldClass, overlineClass } from "@/lib/form-styles";
import { ProviderSetupInline } from "./ProviderSetupInline";

interface AgentFormProps {
  editAgent?: AgentRow;
  onSuccess?: () => void;
  triggerLabel?: string;
}

export function AgentForm({ editAgent, onSuccess, triggerLabel }: AgentFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isEdit = !!editAgent;
  const [setupSession, setSetupSession] = useState<LarkSetupSession | null>(null);
  const [open, setOpen] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [serverError, setServerError] = useState("");
  const [selectedPackIds, setSelectedPackIds] = useState<string[]>([]);
  const { data: modelData } = useModelList();
  const providers = useMemo(() => modelData?.providers ?? [], [modelData]);
  // Backend kinds present in the aggregated catalog, canonical order.
  const backendKinds = useMemo(() => {
    const order = ["oma", "claude_code", "pi", "omp"];
    const seen = new Set<string>();
    for (const p of providers) for (const m of p.models) if (m.backendKind) seen.add(m.backendKind);
    return order.filter((k) => seen.has(k));
  }, [providers]);
  const [selBackendKind, setSelBackendKind] = useState<string>(editAgent?.backendKind ?? "oma");
  const [selProvider, setSelProvider] = useState<string>(
    (editAgent?.modelName ?? "").includes("/") ? (editAgent?.modelName ?? "").split("/")[0]! : "",
  );
  const modelGroups = useMemo(() => {
    return providers.flatMap((p) =>
      p.models.map((m) => ({
        id: `${p.id}/${m.id}`,
        name: m.name ?? m.id,
        provider: p.id,
        providerName: p.name,
        backendKind: m.backendKind ?? "oma",
        available: m.available !== false,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        inputModalities: m.input,
        cost: m.cost,
      })),
    );
  }, [providers]);
  // Providers that actually expose models of the selected backend kind.
  const kindProviders = useMemo(() => {
    const ids = new Set(
      modelGroups.filter((m) => m.backendKind === selBackendKind).map((m) => m.provider),
    );
    return providers.filter((p) => ids.has(p.id));
  }, [providers, modelGroups, selBackendKind]);
  const filteredModels = useMemo(() => {
    return modelGroups.filter(
      (m) => m.backendKind === selBackendKind && (!selProvider || m.provider === selProvider),
    );
  }, [modelGroups, selBackendKind, selProvider]);

  // Per-kind capability surface (ADR 0003 decision 7): claude has no
  // provider concept (its model set is fixed); pi has no reasoning-effort
  // flag; pi/omp ignore the permission mode. Fields hide, values persist.
  const hideProvider = selBackendKind === "claude_code";
  const hideEffort = selBackendKind === "pi";
  const hidePermission = selBackendKind === "pi" || selBackendKind === "omp";
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: editAgent?.name ?? "",
      backendKind: editAgent?.backendKind ?? "oma",
      // Empty until the catalog loads (see effect below): never hard-code a
      // provider model that may not exist in the runtime catalog.
      model: editAgent?.modelName ?? "",
      reasoningEffort: editAgent?.reasoningEffort ?? "",
      permissionMode: editAgent?.permissionMode ?? "ask",
      maxSteps: editAgent?.maxSteps?.toString() ?? "",
      workspacePath: editAgent?.workspacePath ?? "",
      enableLark: editAgent?.lark?.enabled ?? false,
      botDisplayName: editAgent?.lark?.botDisplayName ?? "",
    },
  });

  const enableLark = useWatch({ control: form.control, name: "enableLark" });
  const modelValue = useWatch({ control: form.control, name: "model" });
  const selectedModelMeta = useMemo(
    () => modelGroups.find((m) => m.id === modelValue),
    [modelGroups, modelValue],
  );

  // Reset form when editAgent changes
  useEffect(() => {
    if (editAgent) {
      form.reset({
        name: editAgent.name,
        backendKind: editAgent.backendKind ?? "oma",
        model:
          editAgent.modelProvider && editAgent.modelName
            ? `${editAgent.modelProvider}/${editAgent.modelName}`
            : editAgent.modelName,
        reasoningEffort: editAgent.reasoningEffort ?? "",
        permissionMode: editAgent.permissionMode,
        maxSteps: editAgent.maxSteps?.toString() ?? "",
        workspacePath: editAgent.workspacePath ?? "",
        enableLark: editAgent.lark?.enabled ?? false,
        botDisplayName: editAgent.lark?.botDisplayName ?? "",
      });
      setSelBackendKind(editAgent.backendKind ?? "oma");
      setSetupSession(null);
    }
  }, [editAgent, form]);

  // New agents: default the model to the first catalog entry of the
  // selected backend kind once loaded. Keeps the current value if it is
  // already a valid catalog id.
  useEffect(() => {
    if (isEdit || modelGroups.length === 0) return;
    const current = form.getValues("model");
    if (
      current &&
      modelGroups.some((m) => m.id === current && m.backendKind === form.getValues("backendKind"))
    ) {
      return;
    }
    const first = modelGroups.find(
      (m) => m.backendKind === form.getValues("backendKind") && m.available,
    );
    if (first) form.setValue("model", first.id, { shouldValidate: true });
  }, [isEdit, modelGroups, form]);

  // Poll setup session when pending
  useEffect(() => {
    const status = setupSession?.status;
    const setupId = setupSession?.setupId;
    const agentId = editAgent?.id;
    if (status !== "pending" || !agentId || !setupId) return;
    const interval = setInterval(async () => {
      try {
        const session = await api.larkSetupStatus(agentId, setupId);
        setSetupSession(session);
        if (session.status !== "pending") {
          clearInterval(interval);
          queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
          queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
        }
      } catch {
        clearInterval(interval);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [setupSession?.status, setupSession?.setupId, editAgent?.id, queryClient]);

  // Skill pack assignments
  const { data: availablePacks } = useSkillPackList();
  const { data: assignedPacks } = useAgentSkillPacks(editAgent?.id ?? "");
  const setPacksMutation = useSetAgentPacks(editAgent?.id ?? "");

  // Sync assigned packs to local state when loaded
  useEffect(() => {
    if (assignedPacks) {
      setSelectedPackIds(assignedPacks.map((p: { id: string }) => p.id));
    }
  }, [assignedPacks]);

  function buildBody(values: AgentFormValues): Parameters<typeof api.createAgent>[0] {
    const body: Record<string, unknown> = {
      name: values.name,
      backendKind: values.backendKind,
      model: {
        provider: values.model.split("/")[0] ?? "anthropic",
        model: values.model.split("/").slice(1).join("/") || values.model,
      },
      permissionMode: values.permissionMode,
      ...(values.workspacePath ? { workspacePath: values.workspacePath } : {}),
      ...(values.maxSteps ? { maxSteps: parseInt(values.maxSteps, 10) } : {}),
      reasoningEffort: values.reasoningEffort || null,
    };
    if (values.enableLark)
      body.lark = {
        enabled: true,
        ...(values.botDisplayName ? { botDisplayName: values.botDisplayName } : {}),
      };
    else if (isEdit && editAgent?.lark?.enabled) body.lark = { enabled: false };
    return body as Parameters<typeof api.createAgent>[0];
  }

  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent(editAgent?.id ?? "");

  async function onSubmit(values: AgentFormValues) {
    setServerError("");
    if (isEdit) {
      try {
        await updateMutation.mutateAsync(buildBody(values));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save agent";
        setServerError(msg);
        toast.error("Failed to save agent", { description: msg });
        return;
      }

      // Assign skill packs after agent update succeeds
      if (editAgent?.id) {
        try {
          await setPacksMutation.mutateAsync(selectedPackIds);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to assign skill packs";
          toast.error(msg);
          // Don't close the form — let user retry allocation
          return;
        }
      }

      toast.success("Agent updated");
      setOpen(false);
      onSuccess?.();
    } else {
      try {
        const agent = await createMutation.mutateAsync(buildBody(values));
        toast.success("Agent created");
        form.reset();
        setOpen(false);
        router.push(`/team/${agent.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save agent";
        setServerError(msg);
        toast.error("Failed to save agent", { description: msg });
      }
    }
  }

  // onSubmit is now fire-and-forget (mutate, not await), so react-hook-form's
  // formState.isSubmitting no longer tracks the request — derive the in-flight
  // state from the mutations instead, otherwise the submit button stays enabled
  // and double-submits create duplicate agents.
  const isSaving = createMutation.isPending || updateMutation.isPending;
  // useWatch (not getValues) so the submit button re-evaluates as the user
  // types: the Name field is an isolated Controller/FormField, so a
  // non-reactive getValues("name") read leaves the button stuck disabled.
  const nameValue = useWatch({ control: form.control, name: "name" });

  const hintClass = "text-[10px] text-[var(--mute)] mt-1";

  return (
    <>
      <Button
        onClick={() => {
          form.reset();
          setServerError("");
          setOpen(true);
        }}
        variant={triggerLabel ? "outline" : "default"}
        size="sm"
      >
        {triggerLabel ?? "+ New Agent"}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" role="dialog">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          <div className="relative w-full max-w-lg bg-(--canvas) border border-(--hairline) rounded-lg animate-reveal">
            <div className="border-b border-(--hairline) px-8 py-5 flex items-center justify-between">
              <h2 className="text-lg font-normal text-(--ink-strong) font-sans">
                {isEdit ? "Edit Agent" : "Create Agent"}
              </h2>
              <Button
                onClick={() => setOpen(false)}
                className="text-(--mute) hover:text-(--ink) transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </Button>
            </div>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="px-8 py-6 space-y-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={`${overlineClass} mb-1.5 block`}>Name *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Archivist" className={fieldClass} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="backendKind"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Backend</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={(v) => {
                            const vv = v ?? "";
                            field.onChange(vv);
                            setSelBackendKind(vv);
                            // Switching backend resets provider/model: the
                            // two catalogs are disjoint (D3). Pick the first
                            // available model of the new kind.
                            const current = form.getValues("model");
                            const stillValid = modelGroups.some(
                              (m) => m.id === current && m.backendKind === vv && m.available,
                            );
                            if (stillValid) return;
                            setSelProvider("");
                            const first = modelGroups.find(
                              (m) => m.backendKind === vv && m.available,
                            );
                            form.setValue("model", first?.id ?? "", {
                              shouldValidate: true,
                            });
                          }}
                        >
                          <SelectTrigger className={fieldClass}>
                            <SelectValue placeholder="Select backend…" />
                          </SelectTrigger>
                          <SelectContent>
                            {backendKinds.map((k) => (
                              <SelectItem key={k} value={k}>
                                {k}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {!hideProvider && (
                    <FormField
                      control={form.control}
                      name="model"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className={`${overlineClass} mb-1.5 block`}>
                            Provider
                          </FormLabel>
                          <Select
                            value={field.value.split("/")[0] ?? ""}
                            onValueChange={(v) => {
                              const vv = v ?? "";
                              setSelProvider(vv);
                              // Never carry a model across providers: pick
                              // the first available model of the new provider.
                              const current = field.value;
                              const stillValid = modelGroups.some(
                                (m) =>
                                  m.id === current &&
                                  m.provider === vv &&
                                  m.backendKind === selBackendKind &&
                                  m.available,
                              );
                              if (stillValid) return;
                              const first = modelGroups.find(
                                (m) =>
                                  m.provider === vv &&
                                  m.backendKind === selBackendKind &&
                                  m.available,
                              );
                              field.onChange(first?.id ?? "");
                            }}
                          >
                            <SelectTrigger className={fieldClass}>
                              <SelectValue placeholder="Select provider…" />
                            </SelectTrigger>
                            <SelectContent>
                              {kindProviders.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Model *</FormLabel>
                        <FormControl>
                          <Select
                            value={field.value}
                            onValueChange={(v) => field.onChange(v ?? "")}
                          >
                            <SelectTrigger className={fieldClass}>
                              <SelectValue placeholder="Select model…" />
                            </SelectTrigger>
                            <SelectContent>
                              {filteredModels.map((m) => (
                                <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                                  <span className="flex items-center gap-2">
                                    {m.reasoning && (
                                      <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium">
                                        reasoning
                                      </span>
                                    )}
                                    <span>{m.name}</span>
                                    <span className="text-[10px] text-(--mute)">
                                      {(m.contextWindow / 1000).toFixed(0)}K ctx
                                    </span>
                                    {!m.available && (
                                      <span className="text-(--mute)">— unavailable</span>
                                    )}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                        {selectedModelMeta && (
                          <div className={`${hintClass} flex flex-wrap gap-x-3 gap-y-0.5`}>
                            {selectedModelMeta.reasoning && (
                              <span className="text-blue-500">🧠 reasoning</span>
                            )}
                            <span>ctx: {(selectedModelMeta.contextWindow / 1000).toFixed(0)}K</span>
                            <span>out: {(selectedModelMeta.maxTokens / 1000).toFixed(0)}K</span>
                            <span>
                              ${selectedModelMeta.cost.input}/${selectedModelMeta.cost.output}/M
                            </span>
                            {selectedModelMeta.inputModalities.includes("image") && (
                              <span>📷 image</span>
                            )}
                          </div>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {!hideProvider && modelGroups.length === 0 && <ProviderSetupInline />}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {!hidePermission && (
                    <FormField
                      control={form.control}
                      name="permissionMode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className={`${overlineClass} mb-1.5 block`}>
                            Permission Mode
                          </FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className={fieldClass}>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="ask">Ask (approval)</SelectItem>
                              <SelectItem value="auto">Auto</SelectItem>
                              <SelectItem value="deny">Deny</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                  {!hideEffort && (
                    <FormField
                      control={form.control}
                      name="reasoningEffort"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className={`${overlineClass} mb-1.5 block`}>
                            Reasoning Effort
                          </FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className={fieldClass}>
                                <SelectValue placeholder="Provider default" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="">Provider default</SelectItem>
                              <SelectItem value="none">None (thinking off)</SelectItem>
                              <SelectItem value="low">Low</SelectItem>
                              <SelectItem value="high">High</SelectItem>
                              <SelectItem value="max">Max</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                  <FormField
                    control={form.control}
                    name="maxSteps"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Max Steps</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            placeholder="Unlimited"
                            min={1}
                            className={fieldClass}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="workspacePath"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Workspace</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder=".backend-data/agents/<id>"
                            className={fieldClass}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <AgentFormLarkSection
                  control={form.control}
                  isEdit={isEdit}
                  editAgent={editAgent}
                  enableLark={enableLark}
                  setupSession={setupSession}
                  setupLoading={setupLoading}
                  setSetupSession={setSetupSession}
                  setSetupLoading={setSetupLoading}
                  getBotDisplayName={() => form.getValues("botDisplayName")}
                />

                <AgentFormSkillPacks
                  isEdit={isEdit}
                  availablePacks={availablePacks ?? []}
                  selectedPackIds={selectedPackIds}
                  onToggle={(packId, checked) =>
                    setSelectedPackIds((prev) =>
                      checked ? [...prev, packId] : prev.filter((id) => id !== packId),
                    )
                  }
                />

                {serverError && <p className="text-xs text-destructive">{serverError}</p>}

                <Button
                  type="submit"
                  disabled={
                    isSaving ||
                    !(nameValue ?? "").trim() ||
                    (!isEdit && !hideProvider && modelGroups.length === 0)
                  }
                  className="w-full"
                >
                  {isSaving ? (
                    "Saving..."
                  ) : isEdit ? (
                    <span className="inline-flex items-center gap-1">
                      Save Changes <ArrowRight size={14} />
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      Create Agent <Plus size={14} />
                    </span>
                  )}
                </Button>
              </form>
            </Form>
          </div>
        </div>
      )}
    </>
  );
}
