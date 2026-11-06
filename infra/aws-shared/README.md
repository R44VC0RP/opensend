# OpenSend MX shared AWS account

**Review branch, not a deployment:** Hosted v8 and BYO v5 are drafts. The operator-reported Hosted default is v7; verify it in IAM. Never reactivate failed v6. Follow the [scope, inventory gates, staged release and rollback](iam-review.md) rather than pasting a policy from this checkout.

## Bootstrap once

1. The two pools use the existing `opensend-mx` IAM user in account `438095551154`, with no console access or groups. Self-hosted Virginia mail in the same account is **not** a Hosted resource.
2. Use the three rendered customer-managed documents and the [operator release procedure](iam-review.md#release-later--run-only-with-operator-approval); the source primary deliberately blocks all Virginia identity edits until the adopted-ARN manifest is attested. Do not attach the companions to another principal. [IAM quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)
3. On **opensend-mx → Security credentials → Create access key**, select **Application running outside AWS**. Create one key, save both values securely in Deadbolt, then add them to **GitHub repository → Settings → Environments → mx → Environment secrets** as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. No session token. This is the Worker key, not a key for R2 or an administrator.
4. Prepare sending independently in Ohio and Virginia; receiving is **Ohio only**. There is no per-domain receipt-rule setup on the shared account. Shared sends, including inline images and attachments, use tenant-conditioned SESv2 `SendEmail`. There is no classic raw-send or SMTP grant. [SES v2 authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html) · [classic SES authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html)

The one key can impersonate any pool tenant, read pooled mailbox objects, and reroute inbound mail. Classic receipt-rule actions cannot be scoped by name or ARN. On a fresh Ohio installation an operator bootstraps the reviewed active set once; the Worker cannot create, activate, swap or deactivate a set. Store the key only server-side. Strict pauses individual tenants, but AWS still evaluates the account's overall reputation. [SES tenants](https://docs.aws.amazon.com/ses/latest/dg/tenants.html)

## Publish the shared receiving DNS once

`SHARED_INBOUND_DOMAIN` defaults to `in.opensend.mx`. After scheduled pool preparation, run this read-only query to get the exact wildcard MX and three DNS-only Easy DKIM CNAMEs for the production identity. Publish the returned names and values, not tokens from another region or a test account. No customer DNS is needed for workspace-slug addresses.

```sql
SELECT r.type, r.name, r.priority, r.value
FROM provider_pool_regions p, jsonb_to_recordset(p.inbound_dns) r(type text,name text,priority int,value text)
WHERE p.region='us-east-2';
```

For the default Ohio pool the MX is `*.in.opensend.mx.  MX  10  inbound-smtp.us-east-2.amazonaws.com.`. SES supplies the CNAME tokens **and signing zone**; they cannot be determined before the identity exists. A custom sending domain's optional `purpose: inbound` MX is separate from MAIL FROM and does not gate sending.

## In-product work before live traffic

- [ ] Inventory Ireland (including delayed work) before removing its former grants. Never point Hosted receiving at Virginia. Production approval, quotas, reputation and suppression are account-regional. The Hosted user cannot submit [regional production-access requests](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
- [ ] Create one namespace- and owner-tagged tenant per workspace **per region**, retaining existing Ohio tenant names. Verify exclusive ownership; adoption is a separately attested operator step, not public import. SES stored templates are BYO-only.
- [ ] Resolve the tenant and associated configuration set from the authenticated workspace for every simple/raw send, campaign and reply. Refuse unready/paused tenants; verify wrong or missing tenant requests fail. Do not route on caller-supplied names or tags.
- [ ] Set tenant suppression to `TENANT` for `BOUNCE` and `COMPLAINT`. Assign **Strict** before enabling sends. The runtime configures tenant suppression; it cannot list or change individual suppressed destinations. [Suppression precedence](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level-configure.html)
- [ ] Attribute signed feedback and authenticated envelope recipients to the correct workspace. Implement per-tenant auto-pause from feedback, explicit operator-controlled reinstatement, and in-product alerts on tenant and regional account reputation. Admission/pacing must respect each regional account quota. Prove these paths with two workspaces before enabling customer traffic.

## Optional one-time hardening

Root MFA: register a passkey or hardware MFA device on the AWS root user; do not create root access keys.  
GuardDuty: review coverage and cost, then enable it in the pool regions if desired.
