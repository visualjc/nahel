#!/usr/bin/env bash
# with-timeout.sh — bounded child processes, portably. Source, don't run.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/with-timeout.sh"
#   with_timeout <seconds> <cmd> [args...]
#
# Contract:
#   - <cmd> runs with stdin/stdout/stderr inherited and argv passed verbatim
#   - <cmd> gets its own process group, so the whole tree is signalled and no
#     descendant outlives the timeout
#   - exits with <cmd>'s own status when it finishes inside <seconds>
#   - exits 124 when <seconds> elapses first: the group gets TERM, then KILL
#     $WITH_TIMEOUT_KILL_AFTER seconds later, so a child that traps or ignores
#     TERM still hits a hard cap
#   - exits 127 when <cmd> cannot be executed, 125 when perl is missing
#
# Why a perl watchdog rather than GNU `timeout(1)`, even where it is installed:
#   - stock macOS ships no coreutils, so `timeout` is simply absent there
#   - `timeout -k` exits 137 (128+SIGKILL) when the KILL escalation is what
#     ended the command, and 124 only when TERM sufficed. 137 is also what any
#     external SIGKILL produces, so a caller cannot tell a hard-hanging timeout
#     from an OOM kill. Owning the timing is what makes 124 mean one thing.
#   - one code path means identical semantics on every host, and it stays
#     testable anywhere without emulating a coreutils binary we cannot run
# perl ships with macOS and with every Linux distro these scripts target.
#
# Callers branch on 124 to tell "timed out" from "failed" — keep that exact.

# Grace between TERM and KILL. Long enough for a child to flush its output,
# short enough that a wedged process cannot stall the run.
WITH_TIMEOUT_KILL_AFTER=2

with_timeout() {
  local seconds="$1"
  shift

  if ! command -v perl >/dev/null 2>&1; then
    echo "with_timeout: perl not found, cannot bound: $1" >&2
    return 125
  fi

  perl -e '
    use POSIX ();
    my $kill_after = shift @ARGV;
    my $seconds    = shift @ARGV;
    my $pid = fork();
    die "with_timeout: fork failed: $!\n" unless defined $pid;
    if ($pid == 0) {
      # Own process group, so the watchdog can signal the whole tree rather
      # than just this pid — otherwise a grandchild survives the timeout.
      POSIX::setpgid(0, 0);
      # Indirect-object form: never routed through a shell, not even for a
      # single-word command, so argv reaches the child verbatim.
      exec { $ARGV[0] } @ARGV;
      exit 127;
    }
    # Set it from the parent too, so the group exists whichever side wins the
    # race. EACCES once the child has already exec-ed is expected; ignore it.
    POSIX::setpgid($pid, $pid);
    $SIG{ALRM} = sub {
      kill "TERM", -$pid;
      # Poll rather than blind-sleep the grace: a child that honours TERM must
      # not cost every timeout an extra $kill_after seconds.
      my $deadline = time + $kill_after;
      while (time < $deadline) {
        exit 124 if waitpid($pid, POSIX::WNOHANG()) == $pid;
        select undef, undef, undef, 0.05;
      }
      kill "KILL", -$pid;
      waitpid $pid, 0;
      exit 124;
    };
    alarm $seconds;
    waitpid $pid, 0;
    alarm 0;
    my $status = $?;
    exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
  ' "$WITH_TIMEOUT_KILL_AFTER" "$seconds" "$@"
}
