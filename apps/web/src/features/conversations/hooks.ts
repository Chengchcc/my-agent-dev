import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function useAddConversationMember(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.addConversationMember>[1]) =>
      api.addConversationMember(conversationId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.detail(conversationId) });
    },
  });
}

export function useRemoveConversationMember(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => api.removeConversationMember(conversationId, memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: conversationKeys.detail(conversationId) });
    },
  });
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
    mutationFn: (params: { senderMemberId: string; text: string; addressedTo: string[] }) =>
      api.postConversationMessage(conversationId, {
        senderMemberId: params.senderMemberId,
        addressedTo: params.addressedTo,
        content: params.text,
      }),
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
