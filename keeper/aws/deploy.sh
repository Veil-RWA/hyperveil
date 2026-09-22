#!/usr/bin/env bash
#
# Deploy the HyperVeil keeper to AWS Lambda, inside the always-free tier.
#
#   cd hyperveil/keeper && bash aws/deploy.sh
#
# What it creates (idempotent — re-running updates instead of failing):
#   DynamoDB  hyperveil-keeper          5/5 provisioned (free tier: 25/25)
#   IAM       hyperveil-keeper-role     logs + that one table
#   Lambda    hyperveil-keeper-tick     the pipeline, 1 at a time, on a schedule
#   Lambda    hyperveil-keeper-intake   the app's endpoint, behind a Function URL
#   EventBridge  hyperveil-keeper-tick-schedule   rate(1 minute)
#
# Cost: Lambda's 1M requests + 400k GB-s per month and DynamoDB's 25 GB + 25
# capacity units are always free, not a 12-month trial. At one tick a minute
# (~43k invocations) this stays inside them. Secrets Manager is NOT used — it
# bills per secret per month — so the keeper's keys are Lambda environment
# variables, encrypted at rest with the AWS-managed key.
#
# Reads the same ../.env the long-running keeper uses (written by
# scripts/write-config.js), including the two private keys.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
KEEPER_DIR="$(cd -- "$HERE/.." &> /dev/null && pwd)"
ENV_FILE="${HV_ENV_FILE:-$KEEPER_DIR/.env}"

REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
TABLE="${HV_STATE_TABLE:-hyperveil-keeper}"
ROLE_NAME="${HV_ROLE_NAME:-hyperveil-keeper-role}"
TICK_FN="${HV_TICK_FUNCTION:-hyperveil-keeper-tick}"
INTAKE_FN="${HV_INTAKE_FUNCTION:-hyperveil-keeper-intake}"
RULE_NAME="${HV_RULE_NAME:-hyperveil-keeper-tick-schedule}"
SCHEDULE="${HV_SCHEDULE:-rate(1 minute)}"
TICK_TIMEOUT="${HV_TICK_TIMEOUT:-600}"
TICK_MEMORY="${HV_TICK_MEMORY:-512}"

for cmd in aws jq node zip; do
    command -v "$cmd" >/dev/null || { echo "error: '$cmd' is required" >&2; exit 1; }
done
[[ -f "$ENV_FILE" ]] || { echo "error: no $ENV_FILE — run scripts/write-config.js first" >&2; exit 1; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "account   $ACCOUNT"
echo "region    $REGION"
echo "env       $ENV_FILE"

# ── 1. State table ───────────────────────────────────────────────────────────
echo
echo "[1/6] DynamoDB $TABLE"
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
    echo "      exists"
else
    aws dynamodb create-table --region "$REGION" \
        --table-name "$TABLE" \
        --attribute-definitions AttributeName=pk,AttributeType=S \
        --key-schema AttributeName=pk,KeyType=HASH \
        --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
        --query 'TableDescription.TableStatus' --output text
    aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
    echo "      created"
fi

# ── 2. Role ──────────────────────────────────────────────────────────────────
echo
echo "[2/6] IAM $ROLE_NAME"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo "      exists"
else
    aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST" --query 'Role.Arn' --output text
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "      created; waiting for it to propagate"
    sleep 12
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name state-table \
    --policy-document "$(jq -nc --arg t "arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE" \
        '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem","dynamodb:Scan","dynamodb:Query"],Resource:$t}]}')"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
echo "      $ROLE_ARN"

# ── 3. Bundle ────────────────────────────────────────────────────────────────
echo
echo "[3/6] bundle"
(cd "$KEEPER_DIR" && node aws/build.mjs >/dev/null)
rm -f "$HERE/tick.zip" "$HERE/intake.zip"
(cd "$HERE/dist" && zip -q "$HERE/tick.zip" tick.cjs && zip -q "$HERE/intake.zip" intake.cjs)
echo "      $(du -h "$HERE/tick.zip" | cut -f1) tick, $(du -h "$HERE/intake.zip" | cut -f1) intake"

# ── 4. Environment ───────────────────────────────────────────────────────────
# The keeper's own variables, plus where its state lives. Anything not set in
# .env is simply absent, and the keeper's config.js complains by name.
ENV_JSON="$(python3 - "$ENV_FILE" "$TABLE" <<'PY'
import json, sys
wanted = {
    "HV_NETWORK", "SN_RPC_URL", "SN_KEEPER_ADDRESS", "SN_KEEPER_PRIVATE_KEY", "VEIL_POOL",
    "HV_GATEWAY", "HV_ENTRY_HELPER", "HV_EXIT_VAULT", "HV_PERMISSION_MANAGER", "SN_STRK",
    "SN_START_BLOCK", "HV_OPEN_ALLOWLIST",
    "EVM_RPC_URL", "EVM_KEEPER_PRIVATE_KEY", "HV_OMNIBUS", "EVM_START_BLOCK",
    "EVM_USDC", "HV_CORE_DEPOSIT_WALLET", "HV_CORE_DEX",
    "HV_MAX_FEE_BPS", "HV_RETURN_VALUE", "PROVER_ENDPOINT", "VEIL_MASTER_ACCOUNT_ADDRESS",
    "HL_API_URL", "IRIS_API_URL",
    "HV_MIN_NOTIONAL", "HV_MAX_RECEIPTS", "HV_MAX_REPORT_ITEMS", "HV_UNKNOWN_GRACE_MS",
    "HV_RELAY", "HV_SN_RELAY_ENDPOINT", "HV_EVM_RELAY_ENDPOINT",
}
out = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    if k in wanted and v:
        out[k] = v
out["HV_STATE_TABLE"] = sys.argv[2]
missing = [k for k in ("SN_KEEPER_PRIVATE_KEY", "EVM_KEEPER_PRIVATE_KEY") if k not in out]
if missing:
    sys.exit(f"error: {', '.join(missing)} is empty in {sys.argv[1]}")
print(json.dumps({"Variables": out}))
PY
)"

# ── 5. Functions ─────────────────────────────────────────────────────────────
publish() { # name zip handler timeout memory
    local name="$1" zip="$2" handler="$3" timeout="$4" memory="$5"
    if aws lambda get-function --function-name "$name" --region "$REGION" >/dev/null 2>&1; then
        aws lambda update-function-code --function-name "$name" --region "$REGION" \
            --zip-file "fileb://$zip" --query 'LastModified' --output text >/dev/null
        aws lambda wait function-updated --function-name "$name" --region "$REGION"
        aws lambda update-function-configuration --function-name "$name" --region "$REGION" \
            --handler "$handler" --timeout "$timeout" --memory-size "$memory" \
            --environment "$ENV_JSON" --query 'LastModified' --output text >/dev/null
    else
        aws lambda create-function --function-name "$name" --region "$REGION" \
            --runtime nodejs22.x --role "$ROLE_ARN" --handler "$handler" \
            --timeout "$timeout" --memory-size "$memory" --architectures arm64 \
            --environment "$ENV_JSON" --zip-file "fileb://$zip" \
            --query 'FunctionArn' --output text >/dev/null
    fi
    aws lambda wait function-updated --function-name "$name" --region "$REGION"
}

echo
echo "[4/6] Lambda $TICK_FN"
publish "$TICK_FN" "$HERE/tick.zip" "tick.handler" "$TICK_TIMEOUT" "$TICK_MEMORY"
# One tick at a time: two would send transactions from the same accounts.
# Best-effort — an account whose total concurrency quota is small (a new AWS
# account is often 10) refuses to reserve any. The DynamoDB lock is the real
# guard; this only stops a second invocation from starting at all.
if aws lambda put-function-concurrency --function-name "$TICK_FN" --region "$REGION" \
    --reserved-concurrent-executions 1 --output text >/dev/null 2>&1; then
    echo "      reserved concurrency 1"
else
    echo "      note: could not reserve concurrency (account quota); the DynamoDB lock still"
    echo "            keeps one tick at a time"
fi
# A tick that fails is not retried: the next schedule picks the work up anyway,
# and a retry would race the one still running.
aws lambda put-function-event-invoke-config --function-name "$TICK_FN" --region "$REGION" \
    --maximum-retry-attempts 0 --maximum-event-age-in-seconds 60 --output text >/dev/null
echo "      published (timeout ${TICK_TIMEOUT}s, ${TICK_MEMORY} MB)"

echo
echo "[5/6] Lambda $INTAKE_FN"
publish "$INTAKE_FN" "$HERE/intake.zip" "intake.handler" 30 256
# An HTTP API, not a Lambda Function URL: this account answers 403 on Function
# URLs even with auth NONE and a public resource policy (the prover's API is
# fronted the same way). Quick-create makes the integration, the $default route
# and an auto-deploying $default stage in one call; the handler answers CORS
# itself.
INTAKE_ARN="$(aws lambda get-function --function-name "$INTAKE_FN" --region "$REGION" \
    --query 'Configuration.FunctionArn' --output text)"
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
    --query "Items[?Name=='$INTAKE_FN'].ApiId | [0]" --output text)"
if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
    API_ID="$(aws apigatewayv2 create-api --name "$INTAKE_FN" --protocol-type HTTP \
        --target "$INTAKE_ARN" --region "$REGION" --query 'ApiId' --output text)"
fi
aws lambda add-permission --function-name "$INTAKE_FN" --region "$REGION" \
    --statement-id apigw-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*/*" --output text >/dev/null 2>&1 || true
INTAKE_URL="$(aws apigatewayv2 get-api --api-id "$API_ID" --region "$REGION" \
    --query 'ApiEndpoint' --output text)"
echo "      $INTAKE_URL"

# ── 6. Schedule ──────────────────────────────────────────────────────────────
echo
echo "[6/6] EventBridge $RULE_NAME ($SCHEDULE)"
aws events put-rule --name "$RULE_NAME" --region "$REGION" \
    --schedule-expression "$SCHEDULE" --query 'RuleArn' --output text >/dev/null
TICK_ARN="$(aws lambda get-function --function-name "$TICK_FN" --region "$REGION" \
    --query 'Configuration.FunctionArn' --output text)"
aws lambda add-permission --function-name "$TICK_FN" --region "$REGION" \
    --statement-id "$RULE_NAME" --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "arn:aws:events:$REGION:$ACCOUNT:rule/$RULE_NAME" --output text >/dev/null 2>&1 || true
aws events put-targets --rule "$RULE_NAME" --region "$REGION" \
    --targets "Id=tick,Arn=$TICK_ARN" --query 'FailedEntryCount' --output text

cat <<EOF

Deployed.

  intake URL   $INTAKE_URL
  tick         every minute, one at a time
  state        DynamoDB $TABLE
  logs         aws logs tail /aws/lambda/$TICK_FN --follow --region $REGION

Put the intake URL in the app's deployment.json (keeper.intake), e.g.

  (cd ../scripts && node write-config.js --intake $INTAKE_URL)

To pause the keeper without deleting anything:

  aws events disable-rule --name $RULE_NAME --region $REGION
EOF
