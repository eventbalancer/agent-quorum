import { RUNNER_META } from '../providers/registry.js';
import type { OperatorConfig } from './config.js';

const TOOL_DISALLOWED = [
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'Agent',
  'Task',
  'ToolSearch',
  'AskUserQuestion',
];

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

// Canonical non-secret defaults so the store is optional and resolution never
// touches the package root. A mirror test keeps these in sync with agent-quorum.example.json.
export const DEFAULT_CONFIG: OperatorConfig = {
  version: 1,
  settings: {
    iters: 5,
    effort: 'high',
    fix: true,
    translate: false,
    locale: '',
    diffThreshold: 5,
    retryCount: 3,
    retryDelaySeconds: 10,
  },
  roles: {
    critic: {
      runner: 'codex',
      model: 'gpt-5.5',
      reasoning: 'xhigh',
      tools: READ_TOOLS,
      disallowedTools: TOOL_DISALLOWED,
    },
    creator: {
      runner: 'claude',
      model: 'claude-opus-4-8',
      reasoning: 'xhigh',
      createTools: READ_TOOLS,
      createDisallowedTools: TOOL_DISALLOWED,
      updateTools: ['Read'],
      updateDisallowedTools: TOOL_DISALLOWED,
    },
    fixer: {
      runner: 'codex',
      model: 'gpt-5.5',
      reasoning: 'high',
      tools: READ_TOOLS,
      disallowedTools: TOOL_DISALLOWED,
    },
    reviewer: {
      runner: 'codex',
      model: 'gpt-5.5',
      reasoning: 'high',
      tools: READ_TOOLS,
      disallowedTools: TOOL_DISALLOWED,
    },
    translator: {
      runner: 'codex',
      model: 'gpt-5.5',
      reasoning: 'high',
      tools: READ_TOOLS,
      disallowedTools: TOOL_DISALLOWED,
    },
  },
  knobs: {
    claude: {
      stallTimeoutSeconds: 600,
      stallPollSeconds: 5,
      stallInterruptGraceSeconds: 20,
      callTimeoutSeconds: 1800,
      semanticIdleTimeoutSeconds: 900,
    },
    cursor: {
      stallTimeoutSeconds: 600,
      stallPollSeconds: 5,
      stallInterruptGraceSeconds: 20,
      callTimeoutSeconds: 1800,
      semanticIdleTimeoutSeconds: 900,
    },
    fixPass: { timeoutSeconds: 900, semanticIdleTimeoutSeconds: 900, retryCount: 1 },
    translatePass: { timeoutSeconds: 900, semanticIdleTimeoutSeconds: 900, retryCount: 1 },
  },
  split: { mode: 'auto', minPhases: 5 },
  retention: { keepCount: 50, maxAgeDays: 30 },
  telegram: {
    chatId: '',
    clarify: 'auto',
    clarifyDeadlineSeconds: 86400,
    pollTimeoutSeconds: 50,
    httpTimeoutSeconds: 70,
    receiveFailureWindowSeconds: 120,
    receiveBackoffSeconds: 2,
  },
  providers: {
    livenessHeartbeatSeconds: 30,
    claudeThinkingEvery: 3,
    cursorBin: RUNNER_META.cursor.binary.default,
    providerDiagnostics: false,
  },
  status: { maxPlanLines: 900 },
  claudePermissionMode: 'default',
};
