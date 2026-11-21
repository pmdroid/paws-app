CREATE TABLE "linear_project_team" (
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"seen_at" bigint NOT NULL,
	CONSTRAINT "linear_project_team_workspace_id_project_id_team_id_pk" PRIMARY KEY("workspace_id","project_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "linear_project_team" ADD CONSTRAINT "linear_project_team_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;