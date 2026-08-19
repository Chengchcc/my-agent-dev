import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ChatModelOverride } from "@/lib/api";
import { api, type ConversationSnapshot } from "@/lib/api";
import { conversationKeys } from "./query-keys";

function listByAgentQuery(agentId: string) {
  return queryOptions({
    queryKey: conversationKeys.byAgent(agentId),
    queryFn: () => api.listConversations(agentId),
    enabled: !!agentId,
    staleTime: 10_000,
  });
}
export function useConversationList(agentId: string) {
  return useQuery(listByAgentQuery(agentId));
}

export function useRecentConversations() {
  return useQuery({
    queryKey: conversationKeys.recent(),
    queryFn: () => api.listConversations(),
    refetchInterval: 10_000,
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
export function useStartChat(agentId: string, agentName?: string) {
  const router = useRouter();
  const qc = useQueryClient();
  const create = useCreateConversation();

  const start = () => {
    const humanId = `human-${crypto.randomUUID().slice(0, 8)}`;
    create.mutate(
      {
        members: [
          { memberId: agentId, kind: "agent", agentId, displayName: agentName },
          { memberId: humanId, kind: "human", userRef: "__legacy__", displayName: "User" },
        ],
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
  return useQuery({
    queryKey: conversationKeys.detail(conversationId),
    queryFn: () => api.getConversation(conversationId),
    initialData: initialData ?? undefined,
  });
}
export function usePostConversationMessage(conversationId: string) {
  return useMutation({
    mutationFn: (params: {
      senderMemberId: string;
      text: string;
      addressedTo: string[];
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
        senderMemberId: params.senderMemberId,
        addressedTo: params.addressedTo,
        content: blocks ?? params.text,
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
    mutationFn: (params: {
      id: string;
      fromSeq: number;
      editedContent: string;
      senderMemberId: string;
      addressedTo: string[];
    }) =>
      api.replayFromMessage(
        params.id,
        params.fromSeq,
        params.editedContent,
        params.senderMemberId,
        params.addressedTo,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.all });
    },
  });
}

export { conversationKeys };
