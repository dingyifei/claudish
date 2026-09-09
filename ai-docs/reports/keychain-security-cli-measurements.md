# `security(1)` measurements behind the Keychain backend

Evidence for [`../architecture/keychain.md`](../architecture/keychain.md). Captured 2026-08-22 on
darwin 25.6.0, Bun 1.3.10, against a 441-item login keychain and (from §5 onward) throwaway
keychains created with `security create-keychain`.

Tracked deliberately: the raw probe scripts lived in `ai-docs/sessions/`, which is gitignored and
does not survive `git worktree remove`. The transcripts that decide the design are reproduced here.

---

## 1. Latency — the measurement the architecture is built on

```
find-generic-password -s <svc> -a <acct> -w   ×20 sequential   →  17.4 ms per call
dump-keychain            (no -d, 441 items, 312 130 bytes)     →  28   ms total, exit 0, no prompt
```

A per-variable read cannot sit on a synchronous path: 25 providers × 17.4 ms ≈ 435 ms against a
provider-registration pass measured at ~1.5–2 ms. Enumeration answers for every provider in ONE
spawn, so **presence comes from `dump-keychain`, values from targeted reads**.

`dump-keychain` without `-d` reads item ATTRIBUTES only, never item DATA — which is why it is
prompt-free while a value read is not, and why it cannot be used to fetch values.

Parsing target (a real block, service and account verbatim):

```
keychain: "/Users/jack/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="claudish: GEMINI_API_KEY"
    "acct"<blob>="GEMINI_API_KEY"
    "desc"<blob>="application password"
    "icmt"<blob>="Stored by claudish"
    "svce"<blob>="claudish"
```

---

## 2. Exit codes

| Condition | exit |
|---|---|
| `find-generic-password -w` hit | 0, stdout = value + exactly one `\n` |
| `find-generic-password -w` miss | **44** |
| `delete-generic-password` present | 0 |
| `delete-generic-password` absent | **44** |
| `add-generic-password` without `-U`, item exists | **45** (`returned -25299`) |
| `security -i` unknown subcommand | 1 |

Miss stderr, verbatim:

```
security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.
```

44 is therefore "genuinely absent", distinguishable from a real failure. `-w` appends exactly one
newline — strip ONE, never `.trim()`, or whitespace that is genuinely part of a secret is eaten.

---

## 3. `-w` returns HEX for values containing control characters

Written via `-X` (hex), then read back with `-w`:

```
value written : 'sk-line1\nline2 "q" \ end\ttab'
-w returns    : "736b2d6c696e65310a6c696e653220227122205c20656e6409746162\n"   ← HEX
```

```
value written : 'sk-or-v1-abcdef0123456789'
-w returns    : "sk-or-v1-abcdef0123456789\n"                                  ← RAW
```

Nothing in the output distinguishes the two, and a printable key that happens to be all hex digits
is genuinely ambiguous. Unresolvable at read time → **control characters are refused at write
time**, which makes every stored value unambiguous by construction.

---

## 4. The documented "secure" write mode stores an EMPTY value and exits 0

The man page says to pass `-w` last so `security` prompts for the value. Measured:

```
$ security add-generic-password -s SVC -a B_KEY -U -w      (stdin: "sk-bbb\n")
exit=0
stderr="password data for new item: retype password for new item: passwords don't match\n…"

$ security find-generic-password -s SVC -a B_KEY -w
exit=0  value=""            ← item created, EMPTY
```

It demands the value twice, a single piped line fails the confirmation, and it reports success
having stored nothing. **Disqualified.**

`security -i` (command on stdin) instead — secret stays out of argv, and failures surface:

```
A1 fresh write                    : exit=0
A2 duplicate (no -U, MUST fail)   : exit=45   ← failure IS reported
A3 garbage subcommand             : exit=1
A4 value after the failed write   : "sk-aaa"  ← unchanged, not clobbered
```

---

## 5. `execFileSync(..., {input})` HANGS when stdin is raw-mode

Only reproducible inside a real TUI. Same code, three stdin states:

```
=== 1. normal stdin ===
normal: OK

=== 2. stdin in RAW MODE (what the TUI does) ===
raw-mode: FAILED status=null signal="SIGTERM" code="ETIMEDOUT"
   stdout="" stderr="" message="spawnSync /usr/bin/security ETIMEDOUT"

=== 3. stdin resumed + data listener ===
listening: FAILED status=null signal="SIGTERM" code="ETIMEDOUT"
```

Because it is synchronous, it froze the entire config TUI for the full timeout first. Two
candidate replacements, both measured under raw mode WITH a data listener attached:

```
A. Bun.spawnSync (stdin: Uint8Array) : exit=0  (30ms)  read back "sk-fix-value-4242"
B. async execFile + stdin.end()      : exit=0  (26ms)  read back "sk-fix-value-4242"
```

**A was chosen** — it keeps the engine synchronous, which the sync presence path depends on.

Related trap: `exitCode` is `null` for a signal-killed process. Collapsing that to `1` reported a
ten-second timeout as "security exited 1", a fabricated exit code that misdirects the next
investigation. Report the signal instead.

**A mechanical port drops guards silently.** `execFileSync` carried `timeout: 10_000`; the first
`Bun.spawnSync` version did not, which would let a LOCKED keychain — where `security` blocks on an
unlock dialog no proxy or MCP child can answer — hang the process forever, since `syncRun` blocks
the event loop outright. `Bun.spawnSync` does honour `timeout`, verified directly:

```
Bun.spawnSync(["/bin/sleep","5"], { timeout: 1000 })
  → elapsed=1002ms  exitCode=null  signal="SIGTERM"      TIMEOUT HONOURED
```

The guard is restored as `SPAWN_TIMEOUT_MS`, and a timeout now surfaces through `normalizeResult`
as a named signal kill rather than an invented exit code.

---

## 6. `security -i` does NOT echo the command (no secret leak via stderr)

`writeKeychainSecret` splices `res.stderr` into its error message, which reaches the TUI status
line and the CLI. If `security` echoed the failing command, the `-X <hex>` secret would leak
through all of them. Probed with a canary:

```
canary : sk-CANARY-SECRET-VALUE-9999
as hex : 736b2d43414e4152592d5345435245542d56414c55452d39393939

duplicate write without -U → exit=45, stderr (227 bytes):
  "security: SecKeychainItemCreateFromContent (<keychain path>): The specified item already
   exists in the keychain.\nadd-generic-password: returned -25299\n"

malformed command          → exit=2, stderr = the usage text (1395 bytes)

HEX of secret present?       no
PLAINTEXT secret present?    no
```

**Note on a false alarm:** an earlier reading of this stderr TRUNCATED to 110 characters ended in
a dangling `add`, which read as a command echo. It was `add-generic-password: returned -25299`
cut mid-word. Truncating diagnostic output during a security review invents findings as readily
as it hides them.

---

## 7. Incident: never verify against the real login keychain

While developing this module, end-to-end verification ran against the real login keychain. The
§5 hang meant several `security` processes were **killed by SIGTERM mid-transaction**, and macOS
restarted `securityd`:

```
root  72167  /usr/sbin/securityd -i     uptime 08:25    ← restarted mid-session
root    429  /usr/libexec/securityd_system  uptime 2 days   ← untouched
```

A `securityd` restart drops the authenticated keychain session of EVERY running application, so
the whole machine began demanding re-authorization app by app. The developer had to reboot.

Verified afterwards that **nothing was lost and no ACL was altered**:

| Check | Result |
|---|---|
| default keychain | `login.keychain-db` — correct |
| search list | `login` + `System` — normal |
| lock state | unlocked (`no-timeout`), not re-locking |
| data read on an unrelated item (`gemini`/`antigravity`) | succeeded, **no prompt** |
| claudish items remaining after cleanup | 0 |

Remedy for a user in that state: reboot or log out/in re-establishes every app's connection in one
go; when prompted, **"Always Allow"** persists, "Allow" is single-use and re-prompts forever.

**The fix is a safe target, not care.** `CLAUDISH_KEYCHAIN_FILE` redirects every `security`
invocation to a keychain created by `security create-keychain`, which is NOT added to the search
list. Assert the redirection is live before the first write, and assert zero leaked items after.
