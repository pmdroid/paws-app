export function delegationHasOpenWork(delegationIdSql: string): string {
  return `EXISTS (SELECT 1 FROM work_item open_delegation WHERE open_delegation.delegation_id = ${delegationIdSql} AND open_delegation.state NOT IN ('completed', 'merged', 'cancelled'))`;
}

export function delegationIssueIdSql(item: string): string {
  const briefIssue = `json_extract(${item}.brief, '$.epic.issueId')`;
  return `CASE WHEN ${briefIssue} IS NOT NULL AND ${briefIssue} <> ${item}.linear_issue_id THEN ${briefIssue} ELSE ${item}.linear_issue_id END`;
}

export function parentIssueIdSql(item: string): string {
  const projectIssue = `(SELECT parent.parent_issue_id FROM parent_delegation_issue sub JOIN parent_delegation parent ON parent.delegation_id = sub.parent_delegation_id WHERE sub.delegation_id = ${item}.delegation_id AND parent.stopped_at IS NULL AND parent.parent_issue_id <> ${item}.linear_issue_id)`;
  return `COALESCE(${projectIssue}, ${delegationIssueIdSql(item)})`;
}

export function parentTaskKeySql(item: string): string {
  const marker = `':item:' || ${item}.linear_issue_id`;
  return `CASE WHEN ${item}.task_key IS NOT NULL AND instr(${item}.task_key, ${marker}) > 1 THEN substr(${item}.task_key, 1, instr(${item}.task_key, ${marker}) - 1) ELSE ${item}.task_key END`;
}
