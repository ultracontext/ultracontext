#!/usr/bin/env bash
# Cross-OS e2e for uc: a hub and two Linux machines in Docker (different users and home dirs,
# ssh transport), optionally plus this host as a third machine over tcp.
#
#   e2e/run.sh              build, run the scenario, tear everything down
#   e2e/run.sh --with-mac   also run the native binary (target/debug/uc) as machine "mac"
#   e2e/run.sh --keep       leave the containers up afterwards (docker compose -p uc-e2e ...)
#   e2e/run.sh --no-build   use the existing uc-e2e:dev image
#
# UC_E2E_MAC_BIN overrides the native binary; UC_E2E_PORT the host port of the hub (7707).
# Exits non-zero on the first failed check, after printing hub/daemon logs.
# shellcheck disable=SC2016 # single-quoted snippets are expanded inside the containers
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
with_mac=0
keep=0
build=1
for arg in "$@"; do
    case "$arg" in
    --with-mac) with_mac=1 ;;
    --keep) keep=1 ;;
    --no-build) build=0 ;;
    -h | --help)
        sed -n '2,12p' "$0"
        exit 0
        ;;
    *)
        echo "unknown flag: $arg" >&2
        exit 2
        ;;
    esac
done

UC_TOKEN=${UC_TOKEN:-e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}
UC_E2E_PORT=${UC_E2E_PORT:-7707}
export UC_TOKEN UC_E2E_PORT
dc() { docker compose -f "$here/docker-compose.yml" "$@"; }

mac_home=""
mac_uc=${UC_E2E_MAC_BIN:-$repo/target/debug/uc}

step() { printf '\n── %s\n' "$*"; }
fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

# Run a shell snippet on a container machine, as its user, in its HOME. Output goes through
# files: a daemon the command spawns must not keep the exec pipe (and this script) hanging.
on() {
    local svc=$1 user=root home=/root
    shift
    if [ "$svc" = linux1 ]; then
        user=fabio
        home=/home/fabio
    fi
    dc exec -T -u "$user" -e HOME="$home" -w "$home" "$svc" sh -c '
        o=$(mktemp) e=$(mktemp)
        sh -c "$1" >"$o" 2>"$e" </dev/null
        rc=$?
        cat "$e" >&2
        cat "$o"
        rm -f "$o" "$e"
        exit $rc' sh "$*"
}

# The native binary as a third machine with a throwaway HOME (output via files, as in `on`).
macuc() {
    local o e rc=0
    o=$(mktemp)
    e=$(mktemp)
    env HOME="$mac_home" UC_HOME="$mac_home/.ultracontext" CLAUDE_CONFIG_DIR="$mac_home/.claude" \
        CODEX_HOME="$mac_home/.codex" UC_TOKEN="$UC_TOKEN" UC_LOG="${UC_LOG:-debug}" \
        "$mac_uc" "$@" >"$o" 2>"$e" </dev/null || rc=$?
    cat "$e" >&2
    cat "$o"
    rm -f "$o" "$e"
    return "$rc"
}

# JSON checks without jq: compare with all whitespace removed.
json_has() { printf '%s' "$1" | tr -d ' \t\n\r' | grep -Fq -- "$2"; }

sync_ok() {
    local who=$1 out
    if [ "$who" = mac ]; then
        out=$(macuc sync --timeout 60 --json) || fail "mac: uc sync failed: $out"
    else
        out=$(on "$who" 'uc sync --timeout 60 --json') || fail "$who: uc sync failed: $out"
    fi
    json_has "$out" '"ok":true' || fail "$who: uc sync not ok: $out"
}

# eventually SECONDS DESCRIPTION COMMAND...: retry COMMAND every 0.25s.
eventually() {
    local secs=$1 what=$2 deadline
    shift 2
    deadline=$(($(date +%s) + secs))
    until "$@" >/dev/null 2>&1; do
        [ "$(date +%s)" -lt "$deadline" ] || fail "$what (not within ${secs}s)"
        sleep 0.25
    done
}

# Claude Code's project dir name: every non-alphanumeric char of the cwd becomes '-'.
claude_enc() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

claude_line() { # session cwd uuid parent_json type text
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    if [ "$5" = user ]; then
        printf '{"parentUuid":%s,"isSidechain":false,"userType":"external","cwd":"%s","sessionId":"%s","version":"2.0.27","gitBranch":"main","type":"user","message":{"role":"user","content":"%s"},"uuid":"%s","timestamp":"%s"}\n' \
            "$4" "$2" "$1" "$6" "$3" "$ts"
    else
        printf '{"parentUuid":%s,"isSidechain":false,"userType":"external","cwd":"%s","sessionId":"%s","version":"2.0.27","gitBranch":"main","message":{"id":"msg_e2e","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"%s"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}},"type":"assistant","uuid":"%s","timestamp":"%s"}\n' \
            "$4" "$2" "$1" "$6" "$3" "$ts"
    fi
}

dump_logs() {
    echo "────── docker compose logs" >&2
    dc logs --no-color --tail 200 >&2 || true
    for svc in linux1 linux2; do
        echo "────── $svc: uc status + daemon.log" >&2
        on "$svc" 'uc status --json 2>&1 | head -c 4000; echo; tail -n 200 ~/.ultracontext/logs/daemon.log 2>&1' >&2 || true
    done
    # docker cp also works when the hub container has already exited
    local f
    f=$(mktemp)
    for log in /home/uc/.ultracontext/hub/hub.log /var/log/sshd.log; do
        echo "────── hub: $log" >&2
        if dc cp "hub:$log" "$f" >/dev/null 2>&1; then tail -n 200 "$f" >&2; else echo "(none)" >&2; fi
    done
    rm -f "$f"
    if [ -n "$mac_home" ]; then
        echo "────── mac: daemon.log" >&2
        tail -n 200 "$mac_home/.ultracontext/logs/daemon.log" >&2 || true
    fi
}

cleanup() {
    local rc=$?
    set +e
    [ "$rc" -eq 0 ] || dump_logs
    if [ -n "$mac_home" ]; then
        macuc daemon stop >/dev/null 2>&1
        pid=$(cat "$mac_home/.ultracontext/daemon.pid" 2>/dev/null)
        if [ -n "$pid" ] && ps -ww -o command= -p "$pid" 2>/dev/null | grep -Fq "$mac_uc"; then
            kill -9 "$pid" 2>/dev/null
        fi
        rm -rf "$mac_home"
    fi
    if [ "$keep" -eq 1 ]; then
        echo "containers kept: docker compose -f $here/docker-compose.yml down -v" >&2
    else
        dc down -v --remove-orphans >/dev/null 2>&1
    fi
    if [ "$rc" -eq 0 ]; then echo "E2E OK"; else echo "E2E FAILED (exit $rc)" >&2; fi
    exit "$rc"
}
trap cleanup EXIT

if [ "$build" -eq 1 ]; then
    step "build image (uc from $repo)"
    dc build
fi

step "start hub + linux1 (user fabio, /home/fabio) + linux2 (root, /root)"
dc up -d
deadline=$(($(date +%s) + 60))
until dc exec -T hub test -S /home/uc/.ultracontext/hub.sock >/dev/null 2>&1; do
    [ -n "$(dc ps -q --status running hub)" ] || fail "the hub container exited (uc hub serve crashed?)"
    [ "$(date +%s)" -lt "$deadline" ] || fail "hub never listened on /home/uc/.ultracontext/hub.sock (60s)"
    sleep 0.5
done
for svc in linux1 linux2; do
    eventually 30 "$svc never got its ssh key" dc exec -T "$svc" test -s /etc/uc-e2e/id
done

step "linux1 + linux2: init over ssh; each has its own checkout of ~/Code/proj"
for svc in linux1 linux2; do
    on "$svc" 'mkdir -p ~/.claude ~/.codex ~/Code/proj' # agents installed, project cloned
done
on linux1 'printf "hello from linux1\n" > ~/Code/proj/hello.txt && printf "A=1\n" > ~/Code/proj/.env'
on linux1 'uc init uc@hub --name linux1' || fail "linux1: uc init uc@hub"
sync_ok linux1
on linux2 'uc init uc@hub --name linux2' || fail "linux2: uc init uc@hub"
sync_ok linux2
on linux2 'test ! -e ~/Code/proj/hello.txt && test ! -e ~/Code/proj/.env' ||
    fail "linux2: linux1's code reached linux2 (uc must not sync code)"

step "claude session: started on linux1 (/home/fabio), resumed on linux2 (/root)"
id=$(on linux1 'cat /proc/sys/kernel/random/uuid')
u1=$(on linux1 'cat /proc/sys/kernel/random/uuid')
u2=$(on linux1 'cat /proc/sys/kernel/random/uuid')
cwd1=/home/fabio/Code/proj
dir1="/home/fabio/.claude/projects/$(claude_enc "$cwd1")"
{
    claude_line "$id" "$cwd1" "$u1" null user "Fix the bug in $cwd1/hello.txt"
    claude_line "$id" "$cwd1" "$u2" "\"$u1\"" assistant "Reading $cwd1/hello.txt"
} | dc exec -T -u fabio linux1 sh -c "mkdir -p '$dir1' && cat > '$dir1/$id.jsonl'"
sync_ok linux1
sync_ok linux2
sessions=$(on linux2 'uc sessions --json') || fail "linux2: uc sessions: $sessions"
json_has "$sessions" "\"id\":\"$id\"" || fail "linux2: session $id not listed: $sessions"
# already where `claude --resume` looks for it, with linux2's paths
t2=$(on linux2 "cat ~/.claude/projects/$(claude_enc /root/Code/proj)/$id.jsonl") ||
    fail "linux2: transcript not materialized"
case "$t2" in *"/root/Code/proj/hello.txt"*) ;; *) fail "linux2: transcript paths not translated: $t2" ;; esac
case "$t2" in *"/home/fabio"*) fail "linux2: linux1 paths leaked: $t2" ;; esac

step "close linux1; claude continues on linux2; linux1 follows when back"
on linux1 'uc daemon stop' >/dev/null || fail "linux1: uc daemon stop"
claude_line "$id" /root/Code/proj "$(on linux2 'cat /proc/sys/kernel/random/uuid')" "\"$u2\"" user \
    "Now run /root/Code/proj/hello.txt" |
    dc exec -T linux2 sh -c "cat >> ~/.claude/projects/$(claude_enc /root/Code/proj)/$id.jsonl"
sync_ok linux2
on linux1 'uc daemon start' >/dev/null || fail "linux1: uc daemon start"
sync_ok linux1
eventually 10 "linux1: linux2's line (with linux1 paths) never arrived" \
    on linux1 "grep -Fq 'Now run /home/fabio/Code/proj/hello.txt' '$dir1/$id.jsonl'"

step "realtime: linux2 keeps working, linux1 sees it without uc sync"
claude_line "$id" /root/Code/proj "$(on linux2 'cat /proc/sys/kernel/random/uuid')" null assistant "live from linux2" |
    dc exec -T linux2 sh -c "cat >> ~/.claude/projects/$(claude_enc /root/Code/proj)/$id.jsonl"
eventually 10 "linux1: linux2's live line not pushed in real time" \
    on linux1 "grep -Fq 'live from linux2' '$dir1/$id.jsonl'"

if [ "$with_mac" -eq 1 ]; then
    step "mac: native binary joins over tcp://127.0.0.1:$UC_E2E_PORT"
    if [ ! -x "$mac_uc" ]; then
        (cd "$repo" && cargo build --bin uc)
    fi
    mac_home=$(cd "$(mktemp -d /tmp/ucmac.XXXXXX)" && pwd -P)
    mkdir -p "$mac_home/.claude" "$mac_home/.codex"
    macuc init "tcp://127.0.0.1:$UC_E2E_PORT" --name mac || fail "mac: uc init over tcp"
    sync_ok mac
    [ ! -e "$mac_home/Code" ] || fail "mac: code reached the mac (uc must not sync code)"
    tm="$mac_home/.claude/projects/$(claude_enc "$mac_home/Code/proj")/$id.jsonl"
    grep -Fq "Now run $mac_home/Code/proj/hello.txt" "$tm" || fail "mac: transcript missing or not translated ($tm)"
    if grep -Eq '/home/fabio|/root/' "$tm"; then fail "mac: linux paths leaked into $tm"; fi

    step "realtime: a new session on the mac shows up on linux1 + linux2"
    mid=$(uuidgen | tr 'A-Z' 'a-z')
    mcwd="$mac_home/Code/proj"
    mdir="$mac_home/.claude/projects/$(claude_enc "$mcwd")"
    mkdir -p "$mdir"
    claude_line "$mid" "$mcwd" "$(uuidgen | tr 'A-Z' 'a-z')" null user "hello from the mac" >"$mdir/$mid.jsonl"
    eventually 10 "linux1: the mac's new session not pushed in real time" \
        on linux1 "grep -Fq 'hello from the mac' ~/.claude/projects/$(claude_enc /home/fabio/Code/proj)/$mid.jsonl"
    eventually 10 "linux2: the mac's new session not pushed in real time" \
        on linux2 "grep -Fq 'hello from the mac' ~/.claude/projects/$(claude_enc /root/Code/proj)/$mid.jsonl"
fi
