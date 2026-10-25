#!/bin/sh
# Container roles for the uc e2e harness (driven by e2e/run.sh).
#
#   uc-e2e hub          sshd + `uc hub serve --tcp 0.0.0.0:7707` as user "uc" (UC_TOKEN required)
#   uc-e2e sshd         the hub's ssh setup without `uc hub serve` (to debug the ssh plumbing)
#   uc-e2e client USER  create USER (unless root), install the throwaway ssh key, then idle
#
# The ssh key pair is generated here, for this compose project only, in the shared /keys volume.
# Nothing touches the host's ~/.ssh.
set -eu

KEYS=/keys
CLIENT_KEY=/etc/uc-e2e/id

setup_hub_ssh() {
    id uc >/dev/null 2>&1 || useradd -m -s /bin/sh uc
    # '*' = no password but not locked ('!'), so sshd accepts public-key logins.
    usermod -p '*' uc
    mkdir -p "$KEYS"
    if [ ! -s "$KEYS/id" ]; then
        rm -f "$KEYS/id.tmp" "$KEYS/id.tmp.pub"
        ssh-keygen -q -t ed25519 -N '' -C uc-e2e -f "$KEYS/id.tmp"
        mv "$KEYS/id.tmp.pub" "$KEYS/id.pub"
        mv "$KEYS/id.tmp" "$KEYS/id"
    fi
    # Clients copy the key and tighten its permissions for their own user.
    chmod 0644 "$KEYS/id" "$KEYS/id.pub"
    install -d -m 0700 -o uc -g uc /home/uc/.ssh
    install -m 0600 -o uc -g uc "$KEYS/id.pub" /home/uc/.ssh/authorized_keys
    ssh-keygen -A >/dev/null
    /usr/sbin/sshd \
        -o PasswordAuthentication=no \
        -o KbdInteractiveAuthentication=no \
        -o PermitRootLogin=no \
        -o AllowUsers=uc \
        -E /var/log/sshd.log
}

case "${1:-}" in
hub)
    setup_hub_ssh
    : "${UC_TOKEN:?UC_TOKEN must be set for the tcp listener}"
    exec runuser -u uc -- env HOME=/home/uc UC_TOKEN="$UC_TOKEN" UC_LOG="${UC_LOG:-info}" \
        uc hub serve --tcp 0.0.0.0:7707
    ;;
sshd)
    setup_hub_ssh
    exec sleep infinity
    ;;
client)
    user=${2:-root}
    if [ "$user" != root ] && ! id "$user" >/dev/null 2>&1; then
        useradd -m -s /bin/sh "$user"
    fi
    i=0
    while [ ! -s "$KEYS/id" ]; do
        i=$((i + 1))
        if [ "$i" -gt 600 ]; then
            echo "uc-e2e: no ssh key in $KEYS after 60s (is the hub container up?)" >&2
            exit 1
        fi
        sleep 0.1
    done
    install -d -m 0755 "$(dirname "$CLIENT_KEY")"
    install -m 0600 -o "$user" "$KEYS/id" "$CLIENT_KEY"
    exec sleep infinity
    ;;
*)
    exec "$@"
    ;;
esac
