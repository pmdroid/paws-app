export function delegationHasOpenWork(epicIdSql: string): string {
  return `EXISTS (SELECT 1 FROM work_item open_delegation WHERE open_delegation.delegation_id = ${epicIdSql} AND open_delegation.state NOT IN ('completed', 'merged', 'cancelled'))`;
}

export function delegationIssueIdSql(item: string): string {
  const briefIssue = `json_extract(${item}.brief, '$.epic.issueId')`;
  return `CASE WHEN ${briefIssue} IS NOT NULL AND ${briefIssue} <> ${item}.linear_issue_id THEN ${briefIssue} ELSE ${item}.linear_issue_id END`;
}

export function parentIssueIdSql(item: string): string {
  const projectIssue = `(SELECT parent_approval.project_id FROM project_approval parent_approval WHERE parent_approval.id = ${item}.project_approval_id AND parent_approval.source = 'parent' AND parent_approval.stopped_at IS NULL AND parent_approval.project_id <> ${item}.linear_issue_id)`;
  return `COALESCE(${projectIssue}, ${delegationIssueIdSql(item)})`;
}

export function parentTaskKeySql(item: string): string {
  const marker = `':item:' || ${item}.linear_issue_id`;
  return `CASE WHEN ${item}.task_key IS NOT NULL AND instr(${item}.task_key, ${marker}) > 1 THEN substr(${item}.task_key, 1, instr(${item}.task_key, ${marker}) - 1) ELSE ${item}.task_key END`;
}
