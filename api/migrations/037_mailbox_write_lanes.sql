-- One installation per database. Hyperdrive supports transaction row locks, not advisory locks.
-- Ingest takes its lane first, address creation only on a miss, and publication last.
CREATE TABLE mailbox_write_lanes (lane text PRIMARY KEY CHECK (lane IN ('address', 'ingest', 'events')));
INSERT INTO mailbox_write_lanes (lane) VALUES ('address'), ('ingest'), ('events');
