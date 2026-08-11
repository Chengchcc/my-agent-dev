import { parseEnv } from "@my-agent-team/config";
import { ConversationCanvas } from "@/components/ConversationCanvas";
import { createServerClient, unwrap } from "@/lib/client";

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ initial?: string; at?: string }>;
}) {
  const { conversationId: id } = await params;
  const { initial, at } = await searchParams;
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const snapshot = await unwrap(client.api.conversations({ id }).get()).catch(() => null);
  return (
    <ConversationCanvas
      conversationId={id}
      snapshot={snapshot}
      initialMessage={initial}
      anchorSeq={at ? Number(at) : null}
    />
  );
}
