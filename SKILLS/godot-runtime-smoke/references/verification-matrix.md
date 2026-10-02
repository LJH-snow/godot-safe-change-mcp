# Godot Runtime Verification Matrix

The project records the following end-to-end surfaces. A feature that changes
one surface should extend the corresponding real fixture assertion and the
contract or application test that guards its rejection paths.

| Surface | Minimum assertion |
| --- | --- |
| Context and search | Connected editor, current scene, full safe node tree, and scene/script/resource/node matches |
| Scene mutation | Preview/confirm/apply through UndoRedo, changed property or node, changed revision, guarded rollback |
| Script and resource mutation | Exact diff or reference match, file revision, atomic apply, user-edit conflict, restored rollback |
| Input actions | Unique physical key validation, ProjectSettings revision, persisted action snapshot, complete rollback |
| Run current or specified scene | Run ID, valid scene path, eventual stopped or failed state, fixture output, warnings/errors |
| Diagnostics and repair | Source/line/NodePath association, bounded repair hint preview, explicit confirmation before apply |
| Task orchestration | Lease-held apply, pause/resume/cancel, restart recovery, interrupted operation ID, filtered timeline |
| Task verification | verify_scene_state observed values and verify_diagnostics counts with structured mismatch evidence |
| Package or CI integration | Both supported Godot versions, bounded process cleanup, versioned logs/artifacts |

The CI workflow currently installs the Linux editor versions 4.5.1 and 4.7.2,
wraps the smoke in xvfb-run, and enforces an eight-minute job and a three-minute
smoke timeout. Keep those limits explicit if the matrix changes.
