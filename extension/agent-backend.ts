import type { TaskStatusSink } from "./task-status-card.js";
import type { FeishuThinkingLevel } from "./types.js";

export type AgentModel = {
  provider: string;
  id: string;
};

export type AgentModelOption = AgentModel;

export type AgentImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type AgentPromptOptions = {
  cwd: string;
  sessionFile?: string;
  model?: AgentModel;
  thinkingLevel?: FeishuThinkingLevel;
  autoCompaction?: boolean;
  text: string;
  images: AgentImage[];
  timeoutMs: number;
  status?: TaskStatusSink;
  onSessionReady?: (sessionId: string) => void;
  onSessionEvent?: (sessionId: string, event: unknown) => void;
};

export type AgentPromptResult = {
  text: string;
  error?: string;
  sessionFile?: string;
};

export type AgentCompactOptions = {
  cwd: string;
  sessionFile?: string;
  instructions?: string;
  autoCompaction?: boolean;
};

/** Backend contract used by the Feishu conversation layer. */
export interface AgentBackend {
  readonly name: string;
  prompt(key: string, options: AgentPromptOptions): Promise<AgentPromptResult>;
  getAvailableModels?(): Promise<AgentModelOption[]>;
  abort(key: string): Promise<boolean>;
  reset(key: string): Promise<void>;
  compact?(key: string, options: AgentCompactOptions): Promise<unknown>;
  availableCommands?(key: string, options: { cwd: string; sessionFile?: string }): Promise<unknown[]>;
  disposeAll(): Promise<void>;
}
