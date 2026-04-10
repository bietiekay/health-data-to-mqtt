# Spec Story: Local Configuration Support

Date: 2026-04-10

## Conversation Summary

The user asked to support a configuration file in addition to environment variables. The requested behavior was:

- users should be able to copy and adjust an example configuration template,
- the file should be passable as a parameter,
- Docker should clearly document how configuration is provided,
- Docker should prefer environment variables,
- the configuration file should only be used for plain local npm starts.

The implementation added a commented YAML template at `config/app.config.example.yaml`, support for `--config` and `-c` in the local server entrypoint, and YAML config loading in `src/config.ts`. Environment variables intentionally override values from the YAML file.

The user then asked how to make local development config automatic when running npm. A `start:local` npm script was added, using `config/app.config.local.yaml`, and that local file path was added to `.gitignore`.

The user then asked to document this behavior. The README was expanded with a short local development guide, example YAML values, and a clear distinction between local YAML config and Docker environment variable configuration.

The changelog and test matrix were updated under version `0.1.0`.

## Validation Performed

- Ran `npm run typecheck`.
- Ran `npm test`.
- Ran `npm run build`.
- Verified `npm run start:local` starts with a copied local config file.
- Verified `npm start` starts with environment/default configuration.

## Notes

- Docker and Docker Compose remain environment-variable based.
- `config/app.config.local.yaml` is ignored by Git and should not be committed.
- Local environment variables override YAML values when both are present.
