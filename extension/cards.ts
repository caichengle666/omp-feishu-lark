import { feishuHelpText, formatOmpCommands, type OmpCommandInfo } from "./help.js";

export function modelLabel(model: any) {
  if (!model) return "未选择";
  return `${model.provider}/${model.id}`;
}

export type ResumeScope = "current" | "all";

export type ResumeSessionItem = {
  path: string;
  title: string;
  subtitle: string;
  modifiedLabel: string;
  workspaceLabel?: string;
  isCurrent: boolean;
};

export type ResumeSessionPage = {
  key: string;
  scope: ResumeScope;
  page: number;
  total: number;
  totalPages: number;
  items: ResumeSessionItem[];
};

export type HelpCardOptions = {
  key: string;
  ownerOpenId: string;
  chatId: string;
  chatType: "p2p" | "group";
  ompCommands?: ReadonlyArray<OmpCommandInfo>;
  draft?: string;
};

export type HelpActionRun = {
  action: "pi_feishu_help_run";
  key: string;
  chatType: "p2p" | "group";
  command: string;
  ownerOpenId: string;
  chatId: string;
};

export type HelpActionFill = {
  action: "pi_feishu_help_fill";
  key: string;
  chatType: "p2p" | "group";
  draft: string;
  ownerOpenId: string;
  chatId: string;
};

export type HelpActionSubmit = {
  action: "pi_feishu_help_submit";
  key: string;
  chatType: "p2p" | "group";
  inputName: string;
  ownerOpenId: string;
  chatId: string;
};

const HELP_RUN_BUTTONS: Array<{ label: string; command: string; type?: string }> = [
  { label: "新建会话", command: "new" },
  { label: "恢复历史", command: "resume" },
  { label: "选择模型", command: "model" },
  { label: "停止任务", command: "stop" },
  { label: "OMP 命令", command: "commands" },
  { label: "高思考强度", command: "effort high", type: "primary" },
  { label: "低思考强度", command: "effort low" },
  { label: "自动压缩开", command: "autocompact on" },
  { label: "自动压缩关", command: "autocompact off" },
  { label: "压缩上下文", command: "compact" },
];

const HELP_FILL_BUTTONS: Array<{ label: string; draft: string }> = [
  { label: "填入 /effort", draft: "/effort " },
  { label: "填入 /compact", draft: "/compact " },
  { label: "填入 /workspace", draft: "/workspace " },
  { label: "填入 /send", draft: "/send " },
  { label: "填入 /feishu upgrade", draft: "/feishu upgrade " },
];

export function buildHelpCard(options: HelpCardOptions) {
  const elements: any[] = [
    {
      tag: "markdown",
      content: `${feishuHelpText()}\n\n点击按钮即可执行常用操作；带参数的命令先填到下面输入框，补完参数后点 **执行**。`,
    },
    ...buttonRow(HELP_RUN_BUTTONS.map((entry) => ({
      label: entry.label,
      type: entry.type,
      value: {
        action: "pi_feishu_help_run",
        key: options.key,
        chatType: options.chatType,
        command: entry.command,
        ownerOpenId: options.ownerOpenId,
        chatId: options.chatId,
      } satisfies HelpActionRun,
    }))),
    { tag: "hr" },
    {
      tag: "markdown",
      content: "需要自己补参数的命令：",
    },
    ...buttonRow(HELP_FILL_BUTTONS.map((entry) => ({
      label: entry.label,
      value: {
        action: "pi_feishu_help_fill",
        key: options.key,
        chatType: options.chatType,
        draft: entry.draft,
        ownerOpenId: options.ownerOpenId,
        chatId: options.chatId,
      } satisfies HelpActionFill,
    }))),
    {
      tag: "form",
      element_id: "help_command_form",
      name: "help_command_form",
      direction: "vertical",
      elements: [
        {
          tag: "input",
          element_id: "help_command_input",
          name: "help_command_input",
          label: { tag: "plain_text", content: "命令" },
          placeholder: { tag: "plain_text", content: "先点上方按钮填入前缀，或直接输入完整命令" },
          default_value: options.draft || "",
          width: "fill",
          required: true,
          input_type: "text",
        },
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "8px",
          columns: [
            {
              tag: "column",
              width: "auto",
              elements: [{
                tag: "button",
                name: "help_submit_button",
                form_action_type: "submit",
                type: "primary_filled",
                text: { tag: "plain_text", content: "执行" },
                behaviors: [{
                  type: "callback",
                  value: {
                    action: "pi_feishu_help_submit",
                    key: options.key,
                    chatType: options.chatType,
                    inputName: "help_command_input",
                    ownerOpenId: options.ownerOpenId,
                    chatId: options.chatId,
                  } satisfies HelpActionSubmit,
                }],
              }],
            },
            {
              tag: "column",
              width: "auto",
              elements: [{
                tag: "button",
                name: "help_reset_button",
                form_action_type: "reset",
                type: "default",
                text: { tag: "plain_text", content: "重置" },
              }],
            },
          ],
        },
      ],
    },
  ];

  const ompText = options.ompCommands?.length ? formatOmpCommands(options.ompCommands) : "当前 OMP 会话暂无可用命令列表。";
  elements.push({ tag: "markdown", content: ompText });

  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "OMP 飞书帮助" },
    },
    body: { elements },
  };
}

function buttonRow(buttons: Array<{ label: string; type?: string; value: Record<string, unknown> }>): any[] {
  const rows: any[][] = [];
  for (let index = 0; index < buttons.length; index += 3) {
    rows.push(buttons.slice(index, index + 3));
  }
  return rows.map((row) => ({
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: row.map((button) => ({
      tag: "column",
      width: "auto",
      weight: 1,
      vertical_align: "top",
      elements: [{
        tag: "button",
        text: { tag: "plain_text", content: button.label },
        type: button.type || "default",
        behaviors: [{ type: "callback", value: button.value }],
      }],
    })),
  }));
}

export function buildModelCard(key: string, models: any[], currentModel: any, ownerOpenId?: string, chatId?: string, currentThinkingLevel?: string) {
  const current = modelLabel(currentModel);
  const thinking = currentThinkingLevel || "跟随 OMP 默认";
  const elements: any[] = [
    {
      tag: "markdown",
      content: `当前模型：**${current}**\n当前思考强度：**${thinking}**\n点击下面的按钮即可切换当前飞书会话使用的模型。`,
    },
  ];

  const rows: any[][] = [];
  for (let i = 0; i < models.length; i += 2) {
    rows.push(models.slice(i, i + 2));
  }

  for (const row of rows) {
    elements.push({
      tag: "action",
      actions: row.map((model) => {
        const isCurrent = currentModel?.provider === model.provider && currentModel?.id === model.id;
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: `${isCurrent ? "当前 " : ""}${model.provider}/${model.id}`,
          },
          type: isCurrent ? "primary" : "default",
          value: {
            action: "pi_feishu_select_model",
            key,
            provider: model.provider,
            modelId: model.id,
            ownerOpenId,
            chatId,
          },
        };
      }),
    });
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "选择 OMP 模型" },
    },
    elements,
  };
}

export function buildResumeCard(data: ResumeSessionPage, ownerOpenId?: string, chatId?: string) {
  const scopeLabel = "当前飞书会话";
  const elements: any[] = [
    {
      tag: "markdown",
      content: [
        `当前视图：**${scopeLabel}**`,
        data.total
          ? `第 **${data.page + 1} / ${data.totalPages}** 页，共 **${data.total}** 条历史会话。`
          : "还没有可切换的历史会话。",
        "点击某条会话后，当前飞书对话会继续接着这条 OMP 会话往下聊。",
      ].join("\n"),
    },
  ];

  for (const item of data.items) {
    const lines = [
      `**${escapeMarkdown(item.title)}**${item.isCurrent ? " `当前使用中`" : ""}`,
      escapeMarkdown(item.subtitle),
      `更新时间：${escapeMarkdown(item.modifiedLabel)}`,
    ];
    if (item.workspaceLabel) lines.push(`工作区：${escapeMarkdown(item.workspaceLabel)}`);
    elements.push({
      tag: "markdown",
      content: lines.join("\n"),
    });
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: item.isCurrent ? "当前会话" : "切换到这条会话",
        },
        type: item.isCurrent ? "primary" : "default",
        value: {
          action: "pi_feishu_resume_select",
          key: data.key,
          scope: data.scope,
          page: data.page,
          sessionPath: item.path,
          ownerOpenId,
          chatId,
        },
      }],
    });
  }

  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "上一页" },
        type: "default",
        disabled: data.page <= 0,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.max(0, data.page - 1),
          ownerOpenId,
          chatId,
        },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "下一页" },
        type: "default",
        disabled: data.page >= data.totalPages - 1,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.min(Math.max(0, data.totalPages - 1), data.page + 1),
          ownerOpenId,
          chatId,
        },
      },
    ],
  });

  return {
    config: sharedCardConfig(),
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "切换 Pi 历史会话" },
    },
    elements,
  };
}

export function parseHelpActionValue(value: unknown): HelpActionRun | HelpActionFill | HelpActionSubmit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action === "pi_feishu_help_run") {
    if (typeof raw.key !== "string" || typeof raw.command !== "string") return undefined;
    const chatType = normalizeChatType(raw.chatType);
    if (!chatType) return undefined;
    return {
      action: "pi_feishu_help_run",
      key: raw.key,
      chatType,
      command: raw.command,
      ownerOpenId: typeof raw.ownerOpenId === "string" ? raw.ownerOpenId : "",
      chatId: typeof raw.chatId === "string" ? raw.chatId : "",
    };
  }
  if (raw.action === "pi_feishu_help_fill") {
    if (typeof raw.key !== "string" || typeof raw.draft !== "string") return undefined;
    const chatType = normalizeChatType(raw.chatType);
    if (!chatType) return undefined;
    return {
      action: "pi_feishu_help_fill",
      key: raw.key,
      chatType,
      draft: raw.draft,
      ownerOpenId: typeof raw.ownerOpenId === "string" ? raw.ownerOpenId : "",
      chatId: typeof raw.chatId === "string" ? raw.chatId : "",
    };
  }
  if (raw.action === "pi_feishu_help_submit") {
    if (typeof raw.key !== "string" || typeof raw.inputName !== "string") return undefined;
    const chatType = normalizeChatType(raw.chatType);
    if (!chatType) return undefined;
    return {
      action: "pi_feishu_help_submit",
      key: raw.key,
      chatType,
      inputName: raw.inputName,
      ownerOpenId: typeof raw.ownerOpenId === "string" ? raw.ownerOpenId : "",
      chatId: typeof raw.chatId === "string" ? raw.chatId : "",
    };
  }
  return undefined;
}

function normalizeChatType(value: unknown): "p2p" | "group" | undefined {
  return value === "p2p" || value === "group" ? value : undefined;
}

export function parseModelActionValue(value: unknown): { key: string; provider: string; modelId: string; ownerOpenId?: string; chatId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_model") return undefined;
  if (typeof raw.key !== "string" || typeof raw.provider !== "string" || typeof raw.modelId !== "string") return undefined;
  return {
    key: raw.key,
    provider: raw.provider,
    modelId: raw.modelId,
    ownerOpenId: typeof raw.ownerOpenId === "string" ? raw.ownerOpenId : undefined,
    chatId: typeof raw.chatId === "string" ? raw.chatId : undefined,
  };
}

export function parseResumePageActionValue(value: unknown): { key: string; scope: ResumeScope; page: number; ownerOpenId?: string; chatId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_page") return undefined;
  if (typeof raw.key !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return {
    key: raw.key,
    scope: raw.scope,
    page: Math.max(0, Math.floor(raw.page)),
    ownerOpenId: typeof raw.ownerOpenId === "string" ? raw.ownerOpenId : undefined,
    chatId: typeof raw.chatId === "string" ? raw.chatId : undefined,
  };
}

export function parseResumeSelectActionValue(value: unknown): { key: string; scope: ResumeScope; page: number; sessionPath: string; ownerOpenId?: string; chatId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_select") return undefined;
  if (typeof raw.key !== "string" || typeof raw.sessionPath !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return {
    key: raw.key,
    scope: raw.scope,
    page: Math.max(0, Math.floor(raw.page)),
    sessionPath: raw.sessionPath,
    ownerOpenId: typeof raw.ownerOpenId === "string" ? raw.ownerOpenId : undefined,
    chatId: typeof raw.chatId === "string" ? raw.chatId : undefined,
  };
}

export function isAuthorizedCardAction(
  value: { ownerOpenId?: string; chatId?: string },
  action: { operatorOpenId: string; chatId?: string },
) {
  return Boolean(
    value.ownerOpenId &&
    value.chatId &&
    value.ownerOpenId === action.operatorOpenId &&
    value.chatId === action.chatId,
  );
}

function escapeMarkdown(text: string) {
  return text.replace(/[`*_~]/g, "\\$&");
}

function sharedCardConfig() {
  return {
    wide_screen_mode: true,
    update_multi: true,
  };
}
