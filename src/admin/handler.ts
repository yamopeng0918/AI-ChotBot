import { parseAdminCommand, resolveAdminTarget } from "./commands";
import { GroupAdminsRepository, type GroupAdminRecord } from "./group-admins";
import type { LineWebhookEvent } from "../line/types";

const ADD_SUCCESS = "已新增管理員。";
const REMOVE_SUCCESS = "已移除管理員。";
const LIST_PREFIX = "目前管理員列表：";
const UNAUTHORIZED = "你沒有權限執行這個指令。";
const WRONG_CHAT_TYPE = "這個指令只能在群組中使用。";
const NOT_FOUND = "找不到這位管理員。";
const ALREADY_EXISTS = "這位管理員已經在名單內。";

type AdminHandlerDependencies = {
  groupAdmins: GroupAdminsRepository;
  bootstrapJson: string | undefined;
};

export async function ensureBootstrapForGroup(
  repository: GroupAdminsRepository,
  bootstrapJson: string | undefined,
  groupId: string,
): Promise<void> {
  const bootstrap = repository.parseBootstrap(bootstrapJson);
  await repository.ensureBootstrap(groupId, bootstrap[groupId] ?? [], "bootstrap");
}

function formatAdminList(admins: GroupAdminRecord[]): string {
  return `${LIST_PREFIX}\n${admins.map((admin) => `- ${admin.displayName} (${admin.userId})`).join("\n")}`;
}

export async function handleAdminCommand(
  event: LineWebhookEvent,
  dependencies: AdminHandlerDependencies,
): Promise<{ handled: boolean; replyText?: string }> {
  if (event.type !== "message" || event.message?.type !== "text" || typeof event.message.text !== "string") {
    return { handled: false };
  }

  const command = parseAdminCommand(event.message.text);
  if (!command) return { handled: false };

  if (event.source?.type !== "group" || typeof event.source.groupId !== "string") {
    return { handled: true, replyText: WRONG_CHAT_TYPE };
  }

  await ensureBootstrapForGroup(dependencies.groupAdmins, dependencies.bootstrapJson, event.source.groupId);

  if (!(await dependencies.groupAdmins.isAdmin(event.source.groupId, event.source.userId ?? null))) {
    return { handled: true, replyText: UNAUTHORIZED };
  }

  if (command.kind === "list") {
    return {
      handled: true,
      replyText: formatAdminList(await dependencies.groupAdmins.list(event.source.groupId)),
    };
  }

  const target = resolveAdminTarget(event, command);
  if (!target) return { handled: true, replyText: NOT_FOUND };

  if (command.kind === "add") {
    if (await dependencies.groupAdmins.isAdmin(event.source.groupId, target.userId)) {
      return { handled: true, replyText: ALREADY_EXISTS };
    }

    await dependencies.groupAdmins.upsert(event.source.groupId, target, "command");
    return { handled: true, replyText: ADD_SUCCESS };
  }

  if (!(await dependencies.groupAdmins.remove(event.source.groupId, target.userId))) {
    return { handled: true, replyText: NOT_FOUND };
  }

  return { handled: true, replyText: REMOVE_SUCCESS };
}
