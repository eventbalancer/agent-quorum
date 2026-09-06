import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DISABLED_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_snapshot',
  'skill_mcp_dependency_install',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'workspace_dependencies',
] as const;

export interface SupervisedCodexInspectionPolicy {
  readonly codexPermissionProfile: 'agent-quorum-delivery';
  readonly codexConfig: readonly string[];
}

export interface SupervisedCodexPolicy extends SupervisedCodexInspectionPolicy {
  readonly isolatedUserConfig: true;
}

function supervisedPolicy(
  cwd: string,
  forbiddenPaths: readonly string[],
  disabledMcpServers: readonly string[],
  materializeMcpTransport: boolean,
): SupervisedCodexInspectionPolicy {
  if (!path.isAbsolute(cwd) || forbiddenPaths.some((value) => !path.isAbsolute(value))) {
    throw new TypeError('supervised Codex filesystem rules require absolute paths');
  }
  const candidate = realpathSync(cwd);
  const denied = [
    ...new Set([
      path.join(candidate, '.git'),
      path.join(candidate, '.codex'),
      path.join(candidate, '.npmrc'),
      ...forbiddenPaths.map((value) => path.resolve(value)),
    ]),
  ];
  const filesystem = [
    '":minimal"="read"',
    `${JSON.stringify(candidate)}="read"`,
    ...denied.map((value) => `${JSON.stringify(value)}="deny"`),
  ].join(',');
  return {
    codexPermissionProfile: 'agent-quorum-delivery',
    codexConfig: [
      'default_permissions="agent-quorum-delivery"',
      `permissions={agent-quorum-delivery={filesystem={${filesystem}},network={enabled=false}}}`,
      `projects={${JSON.stringify(candidate)}={trust_level="untrusted"}}`,
      'approval_policy="never"',
      'allow_login_shell=false',
      'web_search="disabled"',
      'shell_environment_policy.inherit="none"',
      ...(disabledMcpServers.length === 0
        ? []
        : [
            `mcp_servers={${[...new Set(disabledMcpServers)]
              .map(
                (name) =>
                  `${JSON.stringify(name)}={enabled=false${materializeMcpTransport ? ',command="/usr/bin/false"' : ''}}`,
              )
              .join(',')}}`,
          ]),
      ...DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
    ],
  };
}

export function supervisedCodexPolicy(
  cwd: string,
  forbiddenPaths: readonly string[] = [],
  disabledMcpServers: readonly string[] = [],
): SupervisedCodexPolicy {
  // Codex validates disabled transports even when --ignore-user-config omits their definitions.
  return {
    ...supervisedPolicy(cwd, forbiddenPaths, disabledMcpServers, true),
    isolatedUserConfig: true,
  };
}

export function supervisedCodexInspectionPolicy(
  cwd: string,
  forbiddenPaths: readonly string[] = [],
  disabledMcpServers: readonly string[] = [],
): SupervisedCodexInspectionPolicy {
  return supervisedPolicy(cwd, forbiddenPaths, disabledMcpServers, false);
}

export function codexSandboxProbeArgs(
  policy: SupervisedCodexInspectionPolicy,
  command: readonly string[],
): string[] {
  if (command.length === 0) {
    throw new TypeError('Codex sandbox probe requires a command');
  }
  return [
    'sandbox',
    '--include-managed-config',
    '-P',
    policy.codexPermissionProfile,
    ...policy.codexConfig.flatMap((entry) => ['-c', entry]),
    '--',
    ...command,
  ];
}

export function supervisedCodexEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'HOME',
    'CODEX_HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]) {
    if (ambient[name] !== undefined) {
      env[name] = ambient[name];
    }
  }
  env.HOME ??= os.homedir();
  env.PATH = [
    path.join(os.homedir(), '.local/bin'),
    path.dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(path.delimiter);
  return env;
}
