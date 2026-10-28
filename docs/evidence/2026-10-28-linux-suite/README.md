# The whole suite on Linux and Windows, 2026-10-28

Commit under test: a8d0af8 (the Linux pass, b9cbb63, and the zombie probe fix, a8d0af8, on 6d81e88).

| Host | Tests | Pass | Fail | Skipped | Exit |
|---|---|---|---|---|---|
| Linux: node:22-bookworm container, node v22.23.4, user `node` | 1250 | 1215 | 0 | 35 | 0 |
| Windows 11, this host, Git Bash | 1250 | 1184 | 0 | 66 | 0 |

Every Windows skip names a platform reason: shell-script stubs Windows cannot spawn by path (62), symlink
privilege (2), unix sockets (1), the real /proc (1).

## Reproduce

Linux, from a checkout of the commit (MSYS_NO_PATHCONV=1 under Git Bash):

```sh
docker run --rm --user node -v <checkout>:/src:ro -v <aify-comms checkout>:/comms:ro -e AIFY_COMMS_REPO=/comms \
  node:22-bookworm bash -c 'mkdir /tmp/work && cd /src && tar --exclude=.git -cf - . | (cd /tmp/work && tar -xf -) && cd /tmp/work && npm test'
```

The container has no init, so PID 1 reaps nothing. Before a8d0af8 the two real-process lease tests waited forever
on a stopped runtime that was only a zombie: they failed 2 of 3 without `--init` and passed 3 of 3 with it.

Windows: `npm test` with AIFY_ENV_REPO, AIFY_WRAPPER_REPO and AIFY_COMMS_REPO set, and with AIFY_AGENT_ID,
AIFY_AGENT_LEASE, AIFY_ENV_INSTANCE and AIFY_LIFETIME unset.

## Not settled

The first Windows run of a8d0af8 failed one file, hermes-delivery-endpoint-is-the-launchers.test.js. It exited 1
after 22 s and reported none of its subtests. Other suites were running on the host at the time. The file passed
2 of 2 alone, twice, and the full rerun above passed it. Neither the file nor its fixture changed on this branch.
The cause is not known.
