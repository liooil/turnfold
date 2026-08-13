import type {StoredChatMessage} from "./conversation-types";

export const untitledConversationLabel = "未命名会话";

function messageText(message: StoredChatMessage) {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
}

export function conversationTitlePrompt(messages: StoredChatMessage[]) {
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(0, 4)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${messageText(message).slice(0, 2000)}`)
    .filter((line) => !line.endsWith("："))
    .join("\n\n");
  return `请为下面的对话生成一个简洁、具体的中文标题。只输出标题，不要解释，不要加引号、Markdown 或“标题：”前缀。标题不超过 30 个字符，不要使用斜杠。\n\n${transcript}`;
}

export function normalizeGeneratedConversationTitle(value: string) {
  let title = value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .split(/\r?\n/)[0]
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:标题|title)\s*[：:]\s*/i, "")
    .replace(/^[`'“”‘’\"]+|[`'“”‘’\"]+$/g, "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("/", "／")
    .trim();
  title = [...title].slice(0, 60).join("").trim();
  return title;
}
