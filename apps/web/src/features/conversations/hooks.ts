import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ChatModelOverride } from "@/lib/api";
import { api, type ConversationSnapshot } from "@/lib/api";
import {
  conversationDetailQuery,
  conversationInputsQuery,
  conversationListQuery,
  recentConversationsQuery,
} from "./queries";
import { conversationKeys } from "./query-keys";

export function useConversationList(agentId: string) {
  return useQuery(conversationListQuery(agentId));
}

export function useRecentConversations() {
  return useQuery(recentConversationsQuery());
}
export function useConversationTitle(conversationId: string) {
  return useQuery({ ...conversationDetailQuery(conversationId), staleTime: 60_000 });
}

/** All conversations (unscoped) — the chat rail, no agent filtering. */
export function useAllConversations() {
  return useQuery({
    queryKey: conversationKeys.all,
    queryFn: () => api.listConversations(),
    staleTime: 10_000,
  });
}

export function useDeleteConversation() {
  return useMutation({ mutationFn: (id: string) => api.deleteConversation(id) });
}

export function useCreateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createConversation>[0]) =>
      api.createConversation(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.all });
    },
  });
}

/** Create a 1:1 human<->agent conversation and navigate into it. */
export function useStartChat(agentId: string, _agentName?: string) {
  const router = useRouter();
  const qc = useQueryClient();
  const create = useCreateConversation();

  const start = () => {
    create.mutate(
      {
        agentId,
      },
      {
        onSuccess: (conv) => {
          qc.invalidateQueries({ queryKey: conversationKeys.byAgent(agentId) });
          router.push(`/chat/${conv.conversationId}`);
        },
        onError: (err) => {
          toast.error("Failed to create conversation", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  };

  return { isPending: create.isPending, start };
}

export function useConversationSnapshot(
  conversationId: string,
  initialData?: ConversationSnapshot | null,
) {
  // Inline on purpose: the pre-fetched snapshot type is looser than the
  // query's strict return, and this hook lives outside component land.
  return useQuery({
    queryKey: conversationKeys.detail(conversationId),
    queryFn: () => api.getConversation(conversationId),
    initialData: initialData ?? undefined,
  });
}

export function useConversationSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: conversationKeys.search(q),
    queryFn: () => api.searchConversations(q),
    enabled,
  });
}

export function useConversationInputs(conversationId: string) {
  return useQuery({
    ...conversationInputsQuery(conversationId),
    refetchInterval: (query: { state: { data?: { inputs?: unknown[] } } }) =>
      query.state.data?.inputs?.length ? 2000 : false,
  });
}

export function usePostConversationMessage(conversationId: string) {
  return useMutation({
    mutationFn: (params: {
      text: string;
      mode?: "normal" | "steer" | "follow_up";
      model?: ChatModelOverride;
      attachments?: readonly { type: "image"; mediaType: string; base64: string }[];
    }) => {
      const blocks = params.attachments?.length
        ? [
            ...(params.text ? [{ type: "text" as const, text: params.text }] : []),
            ...params.attachments,
          ]
        : undefined;
      return api.postConversationMessage(conversationId, {
        content: blocks ?? params.text,
        mode: params.mode,
        model: params.model,
      });
    },
  });
}
export function useForkConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; fromSeq: number; title?: string }) =>
      api.forkConversation(params.id, params.fromSeq, params.title),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.all });
    },
  });
}

export function useUndoMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; count?: number }) =>
      api.undoMessages(params.id, params.count ?? 1),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: conversationKeys.detail(vars.id) });
    },
  });
}

export function useReplayFromMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; fromSeq: number; editedContent: string }) =>
      api.replayFromMessage(params.id, params.fromSeq, params.editedContent),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.all });
    },
  });
}

export { conversationKeys };
