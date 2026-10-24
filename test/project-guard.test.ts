import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectFixture } from "./local/project-fixture";

test("restart without project configuration refuses persisted approvals and keeps ordinary work available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paws-project-disabled-"));
  const filename = join(directory, "paws.db");
  const f = createProjectFixture(filename);
  let closed = false;
  try {
    f.tracker.deps.delete("two");
    const approval = await f.projects.preview(f.actor, f.selection, AbortSignal.timeout(10_000));
    await f.projects.approve(
      f.actor,
      approval.id,
      approval.generation,
      AbortSignal.timeout(10_000),
    );
    f.projects.register(f.jobs);
    await f.jobs.tick();
    await f.projects.control(f.actor, approval.id, "pause");
    await f.close();
    closed = true;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {createProjectFixture} from './test/local/project-fixture.ts';
import {createProjectExecutionGuard} from './src/project-execution';
import {ensureLinearSession,insertQueuedItem,bindLinearSessionTask} from './src/db';
import {startPaws} from './src/index';
import {Orchestrator} from './src/loop';
import {dirname} from 'node:path';
const f=createProjectFixture(process.argv[1]);
const guard=createProjectExecutionGuard(f.db,()=>null);
const approval=f.projects.list('workspace')[0];
const claim=f.projects.progress(approval.id)[0];
const snapshot=await f.tracker.loadEpic(claim.issueId);
ensureLinearSession(f.db,{sessionId:'duplicate',issueId:claim.issueId,organizationId:'org'});
let scopeDenied=false;
let actorDenied=false;
try {await guard.scopeSnapshot(claim.sessionId,snapshot);}catch{scopeDenied=true;}
try {guard.actor(claim.sessionId);}catch{actorDenied=true;}
const observed={dispatch:guard.canDispatch(claim.epicId),intake:guard.authorizeIntake(claim.sessionId,snapshot),duplicate:guard.authorizeIntake('duplicate',snapshot),scopeDenied,actorDenied,ordinary:guard.canDispatch('ordinary')&&guard.authorizeIntake('ordinary',snapshot),items:f.db.query('SELECT id FROM work_item').all().length};
await f.close();
let runtime;
const register=Orchestrator.prototype.register;
Orchestrator.prototype.register=function(){runtime=this;return register.call(this)};
const paws=startPaws({PAWS_HOME:dirname(process.argv[1]),PAWS_PORT:'0',PAWS_HOST:'127.0.0.1'});
try {
  await paws.ready;
  const item=insertQueuedItem(paws.db,{id:'ordinary',now:Date.now(),sessionKey:'ordinary'});
  ensureLinearSession(paws.db,{sessionId:'ordinary',issueId:item.linearIssueId,organizationId:'org'});
  bindLinearSessionTask(paws.db,'ordinary',item.delegationId,{actorId:'lead'});
  paws.db.run("UPDATE work_item SET state='merge_queue' WHERE id=?",[item.id]);
  runtime.repositoryForItem=()=>({owner:'owner',repo:'repo',remoteUrl:'https://example.test/repo'});
  runtime.githubForRepository=()=>({});
  let mergeFailure='';
  try {await runtime.merge({itemId:item.id},'proof')}catch(error){mergeFailure=error.message}
  console.log(JSON.stringify({...observed,mergeFailure,composedHold:runtime.options.admission.canDispatchDelegation(claim.epicId)}));
}finally{
  Orchestrator.prototype.register=register;
  await paws.stop();
}`,
        filename,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({
      dispatch: false,
      intake: false,
      duplicate: false,
      scopeDenied: true,
      actorDenied: true,
      ordinary: true,
      items: 2,
      mergeFailure: "Linear execution changes are still being reconciled",
      composedHold: false,
    });
  } finally {
    if (!closed) await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
