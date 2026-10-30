#!/bin/bash
# npx and uvx for the browser machine, which has no Node.js or Python packages: each runs the
# packages the machine has a port of, which are programs in /bin, and refuses the others.
# MCP server configurations start servers as `npx -y pkg@version args` and
# `uvx pkg==version args`, so those shapes work. stdout belongs to the program; this script
# writes only to stderr.

tool=${0##*/}

# The packages each runs, as `package:program`.
case $tool in
npx) known="slivingdoc:slivingdoc @modelcontextprotocol/server-filesystem:mcp-server-filesystem" ;;
uvx) known="duckduckgo-mcp-server:duckduckgo-mcp-server" ;;
*)
  echo "launcher: run as npx or uvx, not $tool" >&2
  exit 2
  ;;
esac

from=
while [ $# -gt 0 ]; do
  case $1 in
  -y | --yes | -q | --quiet | --no-install | --offline) shift ;;
  --from)
    from=$2
    shift 2
    ;;
  --from=*)
    from=${1#--from=}
    shift
    ;;
  -p=* | --package=*)
    from=${1#*=}
    shift
    ;;
  -p | --package)
    from=$2
    shift 2
    ;;
  --)
    shift
    break
    ;;
  -*)
    echo "$tool: $1 is not supported here" >&2
    exit 2
    ;;
  *) break ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "usage: $tool [-y] package[@version] [args...]" >&2
  exit 2
fi

# With --from or --package, the first word is the command, which is the package's program.
spec=${from:-$1}
shift

# A version, as npm (`name@1.2.3`, `@scope/name@1.2.3`) and uv (`name==1.2.3`, `name@1.2.3`)
# write it, does not choose among ports: each package has one.
name=${spec%%==*}
case $name in
@*/*@*) name=${name%@*} ;;
@*) ;;
*@*) name=${name%%@*} ;;
esac
name=${name%%\[*}

for entry in $known; do
  if [ "${entry%%:*}" = "$name" ]; then
    program=/bin/${entry#*:}
    if [ ! -x "$program" ]; then
      echo "$tool: the port of $name is not in this build: $program is missing" >&2
      exit 127
    fi
    exec "$program" "$@"
  fi
done

ports=
for entry in $known; do ports="$ports ${entry%%:*}"; done
echo "$tool: $name is not available in this browser machine; it runs only ports of:$ports" >&2
exit 127
