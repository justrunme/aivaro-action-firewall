-- Migration 002: deterministic seed for Pumpkin Patch Orders demo
-- Fixed row counts: exactly 5 patches, exactly 3 orders.
-- Integration tests assert these exact counts — do not change without updating tests.

INSERT INTO patches (id, name, location, available_count) VALUES
  (1, 'Hollow Creek Farm',   'Willow Lane 12',    80),
  (2, 'Scarecrow Acres',     'Old Mill Road 4',   150),
  (3, 'Harvest Moon Patch',  'Pumpkin Ridge 7',   60),
  (4, 'Cobweb Corner',       'Foggy Bottom 99',   200),
  (5, 'The Gourd Garden',    'Autumn Vale 3',     45)
ON CONFLICT (id) DO NOTHING;

-- Reset sequence so future inserts start after seed rows
SELECT setval('patches_id_seq', 5, true);

INSERT INTO orders (id, patch_id, quantity, created_at) VALUES
  (1, 2, 10, '2026-10-01 09:00:00+00'),
  (2, 1,  5, '2026-10-02 11:30:00+00'),
  (3, 4, 20, '2026-10-03 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

SELECT setval('orders_id_seq', 3, true);
