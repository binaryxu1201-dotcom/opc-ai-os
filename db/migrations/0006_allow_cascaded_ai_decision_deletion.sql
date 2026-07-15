DROP TRIGGER IF EXISTS "ai_suggestion_decision_append_only" ON "ai_suggestion_decision";--> statement-breakpoint
CREATE TRIGGER "ai_suggestion_decision_append_only" BEFORE UPDATE OR DELETE ON "ai_suggestion_decision" FOR EACH ROW WHEN (pg_trigger_depth() = 1) EXECUTE FUNCTION "reject_ai_suggestion_decision_mutation"();
