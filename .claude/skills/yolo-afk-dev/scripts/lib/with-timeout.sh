#!/usr/bin/env bash
# with-timeout.sh — portable stand-in for GNU `timeout(1)`. Source, don't run.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/with-timeout.sh"
#   with_timeout <seconds> <cmd> [args...]
#
# Stock macOS ships no coreutils, so `timeout` is simply absent there and every
# wrapped command dies with 127. This restores the semantics the callers rely
# on, on any host:
#   - <cmd> runs with stdin/stdout/stderr inherited and argv passed verbatim
#   - exits with <cmd>'s own status when it finishes inside <seconds>
#   - exits 124 when <seconds> elapses first (child gets TERM, then KILL)
#   - exits 127 when <cmd> cannot be executed
#
# Real `timeout`/`gtimeout` is used when installed; otherwise a perl watchdog
# (perl ships with macOS and with every Linux distro these scripts target).
#
# Callers branch on 124 to tell "timed out" from "failed" — keep that exact.

with_timeout() {
  local seconds="$1"
  shift

  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    perl -e '
      my $seconds = shift @ARGV;
      my $pid = fork();
      die "with_timeout: fork failed: $!\n" unless defined $pid;
      if ($pid == 0) {
        # Indirect-object form: never routed through a shell, not even for a
        # single-word command, so argv reaches the child verbatim.
        exec { $ARGV[0] } @ARGV;
        exit 127;
      }
      $SIG{ALRM} = sub {
        kill "TERM", $pid;
        sleep 1;
        kill "KILL", $pid;
        exit 124;
      };
      alarm $seconds;
      waitpid $pid, 0;
      alarm 0;
      my $status = $?;
      exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
    ' "$seconds" "$@"
  fi
}
