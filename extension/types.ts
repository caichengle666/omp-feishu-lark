export type Domain = "feishu" | "lark";
export type GroupPolicy = "open" | "mention";
export type CardActionMode = "webhook" | "ws";

export type OmpApprovalMode = "always-ask" | "write" | "yolo";

export type FeishuOmpLaunch = {
  /** Load OMP skills instead of passing --no-skills to the daemon. */
  enableSkills?: boolean;
  /** Comma-friendly glob patterns passed to omp --skills. */
  skills?: string[];
  /** Explicit tool allowlist passed to omp --tools. */
  tools?: string[];
  /** Remote sessions cannot answer interactive approval prompts. */
  approvalMode?: OmpApprovalMode;
  /** Duration accepted by omp --max-time, e.g. "30m". */
  maxTime?: string;
  appendSystemPrompt?: string;
  /** Additional workspace directories exposed via omp --add-dir. */
  addDirs?: string[];
};

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: Domain;
  groupPolicy: GroupPolicy;
  cardActionMode?: CardActionMode;
  /** Verification token for the card-action webhook (校验 webhook 回调签名). */
  cardActionToken?: string;
  cardActionWebhookHost?: string;
  cardActionWebhookPort?: number;
  cardActionWebhookPath?: string;
  notificationWebhookEnabled?: boolean;
  notificationWebhookHost?: string;
  notificationWebhookPort?: number;
  notificationWebhookPath?: string;
  /** Bearer token required by the external notification webhook. */
  notificationWebhookToken?: string;
  language?: "zh" | "en";
  reactEmoji?: string;
  autoStart?: boolean;
  /** Feishu user open IDs allowed to run remote administrative commands. */
  adminOpenIds?: string[];
  /** Seconds before a long-running task sends a "still working" notice to chat (0 disables). Default 180. */
  promptNotifySec?: number;
  /** Hard prompt timeout in seconds; the session is aborted on expiry (0 disables / wait indefinitely). Default 0. */
  promptTimeoutSec?: number;
  /** Explicit opt-in for the hard prompt timeout. Old configs without this flag remain unlimited. */
  promptTimeoutEnabled?: boolean;
  ompLaunch?: FeishuOmpLaunch;
};

export type ModelSelection = {
  provider: string;
  id: string;
  thinkingLevel?: FeishuThinkingLevel;
};

export type FeishuThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const FEISHU_THINKING_LEVELS: readonly FeishuThinkingLevel[] = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type FeishuState = {
  sessions: Record<string, string>;
  /** Session files created or explicitly selected by each Feishu conversation. */
  history?: Record<string, string[]>;
  models?: Record<string, ModelSelection>;
  thinkingLevels?: Record<string, FeishuThinkingLevel>;
  autoCompaction?: Record<string, boolean>;
  workspaces?: Record<string, string>;
};

export type FeishuRoute = {
  sessionKey: string;
  sessionId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadMessageId?: string;
  lastMessageId: string;
  updatedAt: number;
};

export type FeishuJobRoute = FeishuRoute & {
  jobId: string;
  jobName?: string;
  createdAt: number;
};

export type FeishuBridgeState = {
  version: 1;
  routes: Record<string, FeishuRoute>;
  jobs: Record<string, FeishuJobRoute>;
  sent: Record<string, number>;
};

export type FeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  chatMode?: "p2p" | "group" | "topic";
  senderOpenId: string;
  msgType: string;
  content: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentions?: unknown[];
};

export type FeishuAttachment = {
  kind: "image" | "file" | "audio";
  fileKey: string;
  fileName?: string;
};

export type FeishuCardAction = {
  messageId: string;
  chatId?: string;
  operatorOpenId: string;
  token?: string;
  value: unknown;
  formValue?: Record<string, unknown>;
};

export type FeishuStatus = "not configured" | "connecting" | "connected" | "owned" | "bot unavailable" | "disconnected";
