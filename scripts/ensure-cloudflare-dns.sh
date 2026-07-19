#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

zone_id="99459b7892754d4f4d3f3dea9def8ac6"
pages_host="libidopatch.pages.dev"
api="https://api.cloudflare.com/client/v4"
auth_header="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

for hostname in libidopatch.com www.libidopatch.com; do
  records=$(curl --fail-with-body --silent --show-error --get \
    --header "$auth_header" \
    --data-urlencode "name=${hostname}" \
    "${api}/zones/${zone_id}/dns_records")

  if [ "$(jq '[.result[] | select(.type == "CNAME" and .content == "libidopatch.pages.dev" and .proxied == true)] | length' <<<"$records")" -eq 1 ]; then
    echo "${hostname} already routes to ${pages_host}"
    continue
  fi

  routing_count=$(jq '[.result[] | select(.type == "A" or .type == "AAAA" or .type == "CNAME")] | length' <<<"$records")
  if [ "$routing_count" -gt 1 ]; then
    echo "Refusing to alter ${hostname}: expected at most one A/AAAA/CNAME record, found ${routing_count}" >&2
    exit 1
  fi

  payload=$(jq -cn --arg name "$hostname" --arg content "$pages_host" '{type:"CNAME",name:$name,content:$content,proxied:true,ttl:1}')
  if [ "$routing_count" -eq 1 ]; then
    record_id=$(jq -r '.result[] | select(.type == "A" or .type == "AAAA" or .type == "CNAME") | .id' <<<"$records")
    method="PUT"
    endpoint="${api}/zones/${zone_id}/dns_records/${record_id}"
  else
    method="POST"
    endpoint="${api}/zones/${zone_id}/dns_records"
  fi

  curl --fail-with-body --silent --show-error --request "$method" \
    --header "$auth_header" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    "$endpoint" >/dev/null

  echo "${hostname} now routes to ${pages_host}"
done
