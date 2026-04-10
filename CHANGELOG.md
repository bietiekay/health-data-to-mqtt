# Changelog

All notable changes to this project will be documented in this file.

Version headers must match the `version` field in `package.json`.

## 0.1.0

### Added

- Added the initial Node.js + TypeScript Fastify server scaffold.
- Added HealthSave-compatible health, batch, and status endpoints.
- Added reference-compatible optional API-key behavior.
- Added in-memory status counters for the initial compatibility scaffold.
- Added Dockerfile and Docker Compose self-hosting setup with Mosquitto.
- Added commented default environment templates.
- Added a commented local YAML configuration file template for plain `npm start` runs.
- Added local config file loading with environment variable override behavior.
- Added `npm run start:local` for local development config files.
- Fixed npm start scripts to use the built server entrypoint.
- Expanded README guidance for local development configuration.
- Removed manual SpecStory requirements from agent commit instructions.
- Documented that external tooling manages `.specstory/` and generated changes may be committed.
- Added initial MQTT topic rendering helper.
- Added raw MQTT publishing for non-empty HealthSave batch samples.
- Added reference-compatible datapoint extraction for dedicated metrics, generic quantities, activity summaries, sleep sessions, and workouts.
- Added blood oxygen normalization aliases for HealthKit-style saturation fields.
- Added workout active-energy normalization and current values using `activeEnergy`, `activeEnergyBurned`, or `calories`.
- Added sleep awake-state current values from the latest sleep stage.
- Added normalized MQTT publishing for accepted datapoints.
- Added scalar current MQTT topics for datapoints with one primary value.
- Added multi-client contexts with configurable URL prefixes, per-context MQTT topics, and isolated status counters.
- Added JSON wrapper deserialization for encoded batch and sample data.
- Added batch-level debug logging for incoming body keys, metrics, sample keys, counter routing, and MQTT publish counts.
- Added `502` handling for MQTT publish failures so failed batches are not counted as accepted.
- Added accepted-sample status counting for non-empty batches that do not produce normalized records.
- Added optional raw batch NDJSON storage with per-context monthly files for replay/readout use cases.
- Added file-backed local status counter state under the configured data path.
- Added configurable HTTP body limits with a 500 MiB default for large HealthSave sync batches.
- Added unit and API integration tests.
- Added test strategy and test matrix documentation.
- Documented the upstream Health Data Hub reference project and required HealthSave iOS client.
