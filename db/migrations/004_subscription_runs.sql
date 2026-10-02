-- Weekly subscription runs create reports without a website draft.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_draft_id_fkey;
