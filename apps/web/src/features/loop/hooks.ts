import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { loopKeys } from "./query-keys";

function loopListQuery() {
  return queryOptions({ queryKey: loopKeys.all, queryFn: api.listLoops });
}

export function useLoopList() {
  return useQuery(loopListQuery());
}

export function useLoopDetail(id: string) {
  return useQuery({
    queryKey: loopKeys.detail(id),
    queryFn: () => api.getLoop(id),
  });
}

export function useCreateLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      intent?: string;
      goal?: string;
      action?: string;
      acceptance?: string;
      verifyCommands?: string[];
      projectId?: string;
      agent?: string;
      cronExpr?: string;
    }) => api.createLoop(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.all }),
  });
}

export function useRunLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.runLoop(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: loopKeys.detail(id) });
      qc.invalidateQueries({ queryKey: loopKeys.all });
    },
  });
}

export function useDoctorLoop() {
  return useMutation({
    mutationFn: (id: string) => api.doctorLoop(id),
  });
}

export function useTriageLoop(loopId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sources?: string[]) => api.triageLoop(loopId, sources),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.detail(loopId) }),
  });
}

export function useReviewLoopItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      itemId: string;
      verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
      feedback?: string;
    }) => api.reviewLoopItem(id, body),
    onSuccess: (data) => {
      if ("action" in data) toast.success(`Item ${data.action}`);
      qc.invalidateQueries({ queryKey: loopKeys.detail(id) });
      qc.invalidateQueries({ queryKey: loopKeys.all });
    },
  });
}

export function useDeleteLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteLoop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.all }),
  });
}

export function useActivateLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.activateLoop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.all }),
  });
}

export function useDeactivateLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deactivateLoop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.all }),
  });
}

export function useRefineLoop(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { intent: string; clarifyRound?: number }) => api.refineLoop(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.all }),
  });
}

export function useAddLoopItem(loopId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      source: string;
      summary: string;
      priority?: number;
      taskClass?: "bugfix" | "feature" | "refactor" | "research" | "review" | "chore";
    }) => api.addLoopItem(loopId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.detail(loopId) }),
  });
}

export function useDeferItem(loopId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; reason: string; until?: number; after?: string[] }) =>
      api.deferLoopItem(loopId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.detail(loopId) }),
  });
}

export function useUndeferItem(loopId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.undeferLoopItem(loopId, itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.detail(loopId) }),
  });
}
