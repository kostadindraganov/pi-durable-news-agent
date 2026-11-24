ALTER TABLE cards ADD COLUMN read_at TEXT;
ALTER TABLE cards ADD COLUMN read_removed INTEGER NOT NULL DEFAULT 0 CHECK (read_removed IN (0, 1));

UPDATE cards SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE read = 1;

CREATE INDEX cards_read_retention ON cards(read_at)
WHERE kind = 'news' AND read = 1 AND read_removed = 0;
