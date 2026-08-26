export const EXECUTION_OPT_IN_FLAG = 'CLAUDEOS_ENABLE_EXECUTION';
export const LOCAL_VIEWER_SOURCES = Object.freeze(['.claude', '.codex']);

export function isExecutionEnabled(env = process.env) {
  return env?.[EXECUTION_OPT_IN_FLAG] === '1';
}
