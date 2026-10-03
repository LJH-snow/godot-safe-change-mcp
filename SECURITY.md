# Security Policy

## Supported versions

Security fixes target the latest published release and the current default branch.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, private project paths, or proof-of-concept payloads.

Use the repository's GitHub Security tab and choose **Report a vulnerability** when private advisories are available. If that channel is unavailable, contact the repository owner privately through GitHub and include:

- affected version or commit;
- Godot and Node.js versions;
- a minimal reproduction without secrets;
- impact and required conditions;
- any suggested mitigation.

Please allow time for triage before public disclosure. We will keep the report private while a fix and regression test are prepared.

## Safety boundaries

This project intentionally does not provide arbitrary GDScript execution, shell execution, Python workers, arbitrary Godot RPC, or unrestricted filesystem writes. Reports that demonstrate a way to bypass preview, confirmation, revision, lease, or rollback guards are security-sensitive.
