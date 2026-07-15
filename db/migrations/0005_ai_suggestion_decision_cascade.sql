ALTER TABLE "ai_suggestion_decision" DROP CONSTRAINT "ai_suggestion_decision_suggestion_id_ai_suggestion_id_fk";--> statement-breakpoint
ALTER TABLE "ai_suggestion_decision" ADD CONSTRAINT "ai_suggestion_decision_suggestion_id_ai_suggestion_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."ai_suggestion"("id") ON DELETE cascade ON UPDATE no action;
