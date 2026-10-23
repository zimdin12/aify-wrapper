# Early fallback (review 1792760217798-b96c0854)

decideRoute returned dev on an unreadable or malformed configuration before devConflict ran, so the installed plugin's server routed plugin kept producing beside dev. The early return now checks the installed plugin (devConflict with no configured servers): refused (none) when it is known to produce, dev otherwise.

## Watched failing on 1c87f62 (new test only)
```
not ok 15 - CR1: an unreadable configuration still never leaves the installed plugin producing beside the development channel
# pass 14
# fail 1
    {"route":"dev","reason":"the project configuration could not be read: EACCES"}
```

## Mutant M15: the early check returns no conflict (restored byte-equal)
```
not ok 15 - CR1: an unreadable configuration still never leaves the installed plugin producing beside the development channel
    {"route":"dev","reason":"the project configuration could not be read: EACCES"}
```

## Full suite on the repair
```
npm exit=0
# tests 990
# pass 924
# fail 0
# skipped 66
```
