-- Spatial index for public change geometry (requires PostGIS).
-- Exact area matching (radius, corridors, exclusions) runs in application code shared with the tests;
-- PostGIS prefilters candidates by distance so large datasets stay fast.
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE change_events ADD COLUMN geom geometry(Geometry, 4326);
CREATE INDEX change_events_geom_idx ON change_events USING gist (geom);

CREATE OR REPLACE FUNCTION change_events_set_geom() RETURNS trigger AS $$
BEGIN
  IF NEW.data ? 'geom' AND jsonb_typeof(NEW.data->'geom') = 'object' THEN
    NEW.geom := ST_SetSRID(ST_GeomFromGeoJSON((NEW.data->'geom')::text), 4326);
  ELSE
    NEW.geom := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER change_events_geom_trg
  BEFORE INSERT OR UPDATE OF data ON change_events
  FOR EACH ROW EXECUTE FUNCTION change_events_set_geom();
