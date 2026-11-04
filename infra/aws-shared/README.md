# OpenSend MX shared AWS account

## Bootstrap once

1. Sign into the **dedicated shared sending account** (not Anomaly's existing SES account). In **IAM → Users → Create user**, name it `opensend-mx`, leave console access off, and create it without groups or additional policies.
2. In **IAM → Policies → Create policy → JSON**, paste [`runtime-policy.json`](runtime-policy.json). Replace every `YOUR_AWS_ACCOUNT_ID` with this account's 12-digit ID. Leave `${aws:RequestedRegion}` and `${aws:PrincipalAccount}` unchanged: AWS resolves them per request. Name it `opensend-mx` and create it. On the user's **Permissions → Add permissions → Attach policies directly**, attach only this policy. Use a **customer-managed** policy: with the ID filled in it fits the 6,144-character limit but exceeds a user's 2,048-character inline limit. [IAM quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)
3. On **opensend-mx → Security credentials → Create access key**, select **Application running outside AWS**. Create one key, save both values securely in Deadbolt, then add them to **GitHub repository → Settings → Environments → mx → Environment secrets** as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. No session token. This is the Worker key, not a key for R2 or an administrator.
4. Scheduled preparation creates the regional sending and receiving resources. There is no per-domain receipt-rule setup on the shared account. Shared sends, including inline images and attachments, use tenant-conditioned SESv2 `SendEmail`. There is no classic raw-send or SMTP grant. [SES v2 authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html) · [classic SES authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html)

The one key can impersonate any pool tenant, read pooled mailbox objects, and reroute inbound mail. Classic receipt-rule actions cannot be scoped by name or ARN. `SetActiveReceiptRuleSet` is needed on first use **only when no set is active**; the product must preserve existing active sets. Store the key only server-side. Strict pauses individual tenants, but AWS still evaluates the account's overall reputation. [SES tenants](https://docs.aws.amazon.com/ses/latest/dg/tenants.html)

## Publish the shared receiving DNS once

`SHARED_INBOUND_DOMAIN` defaults to `in.opensend.mx`. After scheduled pool preparation, run this read-only query to get the exact wildcard MX and three DNS-only Easy DKIM CNAMEs for the production identity. Publish the returned names and values, not tokens from another region or a test account. No customer DNS is needed for workspace-slug addresses.

```sql
SELECT r.type, r.name, r.priority, r.value
FROM provider_pool_regions p, jsonb_to_recordset(p.inbound_dns) r(type text,name text,priority int,value text)
WHERE p.region='us-east-2';
```

For the default Ohio pool the MX is `*.in.opensend.mx.  MX  10  inbound-smtp.us-east-2.amazonaws.com.`. SES supplies the CNAME tokens **and signing zone**; they cannot be determined before the identity exists. A custom sending domain's optional `purpose: inbound` MX is separate from MAIL FROM and does not gate sending.

## In-product work before live traffic

- [ ] Sync the two GitHub secrets to the MX Worker in the deploy workflow; initialize/reconcile the persisted pool regions. [Ohio and Ireland both support sending and classic receiving](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_inbound_endpoints) (`inbound-smtp.us-east-2.amazonaws.com`, `inbound-smtp.eu-west-1.amazonaws.com`). Production approval, quotas, reputation and suppression are account-regional. Ohio is approved; gate Ireland on its own approval. Surface sandbox status and the [regional production-access request](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html); the Worker cannot submit it with this policy.
- [ ] Create one `opensend-…` SES tenant per workspace **per region**. Verify exclusive domain ownership, never adopt/import pooled identities into a workspace, and associate its identities and configuration sets. SES stored templates are BYO-only.
- [ ] Resolve the tenant and associated configuration set from the authenticated workspace for every simple/raw send, campaign and reply. Refuse unready/paused tenants; verify wrong or missing tenant requests fail. Do not route on caller-supplied names or tags.
- [ ] Set tenant suppression to `TENANT` for `BOUNCE` and `COMPLAINT`; remove today's configuration-set `ACCOUNT` override. Assign and verify **Strict** before enabling sends. Pass `TenantName` on suppression-list operations. [Suppression precedence](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level-configure.html)
- [ ] Attribute signed feedback and authenticated envelope recipients to the correct workspace. Implement per-tenant auto-pause from feedback, explicit operator-controlled reinstatement, and in-product alerts on tenant and regional account reputation. Admission/pacing must respect each regional account quota. Prove these paths with two workspaces before enabling customer traffic.

## Optional one-time hardening

Root MFA: register a passkey or hardware MFA device on the AWS root user; do not create root access keys.  
GuardDuty: review coverage and cost, then enable it in the pool regions if desired.
