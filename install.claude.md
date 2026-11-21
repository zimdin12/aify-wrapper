# Install the Claude launcher from source

```bash
./install.sh --client claude --endpoint http://127.0.0.1:8800
```

The first source install fetches the pinned aify-env dependency into this checkout's `node_modules`.
Re-running with the same revision does not call npm. On Windows use Git Bash. See the
[installer guide](README.md#install) for the destination and prerequisites.
