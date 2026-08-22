#!/usr/bin/env bash
#
# Deploys the Minicraft save API. It NEVER touches the website bucket
# gs://noah.leap-forward.ca — Julien deploys the front end himself.
#
#   ./deploy.sh            provision the bucket + deploy the function
#   ./deploy.sh --verify   assert the deployed state matches the design
#
set -euo pipefail

PROJECT="qs-trading"
REGION="us-central1"
BUCKET="minicraft-worlds"
FUNCTION="minicraft-api"

function_uri() {
	gcloud functions describe "${FUNCTION}" --project="${PROJECT}" --region="${REGION}" \
		--format="value(serviceConfig.uri)" 2>/dev/null || true
}

runtime_sa() {
	echo "$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
}

verify() {
	local failures=0

	echo "==> Verifying gs://${BUCKET}"
	if ! gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" >/dev/null 2>&1; then
		echo "FAIL: bucket does not exist"
		return 1
	fi

	local versioning
	versioning=$(gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" \
		--format="value(versioning_enabled)")
	if [[ "${versioning}" == "True" || "${versioning}" == "true" ]]; then
		echo "  ok: versioning enabled"
	else
		echo "  FAIL: versioning is '${versioning}'"
		failures=$((failures + 1))
	fi

	# One rule with BOTH conditions. Split into two rules they OR together, and a
	# deleted world's only backup would be purged at day 90.
	local rules
	rules=$(gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" \
		--format="json(lifecycle_config)")
	if echo "${rules}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
r=(d.get("lifecycle_config") or {}).get("rule") or []
assert len(r)==1, f"expected exactly 1 lifecycle rule, got {len(r)}"
c=r[0]["condition"]
assert c.get("daysSinceNoncurrentTime")==90, c
assert c.get("numNewerVersions")==10, c
' 2>/dev/null; then
		echo "  ok: one lifecycle rule with both conditions"
	else
		echo "  FAIL: lifecycle is not a single ANDed rule"
		echo "${rules}"
		failures=$((failures + 1))
	fi

	local soft
	soft=$(gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" \
		--format="value(soft_delete_policy.retentionDurationSeconds)")
	if [[ "${soft}" == "7776000" ]]; then
		echo "  ok: 90-day soft delete"
	else
		echo "  FAIL: soft-delete retention is '${soft}', expected 7776000"
		failures=$((failures + 1))
	fi

	local sa
	sa=$(runtime_sa)
	if gcloud storage buckets get-iam-policy "gs://${BUCKET}" --project="${PROJECT}" \
		--format=json | grep -q "${sa}"; then
		echo "  ok: runtime service account bound"
	else
		echo "  FAIL: ${sa} has no binding on the bucket"
		failures=$((failures + 1))
	fi

	local uri
	uri=$(function_uri)
	if [[ -z "${uri}" ]]; then
		echo "  FAIL: function ${FUNCTION} is not deployed"
		failures=$((failures + 1))
	else
		local code
		code=$(curl -s -o /dev/null -w "%{http_code}" "${uri}/health" || true)
		if [[ "${code}" == "200" ]]; then
			echo "  ok: ${uri}/health -> 200"
		else
			# gcloud reports a deploy with no build as success, so this is the
			# check that actually catches a function that cannot start.
			echo "  FAIL: ${uri}/health -> ${code}"
			failures=$((failures + 1))
		fi
	fi

	if [[ ${failures} -gt 0 ]]; then
		echo "==> ${failures} check(s) failed"
		return 1
	fi
	echo "==> All checks passed"
}

if [[ "${1:-}" == "--verify" ]]; then
	verify
	exit $?
fi

echo "==> Ensuring bucket gs://${BUCKET}"
if ! gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" >/dev/null 2>&1; then
	gcloud storage buckets create "gs://${BUCKET}" \
		--project="${PROJECT}" --location="${REGION}" --uniform-bucket-level-access
else
	echo "    already exists"
fi

echo "==> Enabling versioning and a 90-day soft-delete net"
gcloud storage buckets update "gs://${BUCKET}" --project="${PROJECT}" \
	--versioning --soft-delete-duration=90d

echo "==> Applying lifecycle (ONE rule: conditions AND together)"
LIFECYCLE=$(mktemp)
cat > "${LIFECYCLE}" <<'JSON'
{"lifecycle":{"rule":[{"action":{"type":"Delete"},
  "condition":{"daysSinceNoncurrentTime":90,"numNewerVersions":10}}]}}
JSON
gcloud storage buckets update "gs://${BUCKET}" --project="${PROJECT}" --lifecycle-file="${LIFECYCLE}"
rm -f "${LIFECYCLE}"

echo "==> Granting the runtime service account object access"
SA=$(runtime_sa)
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
	--project="${PROJECT}" --member="serviceAccount:${SA}" \
	--role=roles/storage.objectAdmin >/dev/null

echo "==> Deploying ${FUNCTION}"
gcloud functions deploy "${FUNCTION}" \
	--project="${PROJECT}" --region="${REGION}" --gen2 \
	--runtime=nodejs22 --source=api --entry-point=minicraftApi \
	--trigger-http --allow-unauthenticated \
	--memory=512Mi --timeout=60s --max-instances=3 \
	--set-env-vars="WORLDS_BUCKET=${BUCKET}"

URL=$(function_uri)
echo "==> Deployed: ${URL}"
echo
verify
echo
echo "Set this in .env.local for local dev:"
echo "  VITE_MINICRAFT_API_URL=${URL}"
