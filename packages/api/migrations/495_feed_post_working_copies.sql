BEGIN;

CREATE TABLE IF NOT EXISTS feed_post_working_copies (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  mutation_id uuid NOT NULL,
  content jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE feed_post_working_copies ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_post_working_copies_member ON feed_post_working_copies
  USING (EXISTS (
    SELECT 1 FROM sessions s
    JOIN assistants a ON a.id = s.assistant_id
    JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
    WHERE s.id = session_id
      AND wm.user_id = current_setting('app.current_user_id', true)::uuid
  ));

COMMIT;
