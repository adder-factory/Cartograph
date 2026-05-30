-- SQL test bed

CREATE TABLE box (
    id INTEGER PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE container (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE INDEX idx_box_value ON box(value);

CREATE OR REPLACE FUNCTION process(input_value TEXT)
RETURNS INTEGER AS $$
BEGIN
    INSERT INTO box (value) VALUES (input_value);
    RETURN currval('box_id_seq');
END;
$$ LANGUAGE plpgsql;

SELECT b.value FROM box b JOIN container c ON b.id = c.id;
