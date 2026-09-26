/**
 * The rule files of a repository a tool has just checked out (CLAUDE.md,
 * AGENTS.md, .cursor/rules, …), for the tool's answer.
 *
 * A run's model nodes receive the rule files of the working tree they START in
 * (@zibby/agent-workflow repository-rules, rendered by invokeAgent). A
 * repository cloned DURING a node is not there yet at that moment, so the clone
 * tool hands its rules back in its own answer — the same collector and the same
 * rendering, whatever vendor reads the answer.
 *
 * A namespace import on purpose: an engine installed beside this skill that
 * predates the collector simply yields '' instead of failing the clone.
 */
export async function checkedOutRepositoryRules(dir: string): Promise<string> {
  try {
    const engine: any = await import('@zibby/agent-workflow');
    if (typeof engine.collectRepositoryRules !== 'function' || typeof engine.renderRepositoryRules !== 'function') return '';
    return engine.renderRepositoryRules(engine.collectRepositoryRules([{ dir, declared: true }])) || '';
  } catch {
    return '';
  }
}

/** The answer's field, present only when the repository carries rule files. */
export async function repositoryRulesField(dir: string): Promise<{ repositoryRules?: string }> {
  const rules = await checkedOutRepositoryRules(dir);
  return rules ? { repositoryRules: rules } : {};
}
