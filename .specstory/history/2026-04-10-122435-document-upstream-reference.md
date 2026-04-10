# Spec Story: Document Upstream Reference

Date: 2026-04-10

## Conversation Summary

The user asked to update the README with explicit mentions of:

- the original reference project, Health Data Hub, at `https://github.com/umutkeltek/health-data-hub/tree/main`,
- the required iOS client app, HealthSave, at `https://apps.apple.com/app/id6759843047`.

The README was updated to link the HealthSave app and original Health Data Hub project in the introduction and motivation sections. A dedicated "Upstream Reference and Required Client" section was added to clarify that this repository is a porting effort based on Health Data Hub and that HealthSave is the required client app.

`CHANGELOG.md` was updated under the existing `0.1.0` release section because the app version in `package.json` is still `0.1.0`.

## Validation Planned

- Run the full test suite before committing.
- Verify the working tree only contains the intended README, changelog, and specstory changes.
