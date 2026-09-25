INSERT INTO image_moderation.policies (id, name, description, thresholds, is_default)
VALUES
  ('default', 'Default',
   'Rejects confident explicit content, sends borderline scores to a human reviewer.',
   '{"porn":   {"review": 0.35, "reject": 0.80},
     "hentai": {"review": 0.35, "reject": 0.80},
     "sexy":   {"review": 0.50, "reject": 0.92}}'::jsonb,
   true),
  ('strict-demo', 'Strict (demo)',
   'Demo policy with the review threshold for "sexy" lowered to 0, so every upload that is not rejected lands in the reviewer queue.',
   '{"porn":   {"review": 0.05, "reject": 0.60},
     "hentai": {"review": 0.05, "reject": 0.60},
     "sexy":   {"review": 0.00, "reject": 0.80}}'::jsonb,
   false)
ON CONFLICT (id) DO NOTHING;
